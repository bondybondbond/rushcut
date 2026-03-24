"""
pipeline/transitions.py — Build filter_complex for xfade (video) + audio joining.

Key constraints (from CLAUDE.md + plan fixes):
- xfade transition names: "crossfade" -> transition=fade, "dip_to_black" -> transition=fadeblack
  (fadeblack is a native FFmpeg xfade transition — no custom black-fill logic needed)
- scale=-2:{h} MUST be appended inside filter_complex, NOT as -vf, when filter_complex is active
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

XFADE_DUR = 0.5  # seconds


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
    xfade_name = _TRANSITION_MAP.get(transition, "fade")
    scale_h = "360" if mode == "draft" else "1080"

    # --- Video: pairwise xfade chain ---
    video_parts: list[str] = []
    prev_label = "[0:v]"
    cumulative = 0.0

    for i in range(1, n):
        # Verbatim offset formula from spike/render.py
        offset = cumulative + durations[i - 1] - xfade_dur * i
        log.info(
            "[transitions] xfade offset[%d] = %.4fs  "
            "(cumulative=%.4fs - %.4fs)",
            i, offset, cumulative + durations[i - 1], xfade_dur * i
        )
        out_label = f"[v{i:02d}]"
        video_parts.append(
            f"{prev_label}[{i}:v]"
            f"xfade=transition={xfade_name}:duration={xfade_dur}:offset={offset:.4f}"
            f"{out_label}"
        )
        prev_label = out_label
        cumulative += durations[i - 1]

    # Scale appended inside filter_complex (MUST NOT use -vf when filter_complex is active)
    v_out = "[vout]"
    video_parts.append(f"{prev_label}scale=-2:{scale_h}{v_out}")

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
        # due to xfade overlaps. Trim audio to match video exactly, otherwise the
        # player freezes on the last frame (end card) for the duration of the mismatch.
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
