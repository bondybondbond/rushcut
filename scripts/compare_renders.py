"""
Comparison renders: zoom-test project at 15M, 20M, 40M.
Run via: wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/scripts/compare_renders.py
"""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

# Patch sys.path so pipeline imports work
REPO = Path("/mnt/c/apps/rushcut")
sys.path.insert(0, str(REPO.parent))

TEMP = Path("/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut")
TEMP.mkdir(parents=True, exist_ok=True)

WIN_FFMPEG = (
    "C:\\Users\\Manasak\\AppData\\Local\\Microsoft\\WinGet\\Packages\\"
    "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\"
    "ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe"
)

CLIPS = [
    {
        "id": "276e8fb0-aa96-42de-a955-aa26daf70a89",
        "filename": "DJI_20250620171511_0020_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171511_0020_D.MP4",
        "duration_ms": 48681, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 32847, "out_ms": 47111,
        "focal_x": None, "focal_y": None, "zoom_mode": None,
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\3e222e0b44bf3c0d.mp4",
    },
    {
        "id": "3b11702e-6325-47d4-8812-0f2c899d1e64",
        "filename": "DJI_20250620171634_0021_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171634_0021_D.MP4",
        "duration_ms": 90890, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 4337, "out_ms": 31824,
        "focal_x": None, "focal_y": None, "zoom_mode": None,
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\daa832980d40db56.mp4",
    },
    {
        "id": "4866f3e7-7a16-40b1-80c2-26b51fe64286",
        "filename": "DJI_20250620171403_0019_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171403_0019_D.MP4",
        "duration_ms": 27794, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 5678, "out_ms": 20789,
        "focal_x": 0.513089005235602, "focal_y": 0.530541012216405, "zoom_mode": "kb_in_1.3_med",
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\4d9a6848fdd1c371.mp4",
    },
    {
        "id": "5f36b176-cde5-4e68-bb77-78dd0e06e32c",
        "filename": "DJI_20250620171511_0020_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171511_0020_D.MP4",
        "duration_ms": 48681, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 14722, "out_ms": 30818,
        "focal_x": 0.583767922455394, "focal_y": 0.371835443037975, "zoom_mode": "kb_in_1.5_fast",
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\3e222e0b44bf3c0d.mp4",
    },
    {
        "id": "08c84558-c774-4b01-ad1b-4c2fb66fa3dd",
        "filename": "DJI_20250620171634_0021_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171634_0021_D.MP4",
        "duration_ms": 90890, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 41475, "out_ms": 62304,
        "focal_x": None, "focal_y": None, "zoom_mode": "kb_out_2.0_slow",
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\daa832980d40db56.mp4",
    },
    {
        "id": "85cd39ba-6746-4218-aff0-aa499bb92fef",
        "filename": "DJI_20250620171511_0020_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171511_0020_D.MP4",
        "duration_ms": 48681, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 32847, "out_ms": 47111,
        "focal_x": 0.60067865437301, "focal_y": 0.485759493670886, "zoom_mode": "medium",
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\3e222e0b44bf3c0d.mp4",
    },
    {
        "id": "db894e41-de83-4bdb-b50e-61576026bfdf",
        "filename": "DJI_20250620171634_0021_D.MP4",
        "local_path": "C:\\clips\\DJI_20250620171634_0021_D.MP4",
        "duration_ms": 90890, "width": 3840, "height": 2160, "has_audio": True,
        "in_ms": 4337, "out_ms": 31824,
        "focal_x": 0.499214262867315, "focal_y": 0.455696202531646, "zoom_mode": "tight",
        "clip_volume": 1.0,
        "proxy_path": "C:\\Users\\Manasak\\AppData\\Roaming\\rushcut\\proxies\\daa832980d40db56.mp4",
    },
]

SETTINGS = {
    "music_mood": "none",
    "transition": "band_wipe",
    "opening_transition": "none",
    "closing_transition": "none",
    "shuffle_between": False,  # deterministic order for fair comparison
    "intro_text": "",
    "intro_subtitle": "",
    "intro_color": "#000000",
    "outro_text": "",
    "outro_color": "#000000",
    "zoom": False,  # per-clip zoom_mode handles it
    "filter_boring": True,
    "music_volume": "balanced",
    "output_resolution": "4k",
}

ENCODER_PY = REPO / "pipeline" / "encoder.py"


def patch_bitrate(bitrate: str):
    text = ENCODER_PY.read_text()
    import re
    patched = re.sub(r'FINAL_BITRATE\s*=\s*"[^"]+"', f'FINAL_BITRATE = "{bitrate}"', text)
    patched = re.sub(r'AMF_MAXRATE\s*=\s*"[^"]+"',
                     f'AMF_MAXRATE = "{_maxrate(bitrate)}"', patched)
    ENCODER_PY.write_text(patched)
    print(f"[compare] patched encoder.py FINAL_BITRATE={bitrate}", flush=True)


def _maxrate(bitrate: str) -> str:
    # 1.2x ceiling for vbr_peak
    n = int(bitrate.rstrip("M"))
    return f"{round(n * 1.2)}M"


def restore_bitrate():
    patch_bitrate("20M")  # U4e canonical default


def run_render(label: str, bitrate: str) -> bool:
    job_id = str(uuid.uuid4())
    output_win = f"C:\\clips\\processed\\zoom-compare-{label}-01.mp4"
    manifest = {
        "job_id": job_id,
        "clips": CLIPS,
        "settings": SETTINGS,
        "output_path": output_win,
        "win_ffmpeg_path": WIN_FFMPEG,
        "mode": "final",
    }
    manifest_win = f"C:\\Users\\Manasak\\AppData\\Local\\Temp\\rushcut\\compare-{label}.json"
    manifest_wsl = f"/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/compare-{label}.json"
    Path(manifest_wsl).write_text(json.dumps(manifest, indent=2))
    print(f"\n[compare] === Starting {label} render (job {job_id}) ===", flush=True)

    result = subprocess.run(
        ["python3", "/mnt/c/apps/rushcut/pipeline/run.py",
         "--job-id", job_id, "--manifest-path", manifest_wsl],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        text=True,
    )
    if result.returncode == 0:
        output_size_mb = Path(f"/mnt/c/clips/processed/zoom-compare-{label}-01.mp4").stat().st_size / 1_048_576
        print(f"[compare] {label} DONE: {output_win} ({output_size_mb:.1f} MB)", flush=True)
        return True
    else:
        print(f"[compare] {label} FAILED (exit {result.returncode})", flush=True)
        return False


RENDERS = [
    ("15m", "15M"),
    ("20m", "20M"),
    ("40m", "40M"),
]

if __name__ == "__main__":
    original = ENCODER_PY.read_text()
    try:
        for label, bitrate in RENDERS:
            patch_bitrate(bitrate)
            ok = run_render(label, bitrate)
            if not ok:
                print(f"[compare] Stopping after {label} failure", flush=True)
                break
    finally:
        # Always restore to 20M regardless of success/failure
        patch_bitrate("20M")
        print("\n[compare] encoder.py restored to FINAL_BITRATE=20M", flush=True)

    print("\n[compare] All comparison renders complete.", flush=True)
    print("Files in C:\\clips\\processed\\:", flush=True)
    for label, _ in RENDERS:
        p = Path(f"/mnt/c/clips/processed/zoom-compare-{label}-01.mp4")
        if p.exists():
            print(f"  zoom-compare-{label}-01.mp4  ({p.stat().st_size/1_048_576:.1f} MB)", flush=True)
