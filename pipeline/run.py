#!/usr/bin/env python3
"""
pipeline/run.py -- CLI entry point invoked by Rust via:
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py \
      --job-id <uuid> --manifest-path <wsl_path>

Manifest JSON (written to %TEMP%\rushcut\<job_id>.json by Rust, passed as WSL path):
  {
    "job_id": "...",
    "clips": [{"id":..., "filename":..., "local_path":"C:\\...", "duration_ms":...,
               "width":..., "height":..., "has_audio":...}],
    "settings": {"music_mood":"cinematic","intro_text":"","outro_text":"","zoom":true},
    "output_path": "C:\\clips\\processed\\<job_id>.mp4"
  }

Protocol (stdout, line-by-line):
  PROGRESS:<0-100>
  DONE:<wsl_path_to_output>
  ERROR:<message>
"""
import argparse
import json
import logging
import shutil
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")


def win_to_wsl(path: str) -> str:
    """Convert a Windows path to a WSL2 /mnt/... path.

    e.g.  C:\\clips\\foo.mp4  ->  /mnt/c/clips/foo.mp4
    """
    p = path.replace("\\", "/")
    if len(p) >= 2 and p[1] == ":":
        drive = p[0].lower()
        rest = p[2:].lstrip("/")
        return f"/mnt/{drive}/{rest}"
    return p


def on_progress(pct: int) -> None:
    print(f"PROGRESS:{pct}", flush=True)


def on_stage(stage: str) -> None:
    print(f"STAGE:{stage}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--manifest-path", required=True, help="WSL path to manifest JSON")
    args = parser.parse_args()

    manifest_path = Path(args.manifest_path)
    if not manifest_path.exists():
        print(f"ERROR:Manifest not found: {manifest_path}", flush=True)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    job_id = manifest["job_id"]
    clips = manifest["clips"]
    settings = manifest.get("settings", {})
    output_path_win = manifest.get("output_path", f"C:\\clips\\processed\\{job_id}.mp4")

    intro_text = settings.get("intro_text", "")
    outro_text = settings.get("outro_text", "")

    # Build job dict with nested config matching render.py expectations
    job = {
        "id": job_id,
        "mode": "final",
        "config": {
            "music_mood": settings.get("music_mood", "none"),
            "zoom": settings.get("zoom", False),
            "filter_boring": settings.get("filter_boring", False),
            "transition": settings.get("transition", "crossfade"),
            "silence_removal": settings.get("silence_removal", False),
            "intro_color": settings.get("intro_color", "#000000"),
            "intro_text": intro_text,
            "outro_color": settings.get("outro_color", "#000000"),
            "outro_text": outro_text,
        },
    }

    # Resolve WSL2 paths from local_path (stored as Windows paths in DB)
    clip_paths = [Path(win_to_wsl(c["local_path"])) for c in clips]

    # Ensure output directory exists
    output_wsl = Path(win_to_wsl(output_path_win))
    output_wsl.parent.mkdir(parents=True, exist_ok=True)

    try:
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from pipeline.render import run_pipeline

        tmp_output = run_pipeline(job, clips, clip_paths, on_progress=on_progress, on_stage=on_stage)

        shutil.copy2(str(tmp_output), str(output_wsl))
        print(f"DONE:{output_wsl}", flush=True)
    except Exception as e:
        print(f"ERROR:{e}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
