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

# Pool used by shuffle mode — excludes "none" (shuffle implies a visible transition)
# Note: "zoomin" excluded — FFmpeg zoomin is too extreme (zooms to pixel band). Re-add when zoom is fixed.
_SHUFFLE_POOL = ["fade", "fadeblack", "wipeleft", "wipedown", "dissolve", "squeezev", "hrslice"]

XFADE_DUR = 1.5  # seconds


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
            parts.append(f"aevalsrc=0:c=stereo:d={durations[i]:.4f}:r=48000[pv{i}]")
        else:
            parts.append(f"[{i}:a]volume={vol:.4f}[pv{i}]")
    return "; ".join(parts)


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
    canvas = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2"
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
            return video_filter, v_out, ""
        pre_vol = _build_pre_volume(clip_volumes, durations, n)
        # apad=whole_dur: pad each clip's audio to its exact video duration.
        # CFR normalise produces video ~40-120ms longer than audio per clip;
        # without padding the audio concat drifts ahead of the video at every cut.
        pre_pad = "; ".join(f"[pv{i}]apad=whole_dur={durations[i]:.4f}[pa{i}]" for i in range(n))
        padded_a = "".join(f"[pa{i}]" for i in range(n))
        a_out = "[aout]"
        audio_filter = f"{pre_vol}; {pre_pad}; {padded_a}concat=n={n}:v=0:a=1{a_out}"
        return f"{video_filter}; {audio_filter}", v_out, a_out

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
            f"color=c=black:s={scale_w}x{scale_h}:d={black_dur:.4f}:r=25[sv_bopen]"
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
                f"aevalsrc=0:c=stereo:d={black_dur:.4f}:r=48000[abo]"
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
            f"color=c=black:s={scale_w}x{scale_h}:d={black_dur:.4f}:r=25[sv_bclose]"
        )
        all_parts.append(
            f"{v_after_open}[sv_bclose]"
            f"xfade=transition={close_name}:duration={xfade_dur}:offset={closing_offset:.4f}"
            f"{v_out}"
        )
        if any_audio:
            all_parts.append(
                f"aevalsrc=0:c=stereo:d={black_dur:.4f}:r=48000[abc]"
            )
            all_parts.append(
                f"{a_after_open}[abc]acrossfade=d={xfade_dur:.4f}[aout]"
            )

    if not any_audio:
        log.info("[transitions] No audio in any clip — video-only output")
        return "; ".join(all_parts), v_out, ""

    a_out = "[aout]"
    return "; ".join(all_parts), v_out, a_out
