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
- Transition length is PER CUT (#284, resolve_cuts): XFADE_DUR, shortened only beside a short
  element; below FADE_FLOOR_FRAMES the cut is a real hard cut (concat), never a 0 s xfade.
  offset[i] = sum(duration[0..i-1]) - sum(cut[0..i-1]); cut[i-1] is the cut INTO element i.
- Audio: pairwise chained acrossfade for ALL N>=2 clips (concat at a hard cut).
         apad=whole_dur makes each clip's audio exactly durations[i] seconds, so
         acrossfade transitions align with xfade visual offsets — no hard-cut lag.
         (concat was previously used for 3+ clips but caused clip audio to start
          1.5s late at every cut after the first, accumulating each xfade_dur.)
- M2 additions:
  - "wipe" -> transition=wipeleft  (horizontal wipe left)
  - "zoom" -> transition=zoomin    (zoom-in xfade)
  - shuffle_between=True: draw a random xfade type per cut (seed from the render
    cache's stable signature, not job_id, so identical clip-set+settings reproduce
    the same shuffle order across renders and can hit the render cache -- #83)
  - opening_transition / closing_transition: prepend/append a synthetic black input
    and xfade into/out-of it. "none" = no open/close black frame.
"""

import logging
import math
import random
from dataclasses import dataclass
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
# Do NOT add: hblur -- heavy horizontal blur on fast-motion 4K looks like corruption.
# "dissolve" REMOVED ENTIRELY (#195, 2026-09-05) -- FFmpeg's dissolve xfade is a per-pixel
# noise-dither hard-select (never a blend), renders as literal static/snow by design, not a
# bug. A throwaway additive/screen-blend custom-xfade prototype was built and judged against
# real footage; user preferred plain Crossfade. No longer in _TRANSITION_MAP -- do not re-add
# without a new product decision.
# Note: "zoomin" excluded -- FFmpeg zoomin zooms to a pixel band; too extreme. Re-add when fixed.
# SYNC: keep in sync with SHUFFLE_POOL in src/pages/Arrange.tsx (same members, different names).
_SHUFFLE_POOL = ["fade", "fadeblack", "wipeleft", "wipedown", "squeezev", "hrslice"]

XFADE_DUR = 1.5  # seconds -- the longest any single cut can be


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


KEEP_OWN_S = 1.5       # #284 (owner 2026-11-24): every element keeps min(1.5 s, half itself) un-faded
FADE_FLOOR_FRAMES = 6  # #284: a fade shorter than this (output frames) becomes a hard cut
CARD_VISIBLE_S = 1.5   # fully-visible time every card keeps between its crossfades (#190, owner 2026-11-17)
CARD_PLAIN_S = 3.0     # card length when no between-clips transition is active


@dataclass(frozen=True)
class CutPlan:
    """Transition length in seconds of every cut of one film; 0.0 = hard cut / no fade."""
    open_s: float
    between_s: "list[float]"  # len == element count - 1; between_s[i] joins element i and i+1
    close_s: float


def resolve_cuts(
    lengths: "list[float | None]", between_on: bool, open_on: bool, close_on: bool, fps: float
) -> CutPlan:
    """#284: the ONE place transition lengths are decided. SYNC: filmDuration.ts resolveCuts(),
    both held to pipeline/fixtures/cut_cases.json.

    `lengths` = seconds of every element (clips and cards) in film order. None = a card whose
    length is derived FROM its cuts (card_duration_s), so it never limits them.

    Rule: an element keeps min(KEEP_OWN_S, half itself) of its own; the rest is split equally
    over the sides that fade (a neighbour, or the film's opening/closing fade). A cut takes the
    smaller of what its two elements allow, at most XFADE_DUR. Shortened cuts are planned in
    whole output frames; under FADE_FLOOR_FRAMES they become 0 (hard cut).
    """
    n = len(lengths)
    if n == 0:
        return CutPlan(0.0, [], 0.0)
    full_frames = XFADE_DUR * fps
    keep_frames = math.ceil(KEEP_OWN_S * fps - 1e-9)

    def side_limit(i: int) -> "int | None":
        """Frames element i allows on each of its fading sides; None = no limit."""
        d = lengths[i]
        if d is None:
            return None
        sides = int(open_on if i == 0 else between_on) + int(close_on if i == n - 1 else between_on)
        # Long enough for full-length fades on every side (half a frame of tolerance).
        if sides == 0 or d + 0.5 / fps >= KEEP_OWN_S + sides * XFADE_DUR:
            return None
        frames = math.floor(d * fps + 0.5)
        keep = min(keep_frames, (frames + 1) // 2)
        return max(frames - keep, 0) // sides

    def cut(*elements: int) -> float:
        limits = [v for v in (side_limit(i) for i in elements) if v is not None]
        if not limits or min(limits) >= full_frames:
            return XFADE_DUR
        frames = min(limits)
        return frames / fps if frames >= FADE_FLOOR_FRAMES else 0.0

    return CutPlan(
        open_s=cut(0) if open_on else 0.0,
        between_s=[cut(i, i + 1) if between_on else 0.0 for i in range(n - 1)],
        close_s=cut(n - 1) if close_on else 0.0,
    )


def card_duration_s(cuts: "CutPlan | None", element_index: int, between_on: bool) -> float:
    """Card length = CARD_VISIBLE_S + its own two cuts (#190/#284); CARD_PLAIN_S when no
    between-clips transition is active (then `cuts` is not needed).
    SYNC: src/utils/filmDuration.ts cardDurMs()."""
    if not between_on or cuts is None:
        return CARD_PLAIN_S
    left = cuts.open_s if element_index == 0 else cuts.between_s[element_index - 1]
    right = cuts.close_s if element_index == len(cuts.between_s) else cuts.between_s[element_index]
    return CARD_VISIBLE_S + left + right


def plan_video_batches(
    durations: list[float], cuts: list[float], batch_size: int = 4
) -> "tuple[list[dict], float]":
    """Plan overlap-by-one video batches for a memory-bounded segmented xfade render.

    Each consecutive batch SHARES one boundary clip; the join between segments is a
    lossless hard concat placed in the SOLO region (no active xfade) of that shared
    clip -- invisible because both sides are the same continuous footage.

    `cuts` = the between-element lengths from resolve_cuts() (len == len(durations) - 1).

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
    # offset[i] = output-timeline start of element i (where its incoming cut begins); offset[0]=0
    offset = [prefix[i] - sum(cuts[:i]) for i in range(n)]
    total = prefix[n] - sum(cuts[: n - 1])

    def solo(k: int) -> "tuple[float, float]":
        lo = (offset[k] + cuts[k - 1]) if k > 0 else 0.0
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
            return lprefix[li] - sum(cuts[s:k])

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


def _video_join(prev: str, nxt: str, out: str, name: str, dur: float, offset: float,
                fps_raw: str, tbn: str) -> str:
    """One cut: xfade of `dur` seconds, or a real hard cut when dur is 0 (#284). concat does
    not keep a frame rate or timebase, which a following xfade requires -- pin both."""
    if dur > 0:
        return f"{prev}{nxt}xfade=transition={name}:duration={dur:.4f}:offset={offset:.4f}{out}"
    return f"{prev}{nxt}concat=n=2:v=1:a=0,fps={fps_raw},settb={tbn}{out}"


def _audio_join(prev: str, nxt: str, out: str, dur: float) -> str:
    if dur > 0:
        return f"{prev}{nxt}acrossfade=d={dur:.4f}{out}"
    return f"{prev}{nxt}concat=n=2:v=0:a=1{out}"


def _sv_node(
    i: int,
    canvas: str,
    zoom_vfs: "list[str | None] | None",
    clip_tbn_str: "str | None" = None,
) -> str:
    """Per-clip pre-scale node `[{i}:v]...[sv{i}]`.

    When a zoom vf is supplied for this clip (embed-zoom path, issue #67), it is
    prepended BEFORE the fixed canvas: the zoom (kenburns scale=eval=frame,crop or
    static crop+scale) outputs source dims, the canvas scale-fit is then identity,
    and the trailing format/setparams still normalise colour for downstream AMF.

    #136/#137: when clip_tbn_str is given, a trailing settb=clip_tbn_str pins the
    output timebase explicitly. Without it, a zoomed clip's scale=eval=frame,crop
    chain can renegotiate the stream timebase to a generic 1/1000000 instead of
    preserving the container's 1/30000 -- invisible for hard cuts (concat doesn't
    check timebase) but fatal when that output is later fed into a SECOND xfade
    layer (the open/close-to-black wrap around the between-clips result), which
    rejects mismatched input timebases (exit 234, same class as the existing
    color-source settb rule below). Confirmed via real render: single-clip zoom +
    open/close failed with "First input link main timebase (1/30000) do not match
    the corresponding second input link xfade timebase (1/1000000)" until this was
    added -- and the SAME failure reproduced on a 2-clip zoom + open/close project.

    #138 (verified 2026-07-21): build_batch_video_fc's U1g caller (below) does NOT
    need this fix and stays opt-in (None = no settb). Live-tested with a real
    8-clip/3-batch render, zoom (including genuine kb_in_* dynamic Ken Burns, not
    just static "medium") present in every batch, feeding directly into xfade
    against non-zoomed clips -- exit 0, drift=0, no crash. Root cause: #137's crash
    requires a zoom/xfade chain's output to be handed to a SECOND xfade layer (the
    open/close wrap); build_batch_video_fc's per-batch chain is a single flat
    xfade sequence with no such wrap -- U1g's open/close is handled entirely
    separately via build_open_close_post_fc()/_boundary_reencode(), which already
    has clip_tbn_str wired. The per-batch chain is structurally identical to
    build_filter_complex()'s OWN safe between-clips xfade branch (the `else:`
    pairwise-xfade case above the settb-on-v_inner line) -- that branch never
    crashed either; only wrapping its output in a further xfade did.
    """
    z = zoom_vfs[i] if (zoom_vfs and i < len(zoom_vfs) and zoom_vfs[i]) else None
    pre = f"{z}," if z else ""
    tb = f",settb={clip_tbn_str}" if clip_tbn_str else ""
    return f"[{i}:v]{pre}{canvas}{tb}[sv{i}]"


def build_batch_video_fc(
    durations: list[float],
    per_cut_names: list[str],
    mode: str,
    output_resolution: str,
    cuts: list[float],
    zoom_vfs: "list[str | None] | None" = None,
    target_fps_raw: str = "30000/1001",
    clip_tbn_str: str = "1/30000",
) -> "tuple[str, str]":
    """Video-only filter_complex for ONE batch of clips (U1g segmented render).

    No audio, no opening/closing black frames. `durations` are batch-LOCAL; offsets
    use the same formula as build_filter_complex so a batch reproduces the exact
    transitions it would have in the monolithic graph. `per_cut_names` and `cuts` are the
    GLOBAL lists sliced to this batch's cuts (len == len(durations)-1). The timebase is
    pinned on the inputs only when the batch has a hard cut (see _video_join).

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
    # #138 (verified 2026-07-21): a batch of crossfades needs no timebase pin -- the #137
    # exit-234 bug needs a zoom/xfade chain's output wrapped in a SECOND xfade layer
    # (open/close), handled separately here by build_open_close_post_fc(). #284: a batch
    # with a HARD cut joins with concat, whose timebase must be pinned back before the next
    # xfade, so only then are the inputs pinned to the same value (see _video_join).
    sv_tbn = clip_tbn_str if any(c <= 0 for c in cuts) else None
    parts = [_sv_node(i, canvas, zoom_vfs, sv_tbn) for i in range(n)]
    if n == 1:
        parts.append(f"[sv0]null{v_out}")
        return _force_yuv420p_tail("; ".join(parts), v_out), v_out
    prev = "[sv0]"
    cumulative = 0.0
    for i in range(1, n):
        offset = cumulative + durations[i - 1] - sum(cuts[:i])
        out_label = v_out if i == n - 1 else f"[v{i:02d}]"
        parts.append(_video_join(prev, f"[sv{i}]", out_label, per_cut_names[i - 1],
                                 cuts[i - 1], offset, target_fps_raw, clip_tbn_str))
        prev = out_label
        cumulative += durations[i - 1]
    return _force_yuv420p_tail("; ".join(parts), v_out), v_out


def build_audio_only_fc(
    durations: list[float],
    audio_flags: list[bool],
    clip_volumes: "list[float] | None",
    cuts: list[float],
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
            chain.append(_audio_join(prev_a, f"[pa{i}]", a_lbl, cuts[i - 1]))
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
    open_dur: float = XFADE_DUR,
    close_dur: float = XFADE_DUR,
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
    has_open = opening_transition != "none" and open_dur > 0
    has_close = closing_transition != "none" and close_dur > 0
    if not has_open and not has_close:
        raise ValueError("build_open_close_post_fc called with no open/close transition")

    # +0.1s buffer for black-frame sources: xfade offset must be < input duration.
    open_black = open_dur + 0.1
    close_black = close_dur + 0.1

    # format=yuv420p,setsar=1 on the black source so it matches the decoded inner
    # stream exactly (xfade rejects mismatched pixel format / SAR). Defensive vs the
    # monolithic graph where every input shares the in-graph canvas filter.
    def black(d: float) -> str:
        return (
            f"color=c=black:s={scale_w}x{scale_h}:d={d:.4f}:r={target_fps_raw},"
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
        parts.append(f"{black(open_black)}[sv_bopen]")
        parts.append(
            f"[sv_bopen]{v_inner}"
            f"xfade=transition={open_name}:duration={open_dur:.4f}:offset=0"
            f"{v_after_open}"
        )
        total_after_open = inner_duration + 0.1  # open_black - open_dur
        if has_audio:
            parts.append(f"aevalsrc=0:c=stereo:d={open_black:.4f}:s=48000[abo]")
            parts.append(f"[abo]{a_inner}acrossfade=d={open_dur:.4f}{a_after_open}")
    else:
        v_after_open = v_inner
        a_after_open = a_inner

    # --- Closing xfade: content -> black ---
    if has_close:
        close_name = _TRANSITION_MAP.get(closing_transition, "fade")
        closing_offset = total_after_open - close_dur
        parts.append(f"{black(close_black)}[sv_bclose]")
        parts.append(
            f"{v_after_open}[sv_bclose]"
            f"xfade=transition={close_name}:duration={close_dur:.4f}:offset={closing_offset:.4f}"
            f"[vout]"
        )
        if has_audio:
            parts.append(f"aevalsrc=0:c=stereo:d={close_black:.4f}:s=48000[abc]")
            parts.append(f"{a_after_open}[abc]acrossfade=d={close_dur:.4f}[aout]")

    a_out = "[aout]" if has_audio else ""
    return _force_yuv420p_tail("; ".join(parts), "[vout]"), "[vout]", a_out


def build_open_close_audio_fc(
    opening_transition: str = "none",
    closing_transition: str = "none",
    open_dur: float = XFADE_DUR,
    close_dur: float = XFADE_DUR,
) -> "tuple[str, str]":
    """#65 Phase B: audio-only counterpart to build_open_close_post_fc.

    Extracted so the (already cheap, whole-project) audio_full track can get the
    SAME acrossfade-to-silence open/close fade as before, without re-encoding
    video at all -- the expensive part of the old whole-film post-pass was
    always the video generation, not the audio. Verified against
    build_open_close_post_fc's real filter-graph output before extraction: the
    audio chain only ever references [0:a]/[aout] and never touches [0:v] --
    fully independent of the video chain.

    Input is FFmpeg input index 0 ([0:a]). Returns (fc, a_out_label).
    """
    has_open = opening_transition != "none" and open_dur > 0
    has_close = closing_transition != "none" and close_dur > 0
    if not has_open and not has_close:
        raise ValueError("build_open_close_audio_fc called with no open/close transition")

    parts: list[str] = []
    a_inner = "[0:a]"

    a_after_open = "[awrap]" if has_close else "[aout]"
    if has_open:
        parts.append(f"aevalsrc=0:c=stereo:d={open_dur + 0.1:.4f}:s=48000[abo]")
        parts.append(f"[abo]{a_inner}acrossfade=d={open_dur:.4f}{a_after_open}")
    else:
        a_after_open = a_inner

    if has_close:
        parts.append(f"aevalsrc=0:c=stereo:d={close_dur + 0.1:.4f}:s=48000[abc]")
        parts.append(f"{a_after_open}[abc]acrossfade=d={close_dur:.4f}[aout]")

    return "; ".join(parts), "[aout]"


def build_filter_complex(
    clip_paths: list[Path],
    durations: list[float],
    audio_flags: list[bool],
    cuts: CutPlan,
    transition: str = "crossfade",
    mode: str = "draft",
    output_resolution: str = "1080p",
    clip_volumes: list[float] | None = None,
    shuffle_between: bool = False,
    seed: str | None = None,
    opening_transition: str = "none",
    closing_transition: str = "none",
    target_fps_raw: str = "30000/1001",
    clip_tbn_str: str = "1/30000",
    zoom_vfs: "list[str | None] | None" = None,
) -> tuple[str, str, str]:
    """
    Build filter_complex string for N clips with xfade transitions.

    Args:
        clip_paths:          Ordered list of clip Paths (used only for count).
        durations:           Duration in seconds for each clip (MUST be post-trim durations).
        audio_flags:         Whether each clip has audio (all True after inject_silence_where_needed).
        transition:          "crossfade" | "dip_to_black" | "wipe" | "zoom" | "none"
        mode:                "draft" (360p) | "final" (1080p)
        cuts:                Per-cut lengths from resolve_cuts() (#284).
        shuffle_between:     If True, pick a random transition per cut from _SHUFFLE_POOL.
                             The `transition` arg is ignored when this is True.
        seed:                Stable per-render signature (the render cache's cache_sig)
                             used to seed the RNG for deterministic shuffle re-renders --
                             NOT the job ID, which changes every render (#83). Unused when
                             shuffle_between is False.
        opening_transition:  Transition to apply from a synthetic black frame into clip 0.
                             "none" (default) or cuts.open_s == 0 = skip.
        closing_transition:  Transition to apply from the last clip out to a synthetic black
                             frame. "none" (default) or cuts.close_s == 0 = skip.

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
    has_open = opening_transition != "none" and cuts.open_s > 0
    has_close = closing_transition != "none" and cuts.close_s > 0

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
    #
    # #136: n==1 has no other clip to share a canvas with, so it skips the pad
    # step and preserves native aspect ratio instead (scale=-2:h) -- matching
    # the behavior of the single-clip shortcut this function replaces. Padding
    # a single portrait clip into a landscape canvas would add black bars that
    # never existed before; that's a real regression, not just an implementation
    # detail, so it's preserved deliberately rather than unified away.
    if n == 1:
        canvas = (
            f"scale=-2:{scale_h},format=yuv420p,"
            f"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
        )
    else:
        canvas = (
            f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
            f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
            f"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
        )

    v_out = "[vout]"

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
        pre_scale = "; ".join(_sv_node(i, canvas, zoom_vfs, clip_tbn_str) for i in range(n))
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
        all_parts.append(_sv_node(i, canvas, zoom_vfs, clip_tbn_str))

    # --- Between-clips video ---
    # Label for the output of the between-clip stage.
    # If open/close are also needed we use [vinner]; else wire straight to [vout].
    use_inner = has_open or has_close
    v_inner = "[vinner]" if use_inner else v_out
    # #136: concat/xfade filters renegotiate their OWN output timebase (observed:
    # 1/1000000, generic) regardless of what their inputs declared via settb -- the
    # settb on [sv{i}] above does not survive through concat. So the between-clips
    # stage writes to an internal [vraw] label first, then an explicit settb node
    # pins v_inner's timebase before it's handed to the open/close xfade below.
    # Confirmed via real render: without this, open+close+zoom on a single clip
    # failed with the same "timebase do not match" xfade error even after the
    # [sv{i}] settb fix, because concat=n=1 discarded it. See _sv_node docstring.
    v_raw = "[vraw]"

    if transition == "none" and not shuffle_between:
        # Concat (hard cuts) between clips → [vraw]
        scaled_inputs = "".join(f"[sv{i}]" for i in range(n))
        all_parts.append(f"{scaled_inputs}concat=n={n}:v=1:a=0{v_raw}")
        total_between = sum(durations)
    elif n == 1:
        # Single clip — no between-clips xfade; just rename [sv0] → [vraw]
        all_parts.append(f"[sv0]null{v_raw}")
        total_between = durations[0]
    else:
        # Pairwise xfade chain between clips → [vraw]
        prev_label = "[sv0]"
        cumulative = 0.0
        for i in range(1, n):
            cut_name = per_cut_names[i - 1]
            consumed = sum(cuts.between_s[:i])
            offset = cumulative + durations[i - 1] - consumed
            log.info(
                "[transitions] xfade offset[%d] = %.4fs  "
                "(cumulative=%.4fs - %.4fs) length=%.4fs",
                i, offset, cumulative + durations[i - 1], consumed, cuts.between_s[i - 1],
            )
            # Last xfade in the between-clip chain
            out_label = v_raw if i == n - 1 else f"[v{i:02d}]"
            all_parts.append(_video_join(prev_label, f"[sv{i}]", out_label, cut_name,
                                         cuts.between_s[i - 1], offset, target_fps_raw, clip_tbn_str))
            prev_label = out_label
            cumulative += durations[i - 1]
        total_between = sum(durations) - sum(cuts.between_s)

    all_parts.append(f"{v_raw}settb={clip_tbn_str}{v_inner}")

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
                # Same length as the video cut; audio crossfade is always a dissolve
                # whatever video xfade type was chosen.
                a_lbl = a_inner if i == n - 1 else f"[ac{i}]"
                chain.append(_audio_join(prev_a, f"[pa{i}]", a_lbl, cuts.between_s[i - 1]))
                prev_a = a_lbl
            all_parts.append(f"{pre_vol}; {pre_pad}; " + "; ".join(chain))

    # --- Opening xfade: inline black source → [vinner] → [vwrap] ---
    v_after_open = "[vwrap]" if has_close else v_out
    if has_open:
        open_name = _TRANSITION_MAP.get(opening_transition, "fade")
        # Inline color source for black opening frame (no extra -i input needed).
        # +0.1s buffer: xfade offset must be < input duration.
        open_black = cuts.open_s + 0.1
        all_parts.append(
            f"color=c=black:s={scale_w}x{scale_h}:d={open_black:.4f}:r={target_fps_raw},settb={clip_tbn_str}[sv_bopen]"
        )
        all_parts.append(
            f"[sv_bopen]{v_inner}"
            f"xfade=transition={open_name}:duration={cuts.open_s:.4f}:offset=0"
            f"{v_after_open}"
        )
        total_after_open = total_between + 0.1  # open_black - cuts.open_s = 0.1
        if any_audio:
            # Inline silence for opening black frame audio
            a_after_open = "[awrap]" if has_close else "[aout]"
            all_parts.append(
                f"aevalsrc=0:c=stereo:d={open_black:.4f}:s=48000[abo]"
            )
            all_parts.append(
                f"[abo]{a_inner}acrossfade=d={cuts.open_s:.4f}{a_after_open}"
            )
    else:
        total_after_open = total_between
        v_after_open = v_inner
        a_after_open = a_inner

    # --- Closing xfade: [v_after_open] → inline black source → [vout] ---
    if has_close:
        close_name = _TRANSITION_MAP.get(closing_transition, "fade")
        # Closing xfade starts cuts.close_s before the end of the content stream.
        # +0.1s buffer: xfade offset must be < input duration.
        close_black = cuts.close_s + 0.1
        closing_offset = total_after_open - cuts.close_s
        all_parts.append(
            f"color=c=black:s={scale_w}x{scale_h}:d={close_black:.4f}:r={target_fps_raw},settb={clip_tbn_str}[sv_bclose]"
        )
        all_parts.append(
            f"{v_after_open}[sv_bclose]"
            f"xfade=transition={close_name}:duration={cuts.close_s:.4f}:offset={closing_offset:.4f}"
            f"{v_out}"
        )
        if any_audio:
            all_parts.append(
                f"aevalsrc=0:c=stereo:d={close_black:.4f}:s=48000[abc]"
            )
            all_parts.append(
                f"{a_after_open}[abc]acrossfade=d={cuts.close_s:.4f}[aout]"
            )

    if not any_audio:
        log.info("[transitions] No audio in any clip — video-only output")
        return _force_yuv420p_tail("; ".join(all_parts), v_out), v_out, ""

    a_out = "[aout]"
    return _force_yuv420p_tail("; ".join(all_parts), v_out), v_out, a_out
