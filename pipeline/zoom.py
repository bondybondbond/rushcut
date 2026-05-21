"""
pipeline/zoom.py -- Apply a zoom effect to a clip.

Two styles, both selected per-clip via the `zoom_mode` string:

  * Static    -- a fixed "crop-in" (single FFmpeg crop+scale pass, ~200fps).
                 zoom_mode is "gentle" (1.3x) / "medium" (1.5x) / "tight" (2.0x).

  * Gradual    -- a gradual eased zoom across the full trimmed clip duration.
                 zoom_mode is encoded as "kb_<dir>_<ratio>_<speed>",
                 e.g. "kb_in_1.5_slow" or "kb_out_2.0_slow".
                   dir   = in | out
                   ratio = 1.3 | 1.5 | 2.0
                   speed = slow | med | fast  (fraction of clip when zoom is realized:
                           slow=100 %, med=75 %, fast=50 %; holds after that point)
                 Implemented as a time-varying `scale` (eval=frame) feeding a
                 constant `crop` -- a single pass at ~encode speed. It does NOT
                 use the `zoompan` filter, which took minutes per clip and was
                 removed.

Both styles honour the per-clip focal point (focal_x, focal_y).
"""

import json
import logging
import subprocess
from pathlib import Path

from .utils import FFMPEG, FFPROBE, ffmpeg_run

log = logging.getLogger(__name__)

# Static preset name -> zoom multiplier (crop ratio = 1/zoom).
ZOOM_PRESETS = {
    "gentle": 1.3,
    "medium": 1.5,
    "tight":  2.0,
}

# Gradual zoom speed -> motion duration as a fraction of clip duration.
# Slow  = zoom fills the whole clip (realized at the very end).
# Med   = zoom fully realized at 75 % of clip, then holds.
# Fast  = zoom fully realized at 50 % of clip, then holds.
_KB_SPEED_FRAC = {
    "slow": 1.0,
    "med":  0.75,
    "fast": 0.5,
}


