#!/usr/bin/env python3
"""
pipeline/proxy.py -- Generates H.264 720p proxy files per clip.

Invoked by Rust generate_proxies_cmd via:
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/proxy.py \
      --manifest-path /mnt/c/Users/.../AppData/Local/Temp/rushcut/<project_id>-proxy.json

Manifest JSON:
  {
    "project_id": "<uuid>",
    "proxy_dir": "/mnt/c/Users/.../AppData/Roaming/rushcut/proxies",
    "clips": [{"id": "<uuid>", "local_path": "C:\\path\\to\\clip.MP4"}]
  }

Stdout protocol:
  PROXY:clip_id=<id>,win_path=<win_path>  -- one proxy completed
  PROGRESS:<n>                             -- overall percent (0-100)
  DONE:                                    -- all clips processed
  ERROR:<msg>                              -- catastrophic failure only
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def win_to_wsl(path: str) -> str:
    """Convert a Windows C:\\... path to a WSL /mnt/c/... path."""
    if len(path) >= 2 and path[1] == ":":
        drive = path[0].lower()
        rest = path[2:].replace("\\", "/")
        return f"/mnt/{drive}{rest}"
    return path


def wsl_to_win(path: str) -> str:
    """Convert a WSL /mnt/c/... path to a Windows C:\\... path."""
    if path.startswith("/mnt/"):
        parts = path[5:]
        if parts:
            drive = parts[0].upper()
            rest = parts[1:].replace("/", "\\")
            return f"{drive}:{rest}"
    return path


def generate_proxy(src_wsl: str, proxy_wsl: str) -> bool:
    """
    Encode a 720p H.264 proxy from src_wsl -> proxy_wsl.
    Returns True on success, False on failure.
    Uses -map 0:v:0 to skip DJI embedded MJPEG thumbnail stream.
    Audio is stream-copied (not re-encoded) -- proxies are for playback only,
    so re-encoding to AAC 48kHz wastes CPU for zero quality benefit here.
    """
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-i", src_wsl,
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-c:v", "libx264",
                "-crf", "28",
                "-vf", "scale=-2:720",
                "-c:a", "copy",
                "-y",
                proxy_wsl,
            ],
            capture_output=True,
            timeout=120,
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[proxy] ffmpeg exception for {src_wsl}: {e}", file=sys.stderr)
        return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest-path", required=True, help="WSL path to proxy manifest JSON")
    args = parser.parse_args()

    try:
        with open(args.manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:
        print(f"ERROR:Failed to read manifest: {e}", flush=True)
        sys.exit(1)

    proxy_dir = manifest.get("proxy_dir", "")
    clips = manifest.get("clips", [])

    if not proxy_dir:
        print("ERROR:proxy_dir missing from manifest", flush=True)
        sys.exit(1)

    # Ensure proxy directory exists
    try:
        Path(proxy_dir).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"ERROR:Cannot create proxy dir {proxy_dir}: {e}", flush=True)
        sys.exit(1)

    total = len(clips)
    if total == 0:
        print("DONE:", flush=True)
        return

    for done, clip in enumerate(clips):
        clip_id = clip.get("id", "")
        local_path = clip.get("local_path", "")

        if not clip_id or not local_path:
            print(f"[proxy] Skipping clip with missing id or local_path", file=sys.stderr)
            pct = int((done + 1) / total * 100)
            print(f"PROGRESS:{pct}", flush=True)
            continue

        src_wsl = win_to_wsl(local_path)
        proxy_wsl = f"{proxy_dir}/{clip_id}.mp4"
        win_path = wsl_to_win(proxy_wsl)

        # Skip if proxy already exists
        if Path(proxy_wsl).exists():
            print(f"PROXY:clip_id={clip_id},win_path={win_path}", flush=True)
            pct = int((done + 1) / total * 100)
            print(f"PROGRESS:{pct}", flush=True)
            continue

        ok = generate_proxy(src_wsl, proxy_wsl)
        if ok:
            print(f"PROXY:clip_id={clip_id},win_path={win_path}", flush=True)
        else:
            print(f"[proxy] WARNING: proxy failed for {local_path}, skipping", file=sys.stderr)

        pct = int((done + 1) / total * 100)
        print(f"PROGRESS:{pct}", flush=True)

    print("DONE:", flush=True)


if __name__ == "__main__":
    main()
