#!/usr/bin/env python3
"""
pipeline/proxy.py -- Generates proxy files per clip plus JPEG thumbnail and waveform PNG.

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
  PROXY:clip_id=<id>,win_path=<win_path>      -- proxy ready (may be the source path for H.264 clips)
  THUMBNAIL_DONE:clip_id=<id>,data=<base64>   -- JPEG thumbnail as raw base64
  WAVEFORM_DONE:clip_id=<id>,data=<base64>    -- waveform PNG as raw base64
  PROGRESS:<n>                                -- overall percent (0-100)
  DONE:                                       -- all clips processed
  ERROR:<msg>                                 -- catastrophic failure only

Codec strategy:
  H.264 / VP8 / VP9 sources: WebView2 decodes natively -- emit PROXY with source path immediately.
  HEVC / unknown: transcode to 480p H.264 proxy (30-60s per clip, software decode ceiling).
"""
import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

THUMB_DIR = "/tmp/rushcut-thumbs"

# Codecs WebView2 can decode natively on Windows without any extension.
# h264: always. vp8/vp9: via WebM container. hevc: requires paid extension (NOT guaranteed).
WEBVIEW2_NATIVE_CODECS = {"h264", "vp8", "vp9"}


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


def get_video_codec(src_wsl: str) -> str | None:
    """
    Return the primary video stream codec name (e.g. 'hevc', 'h264') or None on failure.
    Used to skip proxy transcode for WebView2-native codecs.
    """
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffprobe",
                "-v", "quiet",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name",
                "-of", "csv=p=0",
                src_wsl,
            ],
            capture_output=True,
            timeout=10,
        )
        codec = result.stdout.decode("utf-8", errors="replace").strip()
        return codec if codec else None
    except Exception:
        return None


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


def get_peak_volume_db(src_wsl: str) -> float:
    """
    Return the peak volume in dB (e.g. -12.3 means 12.3 dB below full scale).
    Used to normalise audio before waveform extraction so the loudest peak
    reaches 0 dBFS = full height in showwavespic.
    Returns 0.0 on any failure (no boost applied, safe fallback).
    """
    try:
        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-i", src_wsl,
                "-filter:a", "volumedetect",
                "-vn",
                "-f", "null",
                "/dev/null",
            ],
            capture_output=True,
            timeout=30,
        )
        # volumedetect writes to stderr in format: "  max_volume: -12.3 dB"
        output = result.stderr.decode("utf-8", errors="replace")
        for line in output.split("\n"):
            if "max_volume" in line:
                try:
                    return float(line.split("max_volume:")[1].strip().split()[0])
                except (IndexError, ValueError):
                    pass
    except Exception:
        pass
    return 0.0


def extract_waveform(src_wsl: str, clip_id: str) -> str | None:
    """
    Render a volume-normalised waveform PNG for TrimBar display.

    Two-pass approach:
      Pass 1: volumedetect -- find peak volume (e.g. -14 dB).
      Pass 2: boost by -peak (e.g. +14 dB) so the loudest moment = 0 dBFS = full bar height.

    Parameters:
      s=800x80:   800 samples wide -- fills an 800px TrimBar at ~1px per sample, no blurring.
      colors=0x22c55e: design-system green.
      scale=cbrt: perceptual cube-root compression.
                  - Silence       -> ~0% height
                  - Quiet speech  -> ~40% height
                  - Normal speech -> ~60% height
                  - Loud peaks    -> ~100% height
                  cbrt gives the DaVinci-style "mountain silhouette" look.
                  (lin was used before: DJI audio at -14 dBFS reached only 5% height -- tiny blobs.)

    Returns "data:image/png;base64,..." or None.
    """
    tmp = f"{THUMB_DIR}/{clip_id}-wave.png"
    try:
        peak_db = get_peak_volume_db(src_wsl)
        # Boost so max peak = 0 dBFS. Cap at 40 dB to avoid over-amplifying near-silent clips.
        boost_db = max(0.0, min(-peak_db, 40.0))

        result = subprocess.run(
            [
                "/usr/bin/ffmpeg",
                "-i", src_wsl,
                "-filter_complex",
                f"[0:a]volume={boost_db:.1f}dB,showwavespic=s=800x80:colors=0x22c55e:scale=cbrt",
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

        # Step 1: Thumbnail from SOURCE immediately -- fast (~2s), never blocked behind encode.
        if needs_thumbnail:
            data = extract_thumbnail(src_wsl, clip_id)
            if data:
                print(f"THUMBNAIL_DONE:clip_id={clip_id},data={data}", flush=True)

        # Step 2: Waveform with volume normalisation (volumedetect + showwavespic, ~3-5s).
        if needs_waveform:
            data = extract_waveform(src_wsl, clip_id)
            if data:
                print(f"WAVEFORM_DONE:clip_id={clip_id},data={data}", flush=True)

        # Step 3: Proxy -- codec-aware.
        #
        # H.264 / VP8 / VP9: WebView2 decodes natively. Use the source file directly
        # as the "proxy" -- zero transcode time, immediate play in Trimmer.
        #
        # HEVC / unknown: generate a 480p H.264 proxy (30-60s software decode of 4K HEVC
        # is unavoidable without GPU acceleration, which WSL2 does not support).
        # is_valid_proxy() guards against corrupt partial files (missing moov atom).
        codec = get_video_codec(src_wsl)
        if codec in WEBVIEW2_NATIVE_CODECS:
            print(f"[proxy] {codec} source -- WebView2 native, using source as proxy", file=sys.stderr)
            print(f"PROXY:clip_id={clip_id},win_path={local_path}", flush=True)
        else:
            print(f"[proxy] {codec or 'unknown'} source -- generating H.264 proxy", file=sys.stderr)
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
