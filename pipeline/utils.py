"""
pipeline/utils.py — Shared FFmpeg helpers used across all pipeline modules.
"""

import json
import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger(__name__)

# WSL2 Ubuntu-24.04 system FFmpeg at /usr/bin (v7.x).
# Override via env vars if needed.
FFMPEG  = os.environ.get("FFMPEG_BIN",  "/usr/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "/usr/bin/ffprobe")


def ffmpeg_run(cmd: list[str]) -> None:
    """Run an FFmpeg command, raising RuntimeError with stderr on failure."""
    log.info("[ffmpeg] %s", " ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"FFmpeg failed (exit {result.returncode}):\n"
            f"CMD: {' '.join(str(c) for c in cmd)}\n"
            f"STDERR: {result.stderr[-4000:]}"
        )


def ffprobe_json(args: list[str]) -> dict:
    """Run ffprobe and return parsed JSON output."""
    cmd = [FFPROBE, "-v", "error"] + args + ["-print_format", "json"]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def get_duration(path: str | Path) -> float:
    """Return duration in seconds (format duration, fallback to first video stream)."""
    result = subprocess.run(
        [FFPROBE, "-v", "error",
         "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1",
         str(path)],
        capture_output=True, text=True, check=True
    )
    val = result.stdout.strip()
    if val and val != "N/A":
        return float(val)
    # Fallback: first video stream duration
    data = ffprobe_json(["-show_streams", str(path)])
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and s.get("duration"):
            return float(s["duration"])
    raise RuntimeError(f"Cannot determine duration for {path}")


def get_frame_size(path: str | Path) -> tuple[int, int]:
    """Return (width, height) of the first video stream."""
    data = ffprobe_json(["-show_streams", "-select_streams", "v:0", str(path)])
    for s in data.get("streams", []):
        return int(s["width"]), int(s["height"])
    raise RuntimeError(f"Cannot determine frame size for {path}")


def has_audio(path: str | Path) -> bool:
    """Return True if the file contains at least one audio stream."""
    result = subprocess.run(
        [FFPROBE, "-v", "error",
         "-select_streams", "a",
         "-show_entries", "stream=codec_type",
         "-of", "csv=p=0",
         str(path)],
        capture_output=True, text=True, check=True
    )
    return bool(result.stdout.strip())
