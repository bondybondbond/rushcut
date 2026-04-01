"""
pipeline/zoom.py -- Apply a slow Ken Burns zoom to a clip.

Disabled by default (JobConfig.zoom = False).
Applied per-clip before transitions so each clip gets the effect independently.

Supports per-clip focal point (focal_x, focal_y) and zoom presets
(gentle/medium/tight) from the Review screen (Batch 14c).
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)

# Zoom rate per frame and max zoom for each preset.
ZOOM_PRESETS = {
    "gentle": (0.0008, 1.1),
    "medium": (0.0015, 1.3),
    "tight":  (0.0025, 1.5),
}


def apply_zoom(
    clip_path: Path,
    out_path: Path,
    focal_x: float | None = None,
    focal_y: float | None = None,
    zoom_mode: str | None = None,
) -> Path:
    """
    Apply a slow zoom (zoompan filter) to clip_path.

    Args:
        clip_path: Input clip.
        out_path:  Output path.
        focal_x:   Focal point X (0.0-1.0). None = centre (0.5).
        focal_y:   Focal point Y (0.0-1.0). None = centre (0.5).
        zoom_mode: "gentle" (1.1x), "medium" (1.3x), "tight" (1.5x).
                   None = legacy default (tight).

    Returns out_path.
    """
    rate, max_zoom = ZOOM_PRESETS.get(zoom_mode or "tight", (0.0025, 1.5))
    fx = focal_x if focal_x is not None else 0.5
    fy = focal_y if focal_y is not None else 0.5
    # Clamp focal to valid range
    fx = max(0.0, min(1.0, fx))
    fy = max(0.0, min(1.0, fy))

    # Focal-aware x/y expressions with clamping to prevent out-of-frame pan.
    # At zoom z, visible width = iw/z, so x must be in [0, iw - iw/z].
    x_expr = f"x='min(max(iw*{fx:.4f}-(iw/zoom/2), 0), iw-iw/zoom)'"
    y_expr = f"y='min(max(ih*{fy:.4f}-(ih/zoom/2), 0), ih-ih/zoom)'"

    log.info("[zoom] focal=(%.2f,%.2f) zoom_mode=%s rate=%.4f max=%.1fx x=%s y=%s",
             fx, fy, zoom_mode or "tight", rate, max_zoom, x_expr, y_expr)

    ffmpeg_run([
        FFMPEG, "-y",
        "-i", str(clip_path),
        "-vf", (
            f"zoompan="
            f"z='min(zoom+{rate},{max_zoom})':"
            f"d=125:"
            f"{x_expr}:"
            f"{y_expr}"
        ),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(out_path),
    ])

    return out_path
