#!/usr/bin/env python3
"""
pipeline/scan.py -- Scans a folder for video clips and returns metadata JSON.

Invoked by Rust scan_folder command via:
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/scan.py \
      --folder /mnt/c/clips/

Stdout: JSON array of clip metadata.
  local_path is returned as a Windows path (e.g. C:\clips\DJI_01.MP4)
  so the Rust/React layer never needs to handle WSL paths.

Each element:
  {
    "filename": "DJI_01.MP4",
    "local_path": "C:\\clips\\DJI_01.MP4",
    "size_bytes": 1234567,
    "duration_ms": 12345,
    "width": 1920,
    "height": 1080,
    "has_audio": true
  }
"""
import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path


VIDEO_EXTS = {".mp4", ".MP4", ".mov", ".MOV", ".mkv", ".MKV"}


def wsl_to_win(path: str) -> str:
    """Convert a WSL /mnt/c/... path to a Windows C:\... path."""
    if path.startswith("/mnt/"):
        parts = path[5:]  # strip "/mnt/"
        if parts and len(parts) >= 1:
            drive = parts[0].upper()
            rest = parts[1:].replace("/", "\\")
            return f"{drive}:{rest}"
    return path


def probe_file(wsl_path: str) -> dict:
    """Run ffprobe on a file and extract video stream metadata."""
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffprobe",
                "-v", "quiet",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,duration",
                "-show_entries", "format=duration,size",
                "-of", "json",
                wsl_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return {}

        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        fmt = data.get("format", {})

        width = 0
        height = 0
        duration_s = 0.0

        if streams:
            s = streams[0]
            width = int(s.get("width", 0))
            height = int(s.get("height", 0))
            if s.get("duration"):
                duration_s = float(s["duration"])

        # Fall back to format-level duration if stream-level missing
        if duration_s == 0.0 and fmt.get("duration"):
            duration_s = float(fmt["duration"])

        size_bytes = int(fmt.get("size", 0))

        return {
            "width": width,
            "height": height,
            "duration_ms": int(duration_s * 1000),
            "size_bytes": size_bytes,
        }
    except Exception:
        return {}


def has_audio_stream(wsl_path: str) -> bool:
    """Check if the file has at least one audio stream."""
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffprobe",
                "-v", "quiet",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_type",
                "-of", "json",
                wsl_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return False
        data = json.loads(result.stdout)
        return len(data.get("streams", [])) > 0
    except Exception:
        return False


def extract_thumbnail(wsl_path: str) -> str | None:
    """
    Extract first frame as a small base64 JPEG (320px wide, quality 5).
    Uses -map 0:v:0 to skip DJI's embedded MJPEG thumbnail in stream 1.
    Returns a data URI string, or None on failure.
    """
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-ss", "0",
                "-i", wsl_path,
                "-map", "0:v:0",
                "-frames:v", "1",
                "-q:v", "5",
                "-vf", "scale=320:-1",
                "-f", "image2pipe",
                "-vcodec", "mjpeg",
                "-",
            ],
            capture_output=True,
            timeout=10,
        )
        if result.returncode != 0 or not result.stdout:
            return None
        encoded = base64.b64encode(result.stdout).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", required=True, help="WSL path to folder to scan")
    args = parser.parse_args()

    folder = Path(args.folder)
    if not folder.exists() or not folder.is_dir():
        print(f"[]", flush=True)  # empty array, not an error
        sys.exit(0)

    clips = []
    for f in sorted(folder.iterdir()):
        if f.is_file() and f.suffix in VIDEO_EXTS:
            wsl_path = str(f)
            win_path = wsl_to_win(wsl_path)

            meta = probe_file(wsl_path)
            audio = has_audio_stream(wsl_path)
            thumbnail = extract_thumbnail(wsl_path)

            clips.append({
                "filename": f.name,
                "local_path": win_path,
                "size_bytes": meta.get("size_bytes", f.stat().st_size),
                "duration_ms": meta.get("duration_ms", 0),
                "width": meta.get("width", 0),
                "height": meta.get("height", 0),
                "has_audio": audio,
                "thumbnail_data": thumbnail,
            })

    print(json.dumps(clips), flush=True)


if __name__ == "__main__":
    main()
