"""
pipeline/trim.py — Trim a normalised clip to [start_s, end_s].

Re-encodes for frame-accurate trim (relies on FFmpeg's default accurate_seek
during transcode; stream copy was removed — see #96, it silently included
extra pre-in-point footage on non-keyframe-aligned trims). Uses -t (duration)
not -to (end position) to avoid timestamp-base ambiguity with input-side seek
+ transcode. Fallback if frame accuracy ever regresses: move -ss after -i
(output/accurate seek) — slower but guaranteed exact.
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)


def trim(clip_path: Path, start_s: float, end_s: float, out_path: Path) -> Path:
    """
    Trim clip_path to [start_s, end_s], frame-accurate (re-encode, not stream copy).
    Returns out_path.
    """
    log.info("[trim] %s -> %.2fs–%.2fs", clip_path.name, start_s, end_s)
    duration_s = end_s - start_s

    ffmpeg_run([
        FFMPEG, "-y",
        "-ss", f"{start_s:.4f}",
        "-t", f"{duration_s:.4f}",
        "-i", str(clip_path),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        str(out_path),
    ])

    return out_path
