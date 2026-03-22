"""
pipeline/cards.py — Generate intro/end card video segments.

Cards are pre-rendered as short H.264 video clips so they pass through
the xfade filter_complex without special-casing (same as any other clip).

Text is rendered via Pillow (PIL) — a PNG frame is composited first,
then looped into H.264 video via FFmpeg. This avoids the drawtext filter,
which is unavailable in the ARM64 johnvansickle static FFmpeg build.
"""

import logging
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .utils import FFMPEG, ffmpeg_run

log = logging.getLogger(__name__)

DEFAULT_DURATION_S = 3.0

# Font bundled alongside the Lambda handler at /var/task/fonts/
_FONT_PATH = Path(__file__).parent.parent / "fonts" / "DejaVuSans.ttf"


def _luminance(hex_color: str) -> float:
    """Return relative luminance (0-1) of a #rrggbb colour string."""
    hex_color = hex_color.strip()
    if hex_color.startswith("#") and len(hex_color) == 7:
        r = int(hex_color[1:3], 16) / 255
        g = int(hex_color[3:5], 16) / 255
        b = int(hex_color[5:7], 16) / 255
        # Approximate sRGB linearisation
        r = r / 12.92 if r <= 0.04045 else ((r + 0.055) / 1.055) ** 2.4
        g = g / 12.92 if g <= 0.04045 else ((g + 0.055) / 1.055) ** 2.4
        b = b / 12.92 if b <= 0.04045 else ((b + 0.055) / 1.055) ** 2.4
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    # Fall back to white text for named / unknown colours
    return 0.0


def _make_png(text: str, color: str, width: int, height: int, png_path: Path) -> None:
    """Render a card frame as a PNG using Pillow."""
    img = Image.new("RGB", (width, height), color)
    draw = ImageDraw.Draw(img)

    if not text:
        img.save(str(png_path))
        return

    # Load bundled font — raise on failure so we get a clear error, not silent degradation
    if not _FONT_PATH.exists():
        raise FileNotFoundError(
            f"[cards] Font not found at {_FONT_PATH}. "
            "Ensure lambda/fonts/DejaVuSans.ttf is present and COPY fonts/ fonts/ is in the Dockerfile."
        )
    font_size = max(40, height // 12)
    try:
        font = ImageFont.truetype(str(_FONT_PATH), size=font_size)
    except Exception as exc:
        raise RuntimeError(f"[cards] Failed to load font from {_FONT_PATH}: {exc}") from exc

    log.info("[cards] font_size=%d path=%s", font_size, _FONT_PATH)

    # Choose text colour for readability against the background
    text_fill = "#000000" if _luminance(color) > 0.179 else "#ffffff"

    # Measure and centre text
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    x = (width - text_w) / 2 - bbox[0]
    y = (height - text_h) / 2 - bbox[1]
    draw.text((x, y), text, fill=text_fill, font=font)

    img.save(str(png_path))


def make_card(
    text: str,
    color: str,
    duration_s: float,
    out_path: Path,
    size: str,
) -> Path:
    """
    Render a card with centred text as a short H.264 video clip.

    Args:
        text:       Text to display (centred on card). Empty string = no text.
        color:      Background colour (#rrggbb hex or FFmpeg colour name).
        duration_s: Card duration in seconds.
        out_path:   Output .mp4 path.
        size:       Frame size as "WxH" (e.g. "1920x1080" or "640x360").

    Returns:
        out_path
    """
    log.info("[cards] Rendering %s card: '%s' (%s, %.1fs)", color, text, size, duration_s)

    width, height = map(int, size.split("x"))
    png_path = out_path.with_suffix(".png")

    try:
        _make_png(text, color, width, height, png_path)

        ffmpeg_run([
            FFMPEG, "-y",
            "-loop", "1",
            "-i", str(png_path),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-r", "25",
            "-t", f"{duration_s:.4f}",
            # Cards have no audio — silence is injected later in render.py
            str(out_path),
        ])
    finally:
        if png_path.exists():
            png_path.unlink()

    return out_path
