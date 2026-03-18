"""
pipeline/detect.py — Silence detection for trim-point calculation.

Uses FFmpeg silencedetect filter (noise=-30dB, min duration 0.5s).
Parses stderr output to find silence_start / silence_end pairs.
"""

import logging
import re
import subprocess
from pathlib import Path

from .utils import FFMPEG, FFPROBE, get_duration

log = logging.getLogger(__name__)

_SILENCE_RE = re.compile(
    r"silence_(start|end): ([0-9.]+)(?:\s*\|\s*silence_duration: ([0-9.]+))?"
)


def detect_silence(clip_path: Path) -> list[tuple[float, float]]:
    """
    Run silencedetect and return list of (start_s, end_s) silence ranges.
    Returns [] if no silence found.
    """
    result = subprocess.run(
        [FFMPEG,
         "-i", str(clip_path),
         "-af", "silencedetect=noise=-30dB:d=0.5",
         "-f", "null", "-"],
        capture_output=True, text=True
    )
    # silencedetect writes to stderr
    matches = _SILENCE_RE.findall(result.stderr)

    ranges: list[tuple[float, float]] = []
    pending_start: float | None = None

    for event, ts, _dur in matches:
        if event == "start":
            pending_start = float(ts)
        elif event == "end" and pending_start is not None:
            ranges.append((pending_start, float(ts)))
            pending_start = None

    log.info("[detect] %s — %d silence range(s)", clip_path.name, len(ranges))
    return ranges


def detect_trim_points(clip_path: Path, duration_s: float) -> tuple[float, float]:
    """
    Find first non-silent content start and last non-silent content end.

    Returns (trim_start_s, trim_end_s).
    Falls back to (0.0, duration_s) if no silence detected.
    Leaves at least 0.1s of content (guard against completely-silent clips).
    """
    ranges = detect_silence(clip_path)

    if not ranges:
        return 0.0, duration_s

    trim_start = 0.0
    trim_end = duration_s

    # Leading silence: if first range starts at/near 0, trim to its end
    if ranges[0][0] < 0.05:
        trim_start = ranges[0][1]

    # Trailing silence: if last range ends at/near clip end, trim to its start
    if ranges[-1][1] > duration_s - 0.05:
        trim_end = ranges[-1][0]

    # Guard: ensure we don't produce empty or negative duration
    if trim_end - trim_start < 0.1:
        log.warning("[detect] %s — trim would produce <0.1s clip; skipping trim", clip_path.name)
        return 0.0, duration_s

    log.info("[detect] %s — trim %.2fs -> %.2fs (was %.2fs)", clip_path.name, trim_start, trim_end, duration_s)
    return trim_start, trim_end
