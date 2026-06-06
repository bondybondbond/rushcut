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
    """Run an FFmpeg command, raising RuntimeError with stderr on failure.

    FFmpeg stderr is redirected to a Windows-path file so it survives WSL
    restarts (critical for diagnosing crashes) and avoids the 64KB pipe-buffer
    deadlock that can occur when capture_output=True is used with commands that
    produce large startup output (21-input xfade generates ~200KB of stream
    analysis before the first frame is encoded).
    """
    log.info("[ffmpeg] %s", " ".join(str(c) for c in cmd))
    stderr_path = "/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/ffmpeg-stderr-last.log"
    try:
        Path(stderr_path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        stderr_path = None  # fallback: don't redirect

    if stderr_path:
        with open(stderr_path, "w") as stderr_file:
            result = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=stderr_file)
    else:
        result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        stderr_tail = ""
        if stderr_path:
            try:
                with open(stderr_path) as f:
                    stderr_tail = f.read()[-4000:]
            except Exception:
                stderr_tail = "(could not read stderr log)"
        else:
            stderr_tail = getattr(result, "stderr", "")[-4000:] if result else ""
        raise RuntimeError(
            f"FFmpeg failed (exit {result.returncode}):\n"
            f"CMD: {' '.join(str(c) for c in cmd)}\n"
            f"STDERR: {stderr_tail}"
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


def log_av_sync(path: str | Path, label: str) -> None:
    """Log A/V stream duration, nb_frames, and r_frame_rate for sync debugging."""
    try:
        data = ffprobe_json(["-show_streams", str(path)])
        for s in data.get("streams", []):
            t = s.get("codec_type", "?")
            if t not in ("video", "audio"):
                continue
            log.info(
                "[sync-check] %s %s: start=%s dur=%s nb_frames=%s r_frame_rate=%s",
                label, t,
                s.get("start_time", "N/A"),
                s.get("duration", "N/A"),
                s.get("nb_frames", "N/A"),
                s.get("r_frame_rate", "N/A"),
            )
    except Exception as exc:
        log.warning("[sync-check] %s: ffprobe failed — %s", label, exc)


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
