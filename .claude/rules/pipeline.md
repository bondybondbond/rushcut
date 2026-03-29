# Pipeline — invocation & FFmpeg rules

Applies when working on `pipeline/**`, `src-tauri/src/lib.rs` (pipeline spawn), or `src/pages/Output.tsx`.

## Invocation

```
wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py --job-id <uuid> --manifest-path <wsl_path>
```

Manifest JSON written to `%TEMP%\rushcut\<job_id>.json` by Rust. Contains clips array + settings + output_path.

Folder scan: `wsl -d Ubuntu-24.04 -u root -- python3 .../scan.py --folder <wsl_path>`
File scan:   `wsl -d Ubuntu-24.04 -u root -- python3 .../scan.py --files <path1> <path2> ...`

Progress stdout: `STAGE:name` · `PROGRESS:N` · `DONE:/mnt/c/...` · `ERROR:msg` · `ANALYSIS:key=val,...`

`ANALYSIS:` lines carry structured metadata (e.g. `clips_used=15,clips_total=20,clips_excluded=5`). Rust parses these and stores in `jobs.analysis_summary`. Emit once at end of pipeline run.

## Output path

Written to `C:\clips\processed\<slug>-01.mp4`, `<slug>-02.mp4` etc. Slug = `slugify(project.name)` (Rust). Counter = per-project sequential count of existing output files matching `<slug>-NN.mp4`. Changed from UUID suffix in Batch 13b.

## Python pitfalls

- **Relative imports:** `run.py` inserts the *parent* of `pipeline/` into `sys.path` and imports as `from pipeline.render import run_pipeline`. Never insert `pipeline/` itself — breaks all relative imports.
- **PowerShell `Out-File` writes UTF-8 BOM:** Python `json.loads()` raises `JSONDecodeError`. Write manifests via WSL or Python only.
- **Windows path to WSL:** `C:\clips\DJI_01.MP4` → `/mnt/c/clips/DJI_01.MP4`.
- **`run.py` config completeness:** Every `JobConfig` field needs `settings.get(key, safe_default)`. Missing fields silently use wrong defaults.

## FFmpeg rules

- **DJI Osmo Pocket 3:** Two video streams — use `-map 0:v:0` (HEVC real clip). Stream 1 is an embedded MJPEG thumbnail.
- **Portrait clips:** 1728×3072 normalises to 608×1080 via `scale=-2:1080`. Correct — do not "fix" orientation.
- **Encoding:** Always `-c:v libx264 -pix_fmt yuv420p -profile:v main`. Omitting allows silent HEVC fallback (Windows Media Player rejects HEVC).
- **xfade name:** `xfade=transition=fade` (NOT `crossfade`). Dip-to-black = `xfade=transition=fadeblack`.
- **scale inside filter_complex:** Never mix `-vf` and `-filter_complex` on the same output stream.
- **xfade_dur clamp:** `transitions.py` clamps to `min(1.5, min_clip_dur / 2.0)`. Do not remove — prevents short clips (e.g. 3s cards) from being consumed.
- **`-map 0:a:0?` not `-map 0:a?`** — DJI clips can contain multiple audio streams.
- **Audio concat for 3+ clips:** Use `concat=n=N:v=0:a=1` + `atrim`/`asetpts`. Pairwise `acrossfade` for N>2 produces misaligned overlaps.
- **`-ar 48000` at every re-encode site:** DJI records at 96kHz; force 48kHz at normalise, inject_silence, single-clip render, multi-clip render, music mix, and loudnorm. One missing site means 96kHz leaks into the output.
- **music_volume is now a string union:** `"subtle" | "balanced" | "prominent"`. `run.py` maps to floats `{subtle: 0.2, balanced: 0.4, prominent: 0.7}`. The old 0–100 integer slider no longer exists (changed Batch 12b).
- **pipeline/motion.py is DEAD CODE** — do not call from render.py. Motion scoring added >10 min overhead on 10 min footage. Kept for future premium AI feature only. Never re-enable without profiling total time on realistic footage first.
