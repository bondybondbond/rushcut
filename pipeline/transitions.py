"""
pipeline/transitions.py — Build filter_complex for xfade (video) + audio joining.

Key constraints (from CLAUDE.md + plan fixes):
- xfade transition names: "crossfade" -> transition=fade, "dip_to_black" -> transition=fadeblack
  (fadeblack is a native FFmpeg xfade transition — no custom black-fill logic needed)
- Fixed-canvas pre-scale: every input stream is scaled to an exact canvas (1920x1080 final,
  640x360 draft) with letterbox/pillarbox padding BEFORE entering concat or xfade.
  Named labels [sv0],[sv1],... applied to ALL inputs — both "none" path and xfade path.
  This prevents dimension-mismatch crashes when mixing portrait and landscape clips.
- scale=-2:{h} is NO LONGER used inside filter_complex — replaced by fixed-canvas pre-scale.
- xfade offset formula (ported verbatim from spike):
    offset = cumulative + duration[i-1] - xfade_dur * i
- Audio: pairwise chained acrossfade for ALL N>=2 clips.
         apad=whole_dur makes each clip's audio exactly durations[i] seconds, so
         acrossfade transitions align with xfade visual offsets — no hard-cut lag.
         (concat was previously used for 3+ clips but caused clip audio to start
          1.5s late at every cut after the first, accumulating each xfade_dur.)
- M2 additions:
  - "wipe" -> transition=wipeleft  (horizontal wipe left)
  - "zoom" -> transition=zoomin    (zoom-in xfade)
  - shuffle_between=True: draw a random xfade type per cut (seed from job_id for determinism)
  - opening_transition / closing_transition: prepend/append a synthetic black input
    and xfade into/out-of it. "none" = no open/close black frame.
"""

import logging
import random
from pathlib import Path

log = logging.getLogger(__name__)

# Map JobConfig.transition values to FFmpeg xfade transition names
_TRANSITION_MAP = {
    "crossfade":  "fade",
    "dip_to_black": "fadeblack",
    "wipe":       "wipeleft",
    "wipe_down":  "wipedown",
    # TODO: FFmpeg "zoomin" xfade zooms all the way into a narrow pixel band — unusable.
    # Fallback to "fade" until a proper gentle zoom is implemented via zoompan filter chain.
    "zoom":       "fade",
    "dissolve":   "dissolve",
    "barn_door":  "squeezev",
    "band_wipe":  "hrslice",
}

# Pool used by shuffle mode — excludes "none" (shuffle implies a visible transition).
# RULE: only add members that have been QA'd at 4K on real footage (3-frame extract per transition).
# QA log (2026-06-20, Stagecoach 2025 4K, V1.4 #60):
#   fade        CLEAN  -- smooth blend
#   fadeblack   CLEAN  -- dip to near-black at mid
#   wipeleft    CLEAN  -- clean horizontal wipe
#   wipedown    CLEAN  -- clean vertical wipe
#   squeezev    CLEAN  -- clean barn-door squeeze
#   hrslice     CLEAN  -- segment renders correctly; any green-screen is the #64 mixed-encoder-concat
#                         artifact (libx264/AMF boundary), not hrslice itself
#   dissolve    REMOVED -- FFmpeg noise-dither xfade; renders as literal static/snow by design.
#                          Still in _TRANSITION_MAP for explicit single-transition use.
# Do NOT add: hblur -- heavy horizontal blur on fast-motion 4K looks like corruption.
# Note: "zoomin" excluded -- FFmpeg zoomin zooms to a pixel band; too extreme. Re-add when fixed.
# SYNC: keep in sync with SHUFFLE_POOL in src/pages/Arrange.tsx (same members, different names).
_SHUFFLE_POOL = ["fade", "fadeblack", "wipeleft", "wipedown", "squeezev", "hrslice"]

XFADE_DUR = 1.5  # seconds


def resolve_cut_names(
    n: int, transition: str, shuffle_between: bool, seed: "str | None"
) -> list[str]:
    """Return n-1 FFmpeg xfade transition names, one per cut.

    Deterministic: the shuffle RNG is drawn ONCE over the global cut sequence, so
    the segmented (batched) renderer picks IDENTICAL transition names to the
    monolithic path. Slicing this list per batch keeps every cut consistent.
    """
    if shuffle_between and n > 1:
        rng = random.Random(seed)
        return [rng.choice(_SHUFFLE_POOL) for _ in range(n - 1)]
    name = _TRANSITION_MAP.get(transition, "fade")
    return [name] * max(n - 1, 0)


