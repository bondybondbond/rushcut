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


def _make_png(
    text: str,
    color: str,
    width: int,
    height: int,
    png_path: Path,
    subtitle: str = "",
) -> None:
    """Render a card frame as a PNG using Pillow."""
    if not text:
        img = Image.new("RGB", (width, height), color)
        img.save(str(png_path))
        return

    # Load bundled font — raise on failure so we get a clear error, not silent degradation
    if not _FONT_PATH.exists():
        raise FileNotFoundError(
            f"[cards] Font not found at {_FONT_PATH}. "
            "Ensure lambda/fonts/DejaVuSans.ttf is present and COPY fonts/ fonts/ is in the Dockerfile."
        )
    font_size = max(40, height // 12)
    sub_font_size = max(24, height // 22)
    try:
        font = ImageFont.truetype(str(_FONT_PATH), size=font_size)
        sub_font = ImageFont.truetype(str(_FONT_PATH), size=sub_font_size)
    except Exception as exc:
        raise RuntimeError(f"[cards] Failed to load font from {_FONT_PATH}: {exc}") from exc

    log.info("[cards] font_size=%d sub_font_size=%d path=%s", font_size, sub_font_size, _FONT_PATH)

    # Choose text colour for readability against the background
    lum = _luminance(color)
    text_fill_rgb = (0, 0, 0) if lum > 0.179 else (255, 255, 255)

    # Parse background colour to RGBA tuple
    hex_c = color.strip()
    if hex_c.startswith("#") and len(hex_c) == 7:
        bg_rgba = (int(hex_c[1:3], 16), int(hex_c[3:5], 16), int(hex_c[5:7], 16), 255)
    else:
        bg_rgba = (0, 0, 0, 255)

    # Build RGBA canvas so subtitle can be composited at partial opacity
    img = Image.new("RGBA", (width, height), bg_rgba)
    draw = ImageDraw.Draw(img)

    # Measure both strings with getbbox for accurate combined block height
    title_bbox = draw.textbbox((0, 0), text, font=font)
    title_h = title_bbox[3] - title_bbox[1]
    title_w = title_bbox[2] - title_bbox[0]

    gap = height // 40

    if subtitle:
        sub_bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
        sub_h = sub_bbox[3] - sub_bbox[1]
        sub_w = sub_bbox[2] - sub_bbox[0]
        block_h = title_h + gap + sub_h
    else:
        sub_bbox = None
        sub_h = sub_w = 0
        block_h = title_h

    # Vertical origin: top of title such that combined block is centred
    y0 = (height - block_h) / 2 - title_bbox[1]
    x_title = (width - title_w) / 2 - title_bbox[0]
    draw.text((x_title, y0), text, fill=text_fill_rgb + (255,), font=font)

    if subtitle and sub_bbox is not None:
        y_sub = y0 + title_h + gap - sub_bbox[1]
        x_sub = (width - sub_w) / 2 - sub_bbox[0]
        sub_fill = text_fill_rgb + (153,)  # 60% alpha
        draw.text((x_sub, y_sub), subtitle, fill=sub_fill, font=sub_font)

    img.convert("RGB").save(str(png_path))


def make_card(
    text: str,
    color: str,
    duration_s: float,
    out_path: Path,
    size: str,
    subtitle: str = "",
    target_fps: str = "25",
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
        _make_png(text, color, width, height, png_path, subtitle=subtitle)

        ffmpeg_run([
            FFMPEG, "-y",
            "-loop", "1",
            "-i", str(png_path),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-r", target_fps,
            "-t", f"{duration_s:.4f}",
            # Cards have no audio — silence is injected later in render.py
            str(out_path),
        ])
    finally:
        if png_path.exists():
            png_path.unlink()

    return out_path
