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


def trim(clip_path: Path, start_s: float, end_s: float, out_path: Path, threads: int | None = None) -> Path:
    """
    Trim clip_path to [start_s, end_s], frame-accurate (re-encode, not stream copy).
    threads: optional -threads cap (used when running multiple trims in parallel,
    e.g. render.py Step 2, to prevent CPU oversubscription — see normalise.py).
    Returns out_path.
    """
    log.info("[trim] %s -> %.2fs–%.2fs", clip_path.name, start_s, end_s)
    duration_s = end_s - start_s

    cmd = [FFMPEG, "-y"]
    if threads is not None:
        cmd += ["-threads", str(threads)]
    cmd += [
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
    ]
    ffmpeg_run(cmd)

    return out_path