def clamp_xfade_dur(durations: list[float], xfade_dur: float = XFADE_DUR) -> float:
    """Clamp xfade_dur to half the shortest clip (matches build_filter_complex)."""
    if not durations:
        return xfade_dur
    return min(xfade_dur, min(durations) / 2.0)


def plan_video_batches(
    durations: list[float], batch_size: int = 4, xfade_dur: float = XFADE_DUR
) -> "tuple[list[dict], float]":
    """Plan overlap-by-one video batches for a memory-bounded segmented xfade render.

    Each consecutive batch SHARES one boundary clip; the join between segments is a
    lossless hard concat placed in the SOLO region (no active xfade) of that shared
    clip -- invisible because both sides are the same continuous footage.

    `xfade_dur` MUST already be clamped (pass clamp_xfade_dur(durations)).

    Returns (batches, total_duration). Each batch dict:
        clip_indices      [global clip indices in this batch]
        local_durations   [their durations]
        seg_start_local   batch-LOCAL time to START using this segment (0.0 for first)
        seg_end_local     batch-LOCAL time to STOP (None = encode to end, last batch)
        seg_start_global  GLOBAL output time this segment begins (for sync assertion)
        seg_end_global    GLOBAL output time this segment ends

    Raises ValueError if any shared boundary clip has no solo region (too short) --
    caller must fall back to the monolithic path and log loudly.
    """
    n = len(durations)
    prefix = [0.0]
    for d in durations:
        prefix.append(prefix[-1] + d)
    # offset[i] = output-timeline start of xfade i = prefix[i] - i*xfade_dur ; offset[0]=0
    offset = [prefix[i] - i * xfade_dur for i in range(n)]
    total = prefix[n] - (n - 1) * xfade_dur

    def solo(k: int) -> "tuple[float, float]":
        lo = (offset[k] + xfade_dur) if k > 0 else 0.0
        hi = offset[k + 1] if k < n - 1 else total
        return lo, hi

    step = batch_size - 1  # overlap-by-one
    batches_idx: list[tuple[int, int]] = []
    for s in range(0, n, step):
        e = min(s + batch_size - 1, n - 1)
        batches_idx.append((s, e))
        if e == n - 1:
            break

    plan: list[dict] = []
    for j, (s, e) in enumerate(batches_idx):
        is_first = j == 0
        is_last = e == n - 1

        # --- start boundary: shared clip s (with previous batch) ---
        if is_first:
            seg_start_global = 0.0
        else:
            lo, hi = solo(s)
            if not (lo < hi):
                raise ValueError(
                    f"boundary clip {s} has no solo region ({lo:.3f} >= {hi:.3f}) "
                    f"-- cannot place batch cut; fall back to monolithic"
                )
            seg_start_global = (lo + hi) / 2.0
            log.info(
                "[U1g] boundary cut @ clip %d solo=[%.3f,%.3f] -> cut=%.4fs (global)",
                s, lo, hi, seg_start_global,
            )

        # --- end boundary: shared clip e (with next batch) ---
        if is_last:
            seg_end_global = total
        else:
            lo, hi = solo(e)
            if not (lo < hi):
                raise ValueError(
                    f"boundary clip {e} has no solo region ({lo:.3f} >= {hi:.3f}) "
                    f"-- cannot place batch cut; fall back to monolithic"
                )
            seg_end_global = (lo + hi) / 2.0

        # Map global cut times to batch-LOCAL times.
        local_durs = durations[s : e + 1]
        lprefix = [0.0]
        for d in local_durs:
            lprefix.append(lprefix[-1] + d)

        def local_offset(k: int) -> float:
            li = k - s
            return lprefix[li] - li * xfade_dur

        # clip k frame f: global=offset[k]+f, local=local_offset(k)+f
        #   => local = global - offset[k] + local_offset(k)
        seg_start_local = seg_start_global - offset[s] + local_offset(s)
        seg_end_local = None if is_last else (seg_end_global - offset[e] + local_offset(e))

        plan.append({
            "clip_indices": list(range(s, e + 1)),
            "local_durations": local_durs,
            "seg_start_local": seg_start_local,
            "seg_end_local": seg_end_local,
            "seg_start_global": seg_start_global,
            "seg_end_global": seg_end_global,
        })
    return plan, total


