"""
pipeline/trim.py — Trim a normalised clip to [start_s, end_s].

Uses -c copy (stream copy) — safe post-normalise since all clips are H.264/AAC.
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)


def trim(clip_path: Path, start_s: float, end_s: float, out_path: Path) -> Path:
    """
    Trim clip_path to [start_s, end_s] using stream copy.
    Returns out_path.
    """
    log.info("[trim] %s -> %.2fs–%.2fs", clip_path.name, start_s, end_s)

    ffmpeg_run([
        FFMPEG, "-y",
        "-ss", f"{start_s:.4f}",
        "-to", f"{end_s:.4f}",
        "-i", str(clip_path),
        "-c", "copy",
        str(out_path),
    ])

    return out_path