def _probe(clip_path: Path) -> tuple[int, int, float]:
    """Return (width, height, duration_s) of the first video stream via ffprobe.

    A single ffprobe call -- the Ken Burns path needs the duration and spawning
    a second process per clip is wasteful.
    """
    result = subprocess.run(
        [
            FFPROBE, "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            "-of", "json",
            str(clip_path),
        ],
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    w = int(stream["width"])
    h = int(stream["height"])
    dur = float(data.get("format", {}).get("duration") or 0.0)
    return w, h, dur


def _parse_kenburns(zoom_mode: str | None) -> dict | None:
    """Parse a "kb_<dir>_<ratio>_<speed>" string.

    Returns {"direction", "ratio", "speed"} or None if zoom_mode is not a
    well-formed Ken Burns value (so callers fall back to the static path).
    """
    if not zoom_mode or not zoom_mode.startswith("kb_"):
        return None
    parts = zoom_mode.split("_")
    if len(parts) != 4:
        return None
    _, direction, ratio_s, speed = parts
    if direction not in ("in", "out") or speed not in _KB_SPEED_FRAC:
        return None
    try:
        ratio = float(ratio_s)
    except ValueError:
        return None
    if ratio <= 1.0:
        return None
    return {"direction": direction, "ratio": ratio, "speed": speed}


def _motion_duration(speed: str, clip_dur: float) -> float:
    """Motion duration (seconds) the zoom animates over before holding still."""
    m = clip_dur * _KB_SPEED_FRAC.get(speed, 1.0)
    return max(0.1, m)


def _kenburns_vf(iw: int, ih: int, clip_dur: float,
                 kb: dict, fx: float, fy: float) -> tuple[str, float]:
    """Build the Ken Burns filtergraph string. Returns (vf, motion_duration_s).

    The expression is deliberately COMMA-FREE -- FFmpeg's filtergraph parser
    treats commas as filter separators, and avoiding min()/clip()/pow() (all of
    which take comma-separated args) removes every escaping ambiguity:
      progress X = smoothstep of clamp(t/M, 0, 1); t>=0 so only an upper clamp
                   is needed, and min(a,1) == (a + 1 - abs(a-1)) / 2.
      ease     E = 3*X*X - 2*X*X*X
      factor  ZF = 1 + (Z-1) * P    where P = E (zoom-in) or 1-E (zoom-out)
    Writing ZF as `1 + (Z-1)*P` (rather than `Z - (Z-1)*E`) keeps ZF >= 1 by
    construction, so float drift can never make the scaled frame smaller than
    the constant crop window.
    """
    z = kb["ratio"]
    m = _motion_duration(kb["speed"], clip_dur)

    # Clamped eased progress (comma-free).
    x_expr = f"(((t/{m:.4f})+1-abs((t/{m:.4f})-1))/2)"
    e_expr = f"(3*{x_expr}*{x_expr}-2*{x_expr}*{x_expr}*{x_expr})"
    p_expr = e_expr if kb["direction"] == "in" else f"(1-{e_expr})"
    zf = f"(1+{z - 1.0:.4f}*{p_expr})"

    # Constant even output dimensions.
    out_w = iw - (iw % 2)
    out_h = ih - (ih % 2)

    # scale up by ZF (re-evaluated per frame), then crop a constant window
    # anchored at the focal point. `eval=frame` is valid on `scale` only --
    # `crop` has no `eval` option but re-evaluates x/y per frame natively.
    vf = (
        f"scale=w='2*trunc(iw*{zf}/2)':h='2*trunc(ih*{zf}/2)':eval=frame,"
        f"crop={out_w}:{out_h}:'(iw-ow)*{fx:.4f}':'(ih-oh)*{fy:.4f}'"
    )
    return vf, m


def apply_zoom(
    clip_path: Path,
    out_path: Path,
    focal_x: float | None = None,
    focal_y: float | None = None,
    zoom_mode: str | None = None,
    threads: int | None = None,
) -> Path:
    """
    Apply a zoom (static crop-in or gradual Ken Burns) to clip_path.

    Args:
        clip_path: Input clip (normalised H.264).
        out_path:  Output path.
        focal_x:   Focal point X (0.0-1.0). None = centre (0.5).
        focal_y:   Focal point Y (0.0-1.0). None = centre (0.5).
        zoom_mode: Static  -> "gentle" / "medium" / "tight" (None = "gentle").
                   Ken Burns -> "kb_<dir>_<ratio>_<speed>", e.g. "kb_in_1.5_med".
        threads:   Cap FFmpeg to N threads (decode + encode) AND N filter
                   threads. Set when run from a parallel pool so N concurrent
                   encoders don't oversubscribe cores. None = uncapped (FFmpeg
                   grabs all cores — correct for a serial caller). The
                   eval=frame 4K scale is filtergraph-bound, so -filter_threads
                   matters as much as -threads.

    Returns out_path.
    """
    fx = max(0.0, min(1.0, focal_x if focal_x is not None else 0.5))
    fy = max(0.0, min(1.0, focal_y if focal_y is not None else 0.5))

    iw, ih, clip_dur = _probe(clip_path)

    kb = _parse_kenburns(zoom_mode)
    extra_args: list[str] = []

    if kb is not None:
        # Ken Burns -- gradual eased zoom.
        vf, motion_s = _kenburns_vf(iw, ih, clip_dur, kb, fx, fy)
        # The zoomed clip is an intermediate, re-encoded by the transitions /
        # render steps -- ultrafast is the right preset (cf. normalise.py).
        extra_args = ["-preset", "ultrafast"]
        log.info(
            "[zoom] kenburns dir=%s ratio=%.1fx speed=%s motion=%.1fs/%.1fs "
            "focal=(%.2f,%.2f) input=%dx%d",
            kb["direction"], kb["ratio"], kb["speed"], motion_s, clip_dur,
            fx, fy, iw, ih,
        )
    else:
        # Static -- single-pass crop+scale (a fixed "crop-in").
        zoom = ZOOM_PRESETS.get(zoom_mode or "gentle", 1.3)

        # Crop dimensions (floor to int so FFmpeg gets integers).
        crop_w = int(iw / zoom)
        crop_h = int(ih / zoom)
        # Ensure H.264 even dimensions.
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

    thread_args: list[str] = []
    if threads is not None and threads >= 1:
        thread_args = ["-threads", str(threads), "-filter_threads", str(threads)]

    ffmpeg_run([
        FFMPEG, "-y",
        *thread_args,
        "-i", str(clip_path),
        "-vf", vf,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        *extra_args,
        "-c:a", "copy",
        str(out_path),
    ])

    return out_path