def _canvas_dims(mode: str, output_resolution: str) -> "tuple[str, str]":
    scale_h = "360" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    scale_w = "640" if mode == "draft" else ("3840" if output_resolution == "4k" else "1920")
    return scale_w, scale_h


def _force_yuv420p_tail(fc: str, v_out: str) -> str:
    """Append a format=yuv420p node feeding the terminal v_out label.

    Locks the filtergraph buffersink to yuv420p so h264_amf cannot negotiate a
    yuv444p input (swscaler -129 "Could not open encoder" -> silent libx264
    fallback, issue #64). v_out is always terminal (end of the producer string),
    so rpartition rewrites only the last occurrence; rstrip guards against a
    trailing "; " producing ";;". Harmless for libx264 (it already wants yuv420p).
    """
    head, _, tail = fc.rpartition(v_out)        # tail is "" for a terminal label
    rewritten = (head + "[vpix]" + tail).rstrip("; ")
    return f"{rewritten}; [vpix]format=yuv420p{v_out}"


def build_batch_video_fc(
    durations: list[float],
    per_cut_names: list[str],
    mode: str,
    output_resolution: str,
    xfade_dur: float = XFADE_DUR,
) -> "tuple[str, str]":
    """Video-only filter_complex for ONE batch of clips (U1g segmented render).

    No audio, no opening/closing black frames. `durations` are batch-LOCAL; offsets
    use the same formula as build_filter_complex so a batch reproduces the exact
    transitions it would have in the monolithic graph. `per_cut_names` is the GLOBAL
    transition-name list sliced to this batch's cuts (len == len(durations)-1).

    Returns (fc, v_out_label).
    """
    n = len(durations)
    scale_w, scale_h = _canvas_dims(mode, output_resolution)
    # format=yuv420p pins pixel format; setparams strips prim:reserved from
    # h264_amf-encoded proxy inputs. h264_amf ignores -color_primaries bt709 and
    # always writes prim:reserved in the bitstream. format= alone doesn't touch
    # color metadata, so swscaler still sees prim:reserved and tries to negotiate
    # yuv444p for AMF → exit 127 / swscaler -129. setparams overrides the tag
    # to bt709 before xfade, so downstream AMF accepts yuv420p. See #64.
    canvas = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
        f"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    )
    v_out = "[vout]"
    parts = [f"[{i}:v]{canvas}[sv{i}]" for i in range(n)]
    if n == 1:
        parts.append(f"[sv0]null{v_out}")
        return _force_yuv420p_tail("; ".join(parts), v_out), v_out
    prev = "[sv0]"
    cumulative = 0.0
    for i in range(1, n):
        offset = cumulative + durations[i - 1] - xfade_dur * i
        out_label = v_out if i == n - 1 else f"[v{i:02d}]"
        parts.append(
            f"{prev}[sv{i}]"
            f"xfade=transition={per_cut_names[i - 1]}:duration={xfade_dur}:offset={offset:.4f}"
            f"{out_label}"
        )
        prev = out_label
        cumulative += durations[i - 1]
    return _force_yuv420p_tail("; ".join(parts), v_out), v_out


def build_audio_only_fc(
    durations: list[float],
    audio_flags: list[bool],
    clip_volumes: "list[float] | None",
    xfade_dur: float = XFADE_DUR,
    loudnorm_str: "str | None" = None,
) -> "tuple[str, str]":
    """Audio-only filter_complex over ALL clips (U1g single-pass audio).

    per-clip volume -> apad=whole_dur -> chained acrossfade, identical to the audio
    branch of build_filter_complex (no opening/closing -- the batched path is only
    used when there is no open/close transition). Optional loudnorm fused on the tail.

    Returns (fc, a_out_label) or ("", "") when no clip has audio.
    """
    n = len(durations)
    if not any(audio_flags):
        return "", ""
    pre_vol = _build_pre_volume(clip_volumes, durations, n)
    pre_pad = "; ".join(
        f"[pv{i}]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n)
    )
    if n == 1:
        body = f"{pre_vol}; {pre_pad}; [pa0]anull[aout]"
    else:
        chain: list[str] = []
        prev_a = "[pa0]"
        for i in range(1, n):
            a_lbl = "[aout]" if i == n - 1 else f"[ac{i}]"
            chain.append(f"{prev_a}[pa{i}]acrossfade=d={xfade_dur:.4f}{a_lbl}")
            prev_a = a_lbl
        body = f"{pre_vol}; {pre_pad}; " + "; ".join(chain)
    a_out = "[aout]"
    if loudnorm_str:
        body += f"; [aout]{loudnorm_str}[aloud]"
        a_out = "[aloud]"
    return body, a_out


