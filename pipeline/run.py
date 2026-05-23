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
import datetime
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


_analysis_buf: list = []

def on_analysis(data: str) -> None:
    _analysis_buf.append(data)
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

    # Per-job log (safe with concurrent runs) + symlink as pipeline-latest.log.
    _log_dir = Path("/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut")
    _log_dir.mkdir(parents=True, exist_ok=True)
    _fmt = logging.Formatter("[%(levelname)s] %(message)s")
    _job_log = logging.FileHandler(_log_dir / f"pipeline-{job_id}.log", mode="w")
    _job_log.setFormatter(_fmt)
    logging.getLogger().addHandler(_job_log)
    # Overwrite pipeline-latest.log to point at this job (best-effort).
    try:
        latest = _log_dir / "pipeline-latest.log"
        latest.unlink(missing_ok=True)
        latest.symlink_to(f"pipeline-{job_id}.log")
    except OSError:
        _latest_fh = logging.FileHandler(_log_dir / "pipeline-latest.log", mode="w")
        _latest_fh.setFormatter(_fmt)
        logging.getLogger().addHandler(_latest_fh)

    clips = manifest["clips"]
    settings = manifest.get("settings", {})
    output_path_win = manifest.get("output_path", f"C:\\clips\\processed\\{job_id}.mp4")

    intro_text = settings.get("intro_text", "")
    outro_text = settings.get("outro_text", "")

    # Build job dict with nested config matching render.py expectations
    job = {
        "id": job_id,
        "mode": manifest.get("mode", "final"),
        "config": {
            "music_mood": settings.get("music_mood", "none"),
            "zoom": settings.get("zoom", False),
            "transition": settings.get("transition", "none"),          # M2: between-clips type
            "opening_transition": settings.get("opening_transition", "none"),
            "closing_transition": settings.get("closing_transition", "none"),
            "shuffle_between": settings.get("shuffle_between", False),
            "silence_removal": settings.get("silence_removal", False),
            "intro_color": settings.get("intro_color", "#000000"),
            "intro_text": intro_text,
            "intro_subtitle": settings.get("intro_subtitle", ""),
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
            # music_fade_out_s: seconds for music fade-out (0 = no fade, from UI chips none/2s/5s).
            "music_fade_out_s": {"none": 0.0, "2s": 2.0, "5s": 5.0}.get(
                settings.get("music_fade_out", "2s"), 2.0
            ),
            # Batch Q: Windows ffmpeg.exe path for h264_amf GPU encode (Step 5).
            # Resolved in Rust via where.exe; "" means fallback to libx264.
            "win_ffmpeg_path": manifest.get("win_ffmpeg_path", ""),
        },
    }

    print(
        f"[run.py] transition={job['config']['transition']} "
        f"shuffle={job['config']['shuffle_between']} "
        f"opening={job['config']['opening_transition']} "
        f"closing={job['config']['closing_transition']}",
        flush=True,
    )

    # Resolve WSL2 paths from local_path (stored as Windows paths in DB)
    clip_paths = [Path(win_to_wsl(c["local_path"])) for c in clips]

    # Enrich clip dicts with WSL proxy path so render.py can use proxies as normalise skip.
    # proxy_path is a Windows path (or null) — convert to WSL for Python pipeline use.
    for c in clips:
        c["proxy_path_wsl"] = win_to_wsl(c["proxy_path"]) if c.get("proxy_path") else None

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

        # Timing log — skip for draft/preview runs to avoid polluting benchmark data
        if manifest.get("mode", "final") != "draft":
            try:
                _a = {}
                if _analysis_buf:
                    for kv in _analysis_buf[0].split(","):
                        if "=" in kv:
                            k, v = kv.split("=", 1)
                            _a[k.strip()] = v.strip()

                output_mb = output_wsl.stat().st_size / (1024 * 1024) if output_wsl.exists() else 0

                record = {
                    "ts":              datetime.datetime.utcnow().isoformat() + "Z",
                    "instance":        manifest.get("instance", "unknown"),
                    "clips_used":      int(_a.get("clips_used", 0)),
                    "clips_total":     int(_a.get("clips_total", 0)),
                    "film_s":          float(_a.get("output_duration_s", 0)),
                    "raw_s":           float(_a.get("raw_duration_s", 0)),
                    "resolution":      settings.get("output_resolution", "1080p"),
                    "has_4k_source":   bool(int(_a.get("has_4k", 0))),
                    "proxy_used":      int(_a.get("proxy_used", 0)),
                    "proxy_skipped":   int(_a.get("proxy_skipped", 0)),
                    "transition":      settings.get("transition", "none"),
                    "music":           settings.get("music_mood", "none"),
                    "zoom":            bool(settings.get("zoom", False)),
                    "volume_custom":   bool(int(_a.get("volume_custom", 0))),
                    "t_normalise_s":   float(_a.get("normalise_s", 0)),
                    "t_trim_s":        float(_a.get("trim_s", 0)),
                    "t_zoom_s":        float(_a.get("zoom_s", 0)),
                    "zoom_cache_hits": int(_a.get("zoom_cache_hits", 0)),
                    "t_render_s":      float(_a.get("render_s", 0)),
                    "t_music_s":       float(_a.get("music_s", 0)),
                    "t_loudnorm_s":    float(_a.get("loudnorm_s", 0)),
                    "t_total_s":       float(_a.get("total_s", 0)),
                    "output_mb":       round(output_mb, 1),
                    "encoder":         _a.get("encoder", "libx264"),
                }
                timing_log = manifest_path.parent / "render-timing-log.jsonl"
                with open(timing_log, "a") as f:
                    f.write(json.dumps(record) + "\n")
            except Exception as log_err:
                logging.warning("[run.py] timing log write failed: %s", log_err)

        print(f"DONE:{output_wsl}", flush=True)
    except Exception as e:
        print(f"ERROR:{e}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
