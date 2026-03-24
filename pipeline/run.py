#!/usr/bin/env python3
"""
pipeline/run.py — CLI entry point invoked by Rust via:
  wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py \
      --job-id <uuid> --clips-json <base64_json>

Protocol (stdout, line-by-line):
  PROGRESS:<0-100>
  DONE:<wsl_path_to_output>
  ERROR:<message>
"""
import argparse
import base64
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--clips-json", required=True)
    args = parser.parse_args()

    payload = json.loads(base64.b64decode(args.clips_json))
    job = payload["job"]
    clips = payload["clips"]

    # Resolve WSL2 paths from local_path (stored as Windows paths in DB)
    clip_paths = [Path(win_to_wsl(c["local_path"])) for c in clips]

    # Ensure output directory exists
    output_dir = Path("/mnt/c/clips/processed")
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        # pipeline/ is in sys.path by default when running from this directory
        sys.path.insert(0, str(Path(__file__).parent))
        from render import run_pipeline

        tmp_output = run_pipeline(job, clips, clip_paths, on_progress=on_progress)

        # Copy from /tmp/<jobId>/... to final destination
        dest = output_dir / f"{args.job_id}.mp4"
        shutil.copy2(str(tmp_output), str(dest))

        print(f"DONE:{dest}", flush=True)
    except Exception as e:
        print(f"ERROR:{e}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