def _build_pre_volume(
    clip_volumes: list[float] | None,
    durations: list[float],
    n: int,
) -> str:
    """Build the per-clip pre-volume filter stage: [{i}:a] -> [pv{i}].

    Applied BEFORE apad so the volume multiplier never disturbs the
    apad/acrossfade alignment fixed in Batch 14-P.

    - clip_volume > 0: `[{i}:a]volume={v}[pv{i}]`
    - clip_volume <= 0 (muted): substitute `aevalsrc` silence of the exact
      clip duration so the filter graph stays valid (mirrors the no-audio
      silence-injection pattern in render.py).
    """
    parts: list[str] = []
    for i in range(n):
        vol = clip_volumes[i] if clip_volumes else 1.0
        if vol <= 0.0:
            parts.append(f"aevalsrc=0:c=stereo:d={durations[i]:.4f}:s=48000[pv{i}]")
        else:
            parts.append(f"[{i}:a]volume={vol:.4f}[pv{i}]")
    return "; ".join(parts)


def build_open_close_post_fc(
    inner_duration: float,
    has_audio: bool,
    scale_w: str,
    scale_h: str,
    target_fps_raw: str,
    opening_transition: str = "none",
    closing_transition: str = "none",
    xfade_dur: float = XFADE_DUR,
    clip_tbn_str: str = "1/30000",
) -> "tuple[str, str, str]":
    """Wrap a single pre-rendered inner clip with open/close-to-black xfade.

    Used by the U1g segmented post-pass (issue #31): the segmented path renders
    the inner content (all clips) to one intermediate file, then this graph fades
    it in from / out to black in a single memory-light pass instead of forcing the
    whole project onto the exit-15-prone monolithic graph.

    The inner clip is FFmpeg input index 0 ([0:v] / [0:a]); black/silence are
    inline color/aevalsrc sources (no extra -i). Mirrors the open/close branch of
    build_filter_complex but operates on ONE pre-encoded input instead of N clips.
    Use the SAME xfade/acrossfade construction -- NOT FFmpeg's fade/afade filter.

    No loudnorm here: loudnorm is already fused into the inner audio pass.

    Returns (fc, v_out_label, a_out_label). a_out is "" when has_audio is False.
    """
    has_open = opening_transition != "none"
    has_close = closing_transition != "none"
    if not has_open and not has_close:
        raise ValueError("build_open_close_post_fc called with no open/close transition")

    # +0.1s buffer for black-frame sources: xfade offset must be < input duration.
    black_dur = xfade_dur + 0.1
    # format=yuv420p,setsar=1 on the black source so it matches the decoded inner
    # stream exactly (xfade rejects mismatched pixel format / SAR). Defensive vs the
    # monolithic graph where every input shares the in-graph canvas filter.
    black = (
        f"color=c=black:s={scale_w}x{scale_h}:d={black_dur:.4f}:r={target_fps_raw},"
        f"format=yuv420p,setsar=1,settb={clip_tbn_str}"
    )
    parts: list[str] = []
    v_inner = "[0:v]"
    a_inner = "[0:a]"

    # --- Opening xfade: black -> inner ---
    v_after_open = "[vwrap]" if has_close else "[vout]"
    a_after_open = "[awrap]" if has_close else "[aout]"
    total_after_open = inner_duration
    if has_open:
        open_name = _TRANSITION_MAP.get(opening_transition, "fade")
        parts.append(f"{black}[sv_bopen]")
        parts.append(
            f"[sv_bopen]{v_inner}"
            f"xfade=transition={open_name}:duration={xfade_dur:.4f}:offset=0"
            f"{v_after_open}"
        )
        total_after_open = inner_duration + 0.1  # black_dur - xfade_dur
        if has_audio:
            parts.append(f"aevalsrc=0:c=stereo:d={black_dur:.4f}:s=48000[abo]")
            parts.append(f"[abo]{a_inner}acrossfade=d={xfade_dur:.4f}{a_after_open}")
    else:
        v_after_open = v_inner
        a_after_open = a_inner

    # --- Closing xfade: content -> black ---
    if has_close:
        close_name = _TRANSITION_MAP.get(closing_transition, "fade")
        closing_offset = total_after_open - xfade_dur
        parts.append(f"{black}[sv_bclose]")
        parts.append(
            f"{v_after_open}[sv_bclose]"
            f"xfade=transition={close_name}:duration={xfade_dur:.4f}:offset={closing_offset:.4f}"
            f"[vout]"
        )
        if has_audio:
            parts.append(f"aevalsrc=0:c=stereo:d={black_dur:.4f}:s=48000[abc]")
            parts.append(f"{a_after_open}[abc]acrossfade=d={xfade_dur:.4f}[aout]")

    a_out = "[aout]" if has_audio else ""
    return _force_yuv420p_tail("; ".join(parts), "[vout]"), "[vout]", a_out


