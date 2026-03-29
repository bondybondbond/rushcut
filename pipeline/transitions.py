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
- Audio: acrossfade for 2-clip case only.
         For 3+ clips use concat filter (hard cuts) — pairwise acrossfade stacks
         incorrectly across N clips and produces misaligned audio overlaps.
"""

import logging
from pathlib import Path

log = logging.getLogger(__name__)

# Map JobConfig.transition values to FFmpeg xfade transition names
_TRANSITION_MAP = {
    "crossfade": "fade",
    "dip_to_black": "fadeblack",
}

XFADE_DUR = 1.5  # seconds


def build_filter_complex(
    clip_paths: list[Path],
    durations: list[float],
    audio_flags: list[bool],
    transition: str = "crossfade",
    mode: str = "draft",
    xfade_dur: float = XFADE_DUR,
) -> tuple[str, str, str]:
    """
    Build filter_complex string for N clips with xfade transitions.

    Args:
        clip_paths:   Ordered list of clip Paths (used only for count).
        durations:    Duration in seconds for each clip (MUST be post-trim durations).
        audio_flags:  Whether each clip has audio (all True after inject_silence_where_needed).
        transition:   "crossfade" | "dip_to_black"
        mode:         "draft" (360p) | "final" (1080p)
        xfade_dur:    Crossfade duration in seconds.

    Returns:
        (filter_complex_str, video_out_label, audio_out_label)
        audio_out_label is "" if no clips have audio.
    """
    n = len(clip_paths)
    scale_h = "360" if mode == "draft" else "1080"
    scale_w = "640" if mode == "draft" else "1920"

    # Fixed-canvas filter applied to every input stream before concat or xfade.
    # Scales to fit inside canvas (preserving AR), then pads remainder black.
    # Prevents FFmpeg dimension-mismatch crash when portrait and landscape clips
    # are mixed in the same project (e.g. 540x1080 vs 1920x1080).
    canvas = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=decrease,"
        f"pad={scale_w}:{scale_h}:(ow-iw)/2:(oh-ih)/2"
    )

    v_out = "[vout]"

    # --- "none" transition: pre-scale all inputs, then straight concat ---
    if transition == "none":
        any_audio = any(audio_flags)
        # [0:v]canvas[sv0]; [1:v]canvas[sv1]; ... [sv0][sv1]...concat[vout]
        pre_scale = "; ".join(f"[{i}:v]{canvas}[sv{i}]" for i in range(n))
        scaled_inputs = "".join(f"[sv{i}]" for i in range(n))
        video_filter = f"{pre_scale}; {scaled_inputs}concat=n={n}:v=1:a=0{v_out}"
        if not any_audio:
            return video_filter, v_out, ""
        inputs_a = "".join(f"[{i}:a]" for i in range(n))
        a_out = "[aout]"
        audio_filter = f"{inputs_a}concat=n={n}:v=0:a=1{a_out}"
        return f"{video_filter}; {audio_filter}", v_out, a_out

    xfade_name = _TRANSITION_MAP.get(transition, "fade")

    # Clamp xfade_dur so it never exceeds half the shortest clip.
    # Prevents transitions from consuming clips shorter than 2x the fade duration.
    min_dur = min(durations)
    effective_dur = min(xfade_dur, min_dur / 2.0)
    if effective_dur < xfade_dur:
        log.warning(
            "[transitions] xfade_dur clamped %.3fs -> %.3fs (shortest clip=%.3fs)",
            xfade_dur, effective_dur, min_dur,
        )
    xfade_dur = effective_dur

    # --- Video: pre-scale all inputs, then pairwise xfade chain ---
    video_parts: list[str] = []

    # Pre-scale every input to fixed canvas — [sv0],[sv1],... (both paths fixed)
    # Single-clip edge case: output directly to [vout] (no xfade chain follows).
    for i in range(n):
        out_lbl = v_out if n == 1 else f"[sv{i}]"
        video_parts.append(f"[{i}:v]{canvas}{out_lbl}")

    if n > 1:
        prev_label = "[sv0]"
        cumulative = 0.0
        for i in range(1, n):
            offset = cumulative + durations[i - 1] - xfade_dur * i
            log.info(
                "[transitions] xfade offset[%d] = %.4fs  "
                "(cumulative=%.4fs - %.4fs)",
                i, offset, cumulative + durations[i - 1], xfade_dur * i,
            )
            # Last xfade in chain outputs directly to [vout]
            out_label = v_out if i == n - 1 else f"[v{i:02d}]"
            video_parts.append(
                f"{prev_label}[sv{i}]"
                f"xfade=transition={xfade_name}:duration={xfade_dur}:offset={offset:.4f}"
                f"{out_label}"
            )
            prev_label = out_label
            cumulative += durations[i - 1]

    # --- Audio ---
    any_audio = any(audio_flags)
    if not any_audio:
        log.info("[transitions] No audio in any clip — video-only output")
        return "; ".join(video_parts), v_out, ""

    if n == 2:
        # Two-clip case: use acrossfade — audio duration already matches video
        audio_parts = [f"[0:a][1:a]acrossfade=d={xfade_dur}[aout]"]
    else:
        # Three+ clips: concat filter (hard audio cuts at joins).
        # acrossfade chaining for 3+ clips produces misaligned audio overlaps.
        # IMPORTANT: concat gives sum(durations) but video is (n-1)*xfade_dur shorter
        # due to xfade overlaps. Trim audio to match video exactly.
        total_dur = sum(durations) - (n - 1) * xfade_dur
        inputs = "".join(f"[{i}:a]" for i in range(n))
        audio_parts = [
            f"{inputs}concat=n={n}:v=0:a=1,"
            f"atrim=end={total_dur:.4f},"
            f"asetpts=PTS-STARTPTS[aout]"
        ]

    a_out = "[aout]"
    all_parts = video_parts + audio_parts
    return "; ".join(all_parts), v_out, a_out
