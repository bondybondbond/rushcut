"""
pipeline/zoom.py — Apply a slow Ken Burns zoom to a clip.

Disabled by default (JobConfig.zoom = False).
Applied per-clip before transitions so each clip gets the effect independently.
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)


def apply_zoom(clip_path: Path, out_path: Path) -> Path:
    """
    Apply a gentle slow zoom (zoompan filter) to clip_path.

    zoompan parameters:
      z='min(zoom+0.0015,1.5)'  — ramp zoom from 1.0x up to 1.5x max
      d=125                      — zoom duration in frames (5s at 25fps)
      x/y centred on frame

    Returns out_path.
    """
    log.info("[zoom] Applying zoompan to %s", clip_path.name)

    ffmpeg_run([
        FFMPEG, "-y",
        "-i", str(clip_path),
        "-vf", (
            "zoompan="
            "z='min(zoom+0.0015,1.5)':"
            "d=125:"
            "x='iw/2-(iw/zoom/2)':"
            "y='ih/2-(ih/zoom/2)'"
        ),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(out_path),
    ])

    return out_path
