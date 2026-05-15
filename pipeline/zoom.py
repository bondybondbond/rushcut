"""
pipeline/zoom.py -- Apply a static zoom (crop + scale) to a clip.

Replaces the old zoompan (Ken Burns) approach which took minutes per clip.
Static crop+scale runs in a single FFmpeg pass at ~200fps -- negligible
render overhead regardless of clip length.

Gradual zoom (zoom-in / zoom-out animations) is planned for Batch K.

Supports per-clip focal point (focal_x, focal_y) and zoom presets
(gentle/medium/tight) from the Arrange screen.
"""

import json
import logging
import subprocess
from pathlib import Path

from .utils import FFMPEG, FFPROBE, ffmpeg_run

log = logging.getLogger(__name__)

# Preset name -> static zoom multiplier (crop ratio = 1/zoom).
# gentle=1.3x, medium=1.5x, tight=2.0x.
ZOOM_PRESETS = {
    "gentle": 1.3,
    "medium": 1.5,
    "tight":  2.0,
}


def _get_video_size(clip_path: Path) -> tuple[int, int]:
    """Return (width, height) of the first video stream via ffprobe."""
    result = subprocess.run(
        [
            FFPROBE, "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            str(clip_path),
        ],
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    return int(stream["width"]), int(stream["height"])


def apply_zoom(
    clip_path: Path,
    out_path: Path,
    focal_x: float | None = None,
    focal_y: float | None = None,
    zoom_mode: str | None = None,
) -> Path:
    """
    Apply a static zoom (crop + scale) to clip_path.

    The crop window is centred on (focal_x, focal_y) and scaled back to the
    original resolution.  Result is indistinguishable from a camera zoom --
    but encodes at full speed (no per-frame zoompan processing).

    Pixel values are computed up-front via ffprobe to avoid FFmpeg filter
    expression syntax issues with min/max commas in the filtergraph parser.

    Args:
        clip_path: Input clip (normalised H.264 1080p).
        out_path:  Output path.
        focal_x:   Focal point X (0.0-1.0). None = centre (0.5).
        focal_y:   Focal point Y (0.0-1.0). None = centre (0.5).
        zoom_mode: "gentle" (1.3x), "medium" (1.5x), "tight" (2.0x).
                   None = fallback to "gentle".

    Returns out_path.
    """
    zoom = ZOOM_PRESETS.get(zoom_mode or "gentle", 1.3)
    fx = max(0.0, min(1.0, focal_x if focal_x is not None else 0.5))
    fy = max(0.0, min(1.0, focal_y if focal_y is not None else 0.5))

    # Get exact pixel dimensions to avoid FFmpeg expression comma conflicts.
    iw, ih = _get_video_size(clip_path)

    # Crop dimensions (floor to int so FFmpeg gets integers).
    crop_w = int(iw / zoom)
    crop_h = int(ih / zoom)

    # Ensure H.264 even dimensions on both crop and scale output.
    crop_w = crop_w - (crop_w % 2)
    crop_h = crop_h - (crop_h % 2)

    # Focal-aware crop origin, clamped to keep window in frame.
    raw_x = fx * (iw - crop_w)
    raw_y = fy * (ih - crop_h)
    x = int(max(0, min(raw_x, iw - crop_w)))
    y = int(max(0, min(raw_y, ih - crop_h)))

    # Scale back up to original size (force even).
    scale_w = iw - (iw % 2)
    scale_h = ih - (ih % 2)

    vf = f"crop={crop_w}:{crop_h}:{x}:{y},scale={scale_w}:{scale_h}"

    log.info(
        "[zoom] static crop focal=(%.2f,%.2f) zoom_mode=%s zoom=%.1fx "
        "input=%dx%d crop=%dx%d@(%d,%d) scale=%dx%d",
        fx, fy, zoom_mode or "gentle", zoom,
        iw, ih, crop_w, crop_h, x, y, scale_w, scale_h,
    )

    ffmpeg_run([
        FFMPEG, "-y",
        "-i", str(clip_path),
        "-vf", vf,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-c:a", "copy",
        str(out_path),
    ])

    return out_path
