"""
pipeline/cards.py — Generate intro/end card video segments.

Cards are pre-rendered as short H.264 video clips so they pass through
the xfade filter_complex without special-casing (same as any other clip).
"""

import logging
from pathlib import Path

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)

DEFAULT_DURATION_S = 3.0


def make_card(
    text: str,
    color: str,
    duration_s: float,
    out_path: Path,
    size: str,
) -> Path:
    """
    Render a solid-colour card with centred text.

    Args:
        text:       Text to display (centred on card).
        color:      Background colour (FFmpeg colour name or #rrggbb hex).
        duration_s: Card duration in seconds.
        out_path:   Output .mp4 path.
        size:       Frame size as "WxH" (e.g. "1920x1080" or "640x360").

    Returns:
        out_path
    """
    log.info("[cards] Rendering %s card: '%s' (%s, %.1fs)", color, text, size, duration_s)

    # Note: drawtext is not available in the ARM64 static FFmpeg build on Lambda.
    # Cards are rendered as solid-colour backgrounds only (no text overlay).
    ffmpeg_run([
        FFMPEG, "-y",
        "-f", "lavfi",
        "-i", f"color=c={color}:s={size}:r=25:d={duration_s:.4f}",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-t", f"{duration_s:.4f}",
        # Cards have no audio — silence is injected later in render.py
        str(out_path),
    ])

    return out_path
