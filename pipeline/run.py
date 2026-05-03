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
  STAGE:<human-readable stage name>
  ANALYSIS:clips_used=N,clips_total=M,clips_excluded=X
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
# Mirror all logs to a fixed file so tooling can read them after a render
_log_file = logging.FileHandler("/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/pipeline-latest.log", mode="w")
_log_file.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
logging.getLogger().addHandler(_log_file)


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


def on_analysis(data: str) -> None:
    print(f"ANALYSIS:{data}", flush=True)


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
            "transition": settings.get("transition", "crossfade"),  # log: confirmed received
            "silence_removal": settings.get("silence_removal", False),
            "intro_color": settings.get("intro_color", "#000000"),
            "intro_text": intro_text,
            "outro_color": settings.get("outro_color", "#000000"),
            "outro_text": outro_text,
            # music_volume is a preset string ("subtle"/"balanced"/"prominent").
            # Legacy numeric values (e.g. 40 from old saved projects) fall back to "balanced" (0.4).
            "music_volume": {"subtle": 0.2, "balanced": 0.4, "prominent": 0.7}.get(
                settings.get("music_volume", "balanced"), 0.4
            ),
            "max_clips": settings.get("max_clips", 20),
            "target_clip_dur": settings.get("target_clip_dur", 5.0),
            "output_resolution": settings.get("output_resolution", "1080p"),
            "custom_music_path": win_to_wsl(settings["custom_music_path"])
                if settings.get("custom_music_path") else None,
        },
    }

    print(f"[run.py] transition={job['config']['transition']}", flush=True)

    # Resolve WSL2 paths from local_path (stored as Windows paths in DB)
    clip_paths = [Path(win_to_wsl(c["local_path"])) for c in clips]

    # Ensure output directory exists
    output_wsl = Path(win_to_wsl(output_path_win))
    output_wsl.parent.mkdir(parents=True, exist_ok=True)

    try:
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from pipeline.render import run_pipeline

        tmp_output = run_pipeline(job, clips, clip_paths, on_progress=on_progress, on_stage=on_stage, on_analysis=on_analysis)

        shutil.copy2(str(tmp_output), str(output_wsl))
        # Clean up WSL2 /tmp/<job_id>/ — intermediates are no longer needed after copy.
        # This frees 1-3 GB per render from the WSL2 tmpfs immediately.
        shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)
        print(f"DONE:{output_wsl}", flush=True)
    except Exception as e:
        print(f"ERROR:{e}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
