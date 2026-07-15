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
    # RUSHCUT_LOG_DIR is set by run.py from manifest_path.parent (NTFS, zero
    # username dependency, same %TEMP%\rushcut dir the job log lives in).
    # Falls back to WSL tmpfs if unset (e.g. utils.py used outside run.py's
    # normal pipeline flow) -- won't survive a WSL restart, but won't crash.
    _log_dir = os.environ.get("RUSHCUT_LOG_DIR", "/tmp/rushcut")
    stderr_path = f"{_log_dir}/ffmpeg-stderr-last.log"
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


def ffmpeg_run_progress(cmd: list[str], on_tick=None, total_duration_s: float | None = None) -> None:
    """Run an FFmpeg command like ffmpeg_run(), but stream `-progress pipe:1`
    output and call on_tick(fraction: float) as frames encode (#119).

    Falls back to plain ffmpeg_run(cmd) when on_tick/total_duration_s aren't
    usable, and fails open on any read/parse problem -- this is a UX tick
    source only, never load-bearing for the render itself. Confirmed via
    #119 spike (2026-07-15) that `-progress` streams incrementally (not
    bursted at exit) on both native WSL ffmpeg and Windows ffmpeg.exe via
    the WSL interop bridge (the AMF encode path's binary).
    """
    if not on_tick or not total_duration_s or total_duration_s <= 0:
        ffmpeg_run(cmd)
        return

    tracked_cmd = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
    log.info("[ffmpeg] %s", " ".join(str(c) for c in tracked_cmd))
    _log_dir = os.environ.get("RUSHCUT_LOG_DIR", "/tmp/rushcut")
    stderr_path = f"{_log_dir}/ffmpeg-stderr-last.log"
    try:
        Path(stderr_path).parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        stderr_path = None

    try:
        stderr_file = open(stderr_path, "w") if stderr_path else subprocess.DEVNULL
        proc = subprocess.Popen(
            tracked_cmd, stdout=subprocess.PIPE, stderr=stderr_file, text=True, bufsize=1
        )
    except Exception:
        log.warning("[ffmpeg][#119] failed to start tracked encode, falling back to plain run", exc_info=True)
        if stderr_path and stderr_file not in (None, subprocess.DEVNULL):
            stderr_file.close()
        ffmpeg_run(cmd)
        return

    last_pct = -1
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("out_time_us="):
                continue
            try:
                out_us = int(line.split("=", 1)[1])
            except (ValueError, IndexError):
                continue  # e.g. "out_time_us=N/A" before the first frame
            frac = min(1.0, max(0.0, (out_us / 1_000_000.0) / total_duration_s))
            pct = int(frac * 100)
            if pct != last_pct:
                last_pct = pct
                try:
                    on_tick(frac)
                except Exception:
                    pass  # never let a UX tick failure break the encode
    except Exception:
        log.warning("[ffmpeg][#119] progress-tick read loop failed, encode continues", exc_info=True)
    finally:
        proc.stdout.close()
        returncode = proc.wait()
        if stderr_path:
            stderr_file.close()

    if returncode != 0:
        stderr_tail = ""
        if stderr_path:
            try:
                with open(stderr_path) as f:
                    stderr_tail = f.read()[-4000:]
            except Exception:
                stderr_tail = "(could not read stderr log)"
        raise RuntimeError(
            f"FFmpeg failed (exit {returncode}):\n"
            f"CMD: {' '.join(str(c) for c in tracked_cmd)}\n"
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
