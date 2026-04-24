#!/usr/bin/env python3
"""
pipeline/proxy.py -- Generates H.264 720p proxy files per clip,
plus JPEG thumbnail and waveform PNG per clip.

Invoked by Rust generate_proxies_cmd via:
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/proxy.py \
      --manifest-path /mnt/c/Users/.../AppData/Local/Temp/rushcut/<project_id>-proxy.json

Manifest JSON:
  {
    "project_id": "<uuid>",
    "proxy_dir": "/mnt/c/Users/.../AppData/Roaming/rushcut/proxies",
    "clips": [
      {
        "id": "<uuid>",
        "local_path": "C:\\path\\to\\clip.MP4",
        "needs_thumbnail": true,
        "needs_waveform": true
      }
    ]
  }

Stdout protocol:
  PROXY:clip_id=<id>,win_path=<win_path>      -- one proxy completed
  THUMBNAIL_DONE:clip_id=<id>,data=<base64>   -- JPEG thumbnail as raw base64
  WAVEFORM_DONE:clip_id=<id>,data=<base64>    -- waveform PNG as raw base64
  PROGRESS:<n>                                -- overall percent (0-100)
  DONE:                                       -- all clips processed
  ERROR:<msg>                                 -- catastrophic failure only
"""
import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

THUMB_DIR = "/tmp/rushcut-thumbs"


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


def is_valid_proxy(proxy_wsl: str) -> bool:
    """
    Return True if proxy_wsl is a valid, complete MP4 (moov atom present).
    Files with a missing moov atom (FFmpeg killed mid-write) return False
    and will be re-encoded on the next proxy run.
    """
    try:
        result = subprocess.run(
            ["/usr/bin/ffprobe", "-v", "quiet", "-show_format", proxy_wsl],
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def generate_proxy(src_wsl: str, proxy_wsl: str) -> bool:
    """
    Encode a 480p H.264 proxy from src_wsl -> proxy_wsl.
    Returns True on success, False on failure.
    Uses -map 0:v:0 to skip DJI embedded MJPEG thumbnail stream.
    Audio is stream-copied (not re-encoded) -- proxies are for scrubbing only.
    -preset ultrafast: ~4x faster than default medium; quality irrelevant for proxies.
    480p (vs 720p) halves pixel count -> further speedup with no UX loss at scrubbing size.
    """
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-i", src_wsl,
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "28",
                "-vf", "scale=-2:480",
                "-c:a", "copy",
                "-y",
                proxy_wsl,
            ],
            capture_output=True,
            timeout=600,  # 10 min ceiling: 4K HEVC software decode at 480p ultrafast
        )
        return result.returncode == 0
    except Exception as e:
        print(f"[proxy] ffmpeg exception for {src_wsl}: {e}", file=sys.stderr)
        return False


def extract_thumbnail(src_wsl: str, clip_id: str) -> str | None:
    """
    Extract a JPEG frame at 1s seek, return full data URI string or None.
    Returns "data:image/jpeg;base64,..." so callers can use src= directly.
    1s seek is safe for clips < 2s.
    """
    tmp = f"{THUMB_DIR}/{clip_id}.jpg"
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-ss", "1",
                "-i", src_wsl,
                "-map", "0:v:0",
                "-vframes", "1",
                "-q:v", "5",
                "-y", tmp,
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0 or not Path(tmp).exists():
            return None
        with open(tmp, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
            return f"data:image/jpeg;base64,{b64}"
    except Exception as e:
        print(f"[proxy] thumbnail exception for {clip_id}: {e}", file=sys.stderr)
        return None


def extract_waveform(src_wsl: str, clip_id: str) -> str | None:
    """
    Render a waveform PNG for TrimBar display, return full data URI or None.
    s=120x80: 120 horizontal samples stretched to fill the TrimBar gives ~6px-wide bars
              — discrete bar-chart appearance rather than a smeared waveform.
    colors=0x22c55e: design-system green, visible on dark background via screen blend.
    scale=cbrt: cube-root compression — speech/shouting amplitude fills bars to near full height.
    Returns "data:image/png;base64,..." so callers can use src= directly.
    """
    tmp = f"{THUMB_DIR}/{clip_id}-wave.png"
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-i", src_wsl,
                "-filter_complex", "showwavespic=s=120x80:colors=0x22c55e:scale=cbrt",
                "-frames:v", "1",
                "-y", tmp,
            ],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0 or not Path(tmp).exists():
            return None
        with open(tmp, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
            return f"data:image/png;base64,{b64}"
    except Exception as e:
        print(f"[proxy] waveform exception for {clip_id}: {e}", file=sys.stderr)
        return None


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

    # Ensure proxy and thumbnail temp directories exist
    try:
        Path(proxy_dir).mkdir(parents=True, exist_ok=True)
        Path(THUMB_DIR).mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"ERROR:Cannot create directories: {e}", flush=True)
        sys.exit(1)

    total = len(clips)
    if total == 0:
        print("DONE:", flush=True)
        return

    for done, clip in enumerate(clips):
        clip_id = clip.get("id", "")
        local_path = clip.get("local_path", "")
        needs_thumbnail = clip.get("needs_thumbnail", True)
        needs_waveform = clip.get("needs_waveform", True)

        if not clip_id or not local_path:
            print(f"[proxy] Skipping clip with missing id or local_path", file=sys.stderr)
            pct = int((done + 1) / total * 100)
            print(f"PROGRESS:{pct}", flush=True)
            continue

        src_wsl = win_to_wsl(local_path)
        proxy_wsl = f"{proxy_dir}/{clip_id}.mp4"
        win_path = wsl_to_win(proxy_wsl)

        # Step 1: Thumbnail from SOURCE immediately — do NOT wait for proxy.
        # HEVC -ss 1 -vframes 1 takes ~2s per clip vs 30-60s for a proxy encode.
        # Thumbnails appear for all clips within ~10s of Trimmer load.
        if needs_thumbnail:
            data = extract_thumbnail(src_wsl, clip_id)
            if data:
                print(f"THUMBNAIL_DONE:clip_id={clip_id},data={data}", flush=True)

        # Step 2: Waveform from SOURCE immediately (audio decode is fast for HEVC).
        if needs_waveform:
            data = extract_waveform(src_wsl, clip_id)
            if data:
                print(f"WAVEFORM_DONE:clip_id={clip_id},data={data}", flush=True)

        # Step 3: Proxy encode (slow — 30-60s per clip). Proxy enables smooth H.264 scrubbing.
        # Runs last so thumbnail/waveform are never blocked behind encode time.
        # Validate existing proxies — a missing moov atom (FFmpeg killed mid-write) means
        # the file is corrupt; delete it so it gets re-encoded cleanly.
        if Path(proxy_wsl).exists() and not is_valid_proxy(proxy_wsl):
            print(f"[proxy] corrupt proxy detected, re-encoding: {proxy_wsl}", file=sys.stderr)
            Path(proxy_wsl).unlink(missing_ok=True)
        if Path(proxy_wsl).exists():
            print(f"PROXY:clip_id={clip_id},win_path={win_path}", flush=True)
        else:
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