def build_filter_complex(
    clip_paths: list[Path],
    durations: list[float],
    audio_flags: list[bool],
    transition: str = "crossfade",
    mode: str = "draft",
    xfade_dur: float = XFADE_DUR,
    output_resolution: str = "1080p",
    clip_volumes: list[float] | None = None,
    shuffle_between: bool = False,
    seed: str | None = None,
    opening_transition: str = "none",
    closing_transition: str = "none",
    target_fps_raw: str = "30000/1001",
    clip_tbn_str: str = "1/30000",
) -> tuple[str, str, str]:
    """
    Build filter_complex string for N clips with xfade transitions.

    Args:
        clip_paths:          Ordered list of clip Paths (used only for count).
        durations:           Duration in seconds for each clip (MUST be post-trim durations).
        audio_flags:         Whether each clip has audio (all True after inject_silence_where_needed).
        transition:          "crossfade" | "dip_to_black" | "wipe" | "zoom" | "none"
        mode:                "draft" (360p) | "final" (1080p)
        xfade_dur:           Crossfade duration in seconds.
        shuffle_between:     If True, pick a random transition per cut from _SHUFFLE_POOL.
                             The `transition` arg is ignored when this is True.
        seed:                Job ID string used to seed the RNG for deterministic shuffle
                             re-renders. Unused when shuffle_between is False.
        opening_transition:  Transition to apply from a synthetic black frame into clip 0.
                             "none" = skip (default). Uses same xfade_dur.
        closing_transition:  Transition to apply from the last clip out to a synthetic black
                             frame. "none" = skip (default). Uses same xfade_dur.

    Returns:
        (filter_complex_str, video_out_label, audio_out_label)
        audio_out_label is "" if no clips have audio.

    Note on caller contract for opening/closing:
        When opening_transition != "none", the caller (render.py) must prepend a synthetic
        black video input BEFORE all clip inputs. Index 0 = black, clips start at index 1.
        When closing_transition != "none", the caller appends a black input AFTER all clips.
        This function assumes those extra inputs are already present in the FFmpeg command.
    """
    n = len(clip_paths)
    has_open = opening_transition != "none"
    has_close = closing_transition != "none"

    # scale_w/scale_h define the fixed canvas for ALL clips (portrait+landscape mixing).
    # Must use exact WxH — NOT scale=-2:h — so all inputs are the same size before concat/xfade.
    # 3840x2160 for 4K UHD (DJI Osmo Pocket 3); force_original_aspect_ratio=decrease + pad handles
    # portrait clips correctly without hardcoding aspect ratio assumptions.
    scale_h = "360" if mode == "draft" else ("2160" if output_resolution == "4k" else "1080")
    scale_w = "640" if mode == "draft" else ("3840" if output_resolution == "4k" else "1920")

    # Fixed-canvas filter applied to every input stream before concat or xfade.
    # Scales to fit inside canvas (preserving AR), then pads remainder black.
    # Prevents FFmpeg dimension-mismatch crash when portrait and landscape clips
    # are mixed in the same project (e.g. 540x1080 vs 1920x1080).
    # format=yuv420p pins pixel format; setparams strips prim:reserved from
    # h264_amf-encoded proxy inputs. h264_amf ignores -color_primaries bt709 and
    # always writes prim:reserved in the bitstream. format= alone doesn't touch
    # color metadata, so swscaler still sees prim:reserved and tries to negotiate
    # yuv444p for AMF → exit 127 / swscaler -129. setparams overrides the tag
    # to bt709 before xfade, so downstream AMF accepts yuv420p. See #64.
    canvas = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
        f"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    )

    v_out = "[vout]"

    # --- Clamp xfade_dur (applies to between-clip and open/close transitions) ---
    if transition != "none" or has_open or has_close:
        min_dur = min(durations)
        effective_dur = min(xfade_dur, min_dur / 2.0)
        if effective_dur < xfade_dur:
            log.warning(
                "[transitions] xfade_dur clamped %.3fs -> %.3fs (shortest clip=%.3fs)",
                xfade_dur, effective_dur, min_dur,
            )
        xfade_dur = effective_dur

    # +0.1s buffer for black-frame sources: xfade offset must be < input duration.
    black_dur = xfade_dur + 0.1

    # --- Build per-cut xfade names for between-clips (M2: shuffle support) ---
    if shuffle_between and n > 1:
        rng = random.Random(seed)
        per_cut_names: list[str] = []
        for i in range(n - 1):
            name = rng.choice(_SHUFFLE_POOL)
            log.info("[M2] cut %d: %s", i + 1, name)
            per_cut_names.append(name)
    else:
        xfade_name = _TRANSITION_MAP.get(transition, "fade")
        per_cut_names = [xfade_name] * max(n - 1, 0)

    # -----------------------------------------------------------------------
    # FAST PATH: "none" between-clips, no opening, no closing — pure concat
    # -----------------------------------------------------------------------
    if transition == "none" and not shuffle_between and not has_open and not has_close:
        any_audio = any(audio_flags)
        pre_scale = "; ".join(f"[{i}:v]{canvas}[sv{i}]" for i in range(n))
        scaled_inputs = "".join(f"[sv{i}]" for i in range(n))
        video_filter = f"{pre_scale}; {scaled_inputs}concat=n={n}:v=1:a=0{v_out}"
        if not any_audio:
            return _force_yuv420p_tail(video_filter, v_out), v_out, ""
        pre_vol = _build_pre_volume(clip_volumes, durations, n)
        # apad=whole_dur: pad each clip's audio to its exact video duration.
        # CFR normalise produces video ~40-120ms longer than audio per clip;
        # without padding the audio concat drifts ahead of the video at every cut.
        pre_pad = "; ".join(f"[pv{i}]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n))
        padded_a = "".join(f"[pa{i}]" for i in range(n))
        a_out = "[aout]"
        audio_filter = f"{pre_vol}; {pre_pad}; {padded_a}concat=n={n}:v=0:a=1{a_out}"
        return _force_yuv420p_tail(f"{video_filter}; {audio_filter}", v_out), v_out, a_out

    # -----------------------------------------------------------------------
    # GENERAL PATH: builds [vinner] / [ainner] then wraps with open/close xfade
    # -----------------------------------------------------------------------
    all_parts: list[str] = []
    any_audio = any(audio_flags)

    # Pre-scale every clip input to fixed canvas — [sv0],[sv1],...
    for i in range(n):
        all_parts.append(f"[{i}:v]{canvas}[sv{i}]")

    # --- Between-clips video ---
    # Label for the output of the between-clip stage.
    # If open/close are also needed we use [vinner]; else wire straight to [vout].
    use_inner = has_open or has_close
    v_inner = "[vinner]" if use_inner else v_out

    if transition == "none" and not shuffle_between:
        # Concat (hard cuts) between clips → [vinner]
        scaled_inputs = "".join(f"[sv{i}]" for i in range(n))
        all_parts.append(f"{scaled_inputs}concat=n={n}:v=1:a=0{v_inner}")
        total_between = sum(durations)
    elif n == 1:
        # Single clip — no between-clips xfade; just rename [sv0] → [vinner]
        all_parts.append(f"[sv0]null{v_inner}")
        total_between = durations[0]
    else:
        # Pairwise xfade chain between clips → [vinner]
        prev_label = "[sv0]"
        cumulative = 0.0
        for i in range(1, n):
            cut_name = per_cut_names[i - 1]
            offset = cumulative + durations[i - 1] - xfade_dur * i
            log.info(
                "[transitions] xfade offset[%d] = %.4fs  "
                "(cumulative=%.4fs - %.4fs)",
                i, offset, cumulative + durations[i - 1], xfade_dur * i,
            )
            # Last xfade in the between-clip chain
            out_label = v_inner if i == n - 1 else f"[v{i:02d}]"
            all_parts.append(
                f"{prev_label}[sv{i}]"
                f"xfade=transition={cut_name}:duration={xfade_dur}:offset={offset:.4f}"
                f"{out_label}"
            )
            prev_label = out_label
            cumulative += durations[i - 1]
        total_between = sum(durations) - (n - 1) * xfade_dur

    # --- Between-clips audio ---
    a_inner = "[ainner]" if use_inner else "[aout]"
    if any_audio:
        pre_vol = _build_pre_volume(clip_volumes, durations, n)
        pre_pad = "; ".join(
            f"[pv{i}]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n)
        )
        if n == 1:
            all_parts.append(f"{pre_vol}; {pre_pad}")
            # Single clip: [pa0] → [ainner] via anull (passthrough rename)
            all_parts.append(f"[pa0]anull{a_inner}")
        else:
            chain: list[str] = []
            prev_a = "[pa0]"
            for i in range(1, n):
                # Use uniform xfade_dur for audio acrossfade regardless of which video
                # xfade type was chosen (audio crossfade is always a dissolve).
                a_lbl = a_inner if i == n - 1 else f"[ac{i}]"
                chain.append(f"{prev_a}[pa{i}]acrossfade=d={xfade_dur:.4f}{a_lbl}")
                prev_a = a_lbl
            all_parts.append(f"{pre_vol}; {pre_pad}; " + "; ".join(chain))

    # --- Opening xfade: inline black source → [vinner] → [vwrap] ---
    v_after_open = "[vwrap]" if has_close else v_out
    if has_open:
        open_name = _TRANSITION_MAP.get(opening_transition, "fade")
        # Inline color source for black opening frame (no extra -i input needed).
        # +0.1s buffer: xfade offset must be < input duration.
        all_parts.append(
            f"color=c=black:s={scale_w}x{scale_h}:d={black_dur:.4f}:r={target_fps_raw},settb={clip_tbn_str}[sv_bopen]"
        )
        all_parts.append(
            f"[sv_bopen]{v_inner}"
            f"xfade=transition={open_name}:duration={xfade_dur}:offset=0"
            f"{v_after_open}"
        )
        total_after_open = total_between + 0.1  # black_dur - xfade_dur = 0.1
        if any_audio:
            # Inline silence for opening black frame audio
            a_after_open = "[awrap]" if has_close else "[aout]"
            all_parts.append(
                f"aevalsrc=0:c=stereo:d={black_dur:.4f}:s=48000[abo]"
            )
            all_parts.append(
                f"[abo]{a_inner}acrossfade=d={xfade_dur:.4f}{a_after_open}"
            )
    else:
        total_after_open = total_between
        v_after_open = v_inner
        a_after_open = a_inner

    # --- Closing xfade: [v_after_open] → inline black source → [vout] ---
    if has_close:
        close_name = _TRANSITION_MAP.get(closing_transition, "fade")
        # Closing xfade starts xfade_dur before the end of the content stream.
        # +0.1s buffer: xfade offset must be < input duration.
        closing_offset = total_after_open - xfade_dur
        all_parts.append(
            f"color=c=black:s={scale_w}x{scale_h}:d={black_dur:.4f}:r={target_fps_raw},settb={clip_tbn_str}[sv_bclose]"
        )
        all_parts.append(
            f"{v_after_open}[sv_bclose]"
            f"xfade=transition={close_name}:duration={xfade_dur}:offset={closing_offset:.4f}"
            f"{v_out}"
        )
        if any_audio:
            all_parts.append(
                f"aevalsrc=0:c=stereo:d={black_dur:.4f}:s=48000[abc]"
            )
            all_parts.append(
                f"{a_after_open}[abc]acrossfade=d={xfade_dur:.4f}[aout]"
            )

    if not any_audio:
        log.info("[transitions] No audio in any clip — video-only output")
        return _force_yuv420p_tail("; ".join(all_parts), v_out), v_out, ""

    a_out = "[aout]"
    return _force_yuv420p_tail("; ".join(all_parts), v_out), v_out, a_out
