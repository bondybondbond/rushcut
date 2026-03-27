"""
pipeline/normalise.py — Normalise input clips to H.264/yuv420p/25fps CFR/AAC.

Key constraints (from CLAUDE.md):
- -map 0:v:0          : DJI OsmoPocket3 embeds an MJPEG thumbnail as a second video
                         stream — always pin to the first (hevc) stream.
- -map 0:a:0?         : Pin to first audio stream, optional (? = don't fail if absent).
                         NOT -map 0:a? which would map ALL audio streams.
- scale=-2:HEIGHT     : Maintain aspect ratio, even width. 360 for draft, 1080 for final.
- -fps_mode cfr       : Constant frame rate (required for xfade timing).
"""

import logging
from collections.abc import Callable
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)


def normalise(
    clip_paths: list[Path],
    tmp_dir: Path,
    mode: str = "draft",
    on_clip_done: "Callable[[int, int], None] | None" = None,
) -> list[Path]:
    """
    Normalise each clip to H.264/yuv420p/25fps/AAC 128k.
    draft mode: 360p + ultrafast preset (fast Lambda turnaround).
    final mode: 1080p + fast preset (quality output).
    Returns list of normalised clip Paths in tmp_dir (norm_0.mp4, norm_1.mp4, ...).
    """
    # TODO(landscape): add layout param ("portrait" | "landscape_blur" | "landscape_crop")
    # landscape_blur requires -filter_complex (not -vf) because it references [0:v] twice:
    #   [0:v]scale=-2:{h},setsar=1[fg];[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,
    #   crop={w}:{h},boxblur=20:5[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2
    # transitions.py must also receive layout and use scale={w}:{h} (exact) for landscape
    # modes to prevent the -2:height re-scaling from re-introducing portrait dimensions.
    # detect.py: confirm it handles DJI rotation metadata (ffprobe 'rotate' tag) for portrait.
    if mode == "draft":
        scale_filter = "scale=-2:360,format=yuv420p"
        preset = "ultrafast"
    else:
        scale_filter = "scale=-2:1080,format=yuv420p"
        preset = "fast"

    norm_paths: list[Path] = []

    for i, src in enumerate(clip_paths):
        out = tmp_dir / f"norm_{i}.mp4"
        log.info("[normalise] %s -> %s (mode=%s)", src.name, out.name, mode)

        ffmpeg_run([
            FFMPEG, "-y",
            "-i", str(src),
            "-map", "0:v:0",    # First video stream (skips DJI thumbnail stream)
            "-map", "0:a:0?",   # First audio stream, optional
            "-vf", scale_filter,
            "-r", "25",
            "-fps_mode", "cfr",
            "-c:v", "libx264",
            "-preset", preset,
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "48000",
            str(out),
        ])

        norm_paths.append(out)
        if on_clip_done:
            on_clip_done(i + 1, len(clip_paths))

    log.info("[normalise] Done — %d clips normalised", len(norm_paths))
    return norm_paths
