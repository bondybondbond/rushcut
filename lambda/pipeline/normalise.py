"""
pipeline/normalise.py — Normalise input clips to H.264/yuv420p/25fps CFR/1080p/AAC.

Key constraints (from CLAUDE.md):
- -map 0:v:0          : DJI OsmoPocket3 embeds an MJPEG thumbnail as a second video
                         stream — always pin to the first (hevc) stream.
- -map 0:a:0?         : Pin to first audio stream, optional (? = don't fail if absent).
                         NOT -map 0:a? which would map ALL audio streams.
- scale=-2:1080       : Maintain aspect ratio, height=1080, even width.
- -fps_mode cfr       : Constant frame rate (required for xfade timing).
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)


def normalise(clip_paths: list[Path], tmp_dir: Path) -> list[Path]:
    """
    Normalise each clip to H.264/yuv420p/25fps/1080p/AAC 128k.
    Returns list of normalised clip Paths in tmp_dir (norm_0.mp4, norm_1.mp4, ...).
    """
    norm_paths: list[Path] = []

    for i, src in enumerate(clip_paths):
        out = tmp_dir / f"norm_{i}.mp4"
        log.info("[normalise] %s -> %s", src.name, out.name)

        ffmpeg_run([
            FFMPEG, "-y",
            "-i", str(src),
            "-map", "0:v:0",    # First video stream (skips DJI thumbnail stream)
            "-map", "0:a:0?",   # First audio stream, optional
            "-vf", "scale=-2:1080,format=yuv420p",
            "-r", "25",
            "-fps_mode", "cfr",
            "-c:v", "libx264",
            "-preset", "fast",
            "-c:a", "aac",
            "-b:a", "128k",
            str(out),
        ])

        norm_paths.append(out)

    log.info("[normalise] Done — %d clips normalised", len(norm_paths))
    return norm_paths
