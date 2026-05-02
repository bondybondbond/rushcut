# Pipeline — invocation & FFmpeg rules

Applies when working on `pipeline/**`, `src-tauri/src/lib.rs` (pipeline spawn), or `src/pages/Output.tsx`.

## Proxy pipeline rules

- **`generate_proxy()` timeout must be 600s** — 120s is too short for 4K HEVC clips > 60s at software decode. FFmpeg killed by timeout leaves a corrupt partial file.
- **Validate existing proxies before skipping re-encode** — `Path(proxy_wsl).exists()` is not sufficient. Run `ffprobe -v quiet -show_format <file>` and check `returncode == 0`. A missing moov atom (FFmpeg killed mid-write) makes the file unplayable in WebView2 but `Path.exists()` still returns True. See `is_valid_proxy()` in `proxy.py`.
- **proxy.py manifest /tmp path must be a WSL path** — writing the manifest to Git Bash `/tmp/file.json` makes it invisible to WSL (`/tmp/` is a different filesystem). Always write manifests to a Windows path (`%TEMP%\rushcut\*.json`) and reference as `/mnt/c/Users/.../AppData/Local/Temp/rushcut/file.json` in WSL.
- **Proxy re-encode order: thumbnail → waveform → encode** — extract thumbnail and waveform from source first (fast: ~2s each), then run the slow H.264 encode. This ensures the TrimBar gets visual data within ~5s of proxy gen starting, regardless of how long the encode takes.

## Sync / performance fixes — logs first

Before writing any A/V sync fix or normalise speed fix, run a real render and read the `[sync-check]` log output. Identify WHERE drift enters (normalise output? post-trim? concat?) before touching code. `aresample=async` worsens DJI monotonic drift — see LEARNINGS.md.

**Normalise performance (post-Batch B):** render.py now pre-trims each clip to `[in_s - 2s, out_s + 0.5s]` via FFmpeg copy before calling `normalise()`. Files land in WSL2 `/tmp` (tmpfs = RAM). `normalise()` uses `ThreadPoolExecutor(max_workers=min(4, os.cpu_count()))` with per-worker `-threads N` flag. Result: 10 min → ~3 min for a 1m26s 10-clip DJI 4K film. The 80s normalise floor is 4K HEVC software decode speed — no further gain without proxy reuse (see LEARNINGS.md). The I/O-bound warning still applies to pre-trim (reads from NTFS): parallelising pre-trim across clips on the same drive does not improve total time.

**Music volume ducking (post-Batch B):** `music.py` `_build_filter()` now applies `[0:a]volume={movie_vol}[movaudio]` to the movie audio stream before amix. `movie_vol` is preset-driven: `{subtle: 1.0, balanced: 0.7, prominent: 0.3}`. The `mix_music()` signature takes `movie_vol: float = 1.0`. Callers in `render.py` pass `movie_vol = _MOVIE_VOL.get(round(music_volume, 1), 0.7)`.

## Invocation

```
wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py --job-id <uuid> --manifest-path <wsl_path>
```

Manifest JSON written to `%TEMP%\rushcut\<job_id>.json` by Rust. Contains clips array + settings + output_path.

Folder scan: `wsl -d Ubuntu-24.04 -u root -- python3 .../scan.py --folder <wsl_path>`
File scan:   `wsl -d Ubuntu-24.04 -u root -- python3 .../scan.py --files <path1> <path2> ...`

Progress stdout: `STAGE:name` · `PROGRESS:N` · `DONE:/mnt/c/...` · `ERROR:msg` · `ANALYSIS:key=val,...`

`ANALYSIS:` lines carry structured metadata. Rust stores in `jobs.analysis_summary`. Emit **once at the end** of `run_pipeline` (not mid-pipeline). Full schema: `clips_used,clips_total,clips_excluded,raw_duration_s,output_duration_s,total_raw_mb,max_resolution,has_4k,audio_clip_count,normalise_s,render_s,total_s,music,cards,zoom,transition`.

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
- **Fixed-canvas pre-scale for portrait+landscape mixing:** `transitions.py` pre-scales every input to an exact canvas (`scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2`) with named labels `[sv0]`,`[sv1]`... before any concat or xfade. Do NOT use `scale=-2:{h}` after the chain — that was the crash (different widths entering xfade = FFmpeg exit 234). Both `"none"` and xfade paths use this approach.
- **normalise.py uses `ultrafast` preset for both modes** — normalised files are intermediates re-encoded by the render step. `fast` or better wastes CPU on motion estimation. Final mode changed from `fast` → `ultrafast` in Batch 13b.
- **xfade_dur clamp:** `transitions.py` clamps to `min(1.5, min_clip_dur / 2.0)`. Do not remove — prevents short clips (e.g. 3s cards) from being consumed.
- **`-map 0:a:0?` not `-map 0:a?`** — DJI clips can contain multiple audio streams.
- **Audio for xfade transitions (N>=2):** Pairwise chained `acrossfade` for ALL N>=2. `apad=whole_dur=durations[i]` per clip normalises audio to exact video duration, so crossfade start point (`dur - xfade_dur`) aligns with the xfade visual offset. Do NOT use `concat` for 3+ clips — hard cuts lag audio 1.5s behind video at every cut after the first (accumulates per cut).
- **Music loop: `asetpts=PTS-STARTPTS` before `atrim` when using `-stream_loop -1`** — loop assigns continuously rising PTS; trimming before reset cuts too early. Order: `[1:a]asetpts=PTS-STARTPTS,atrim=0:{dur},volume=...,afade=...`. See `music.py`.
- **`-ar 48000` at every re-encode site:** DJI records at 96kHz; force 48kHz at normalise, inject_silence, single-clip render, multi-clip render, music mix, and loudnorm. One missing site means 96kHz leaks into the output.
- **music_volume is now a string union:** `"subtle" | "balanced" | "prominent"`. `run.py` maps to floats `{subtle: 0.2, balanced: 0.4, prominent: 0.7}`. The old 0–100 integer slider no longer exists (changed Batch 12b).
- **pipeline/motion.py is DEAD CODE** — do not call from render.py. Motion scoring added >10 min overhead on 10 min footage. Kept for future premium AI feature only. Never re-enable without profiling total time on realistic footage first.
- **Per-clip review fields in manifest (Batch 14c):** Each clip in the manifest now carries `in_ms`, `out_ms`, `focal_x`, `focal_y`, `zoom_mode`. `render.py` Step 2 checks user `in_ms`/`out_ms` first (ms -> seconds); silence detection is fallback only. Step 3 checks per-clip `zoom_mode` + focal point before global `config.zoom`.
- **zoom.py focal offset clamping:** `x = min(max(iw*fx - iw/zoom/2, 0), iw - iw/zoom)` — without clamping, focal points near edges produce out-of-frame pans that crash or show black bars. Always log computed x/y/zoom values before passing to FFmpeg.
- **`start_job` filters `include==0` clips** at manifest time (Rust). Empty manifest (all clips skipped) returns error to UI. `out_ms` clamped to `duration_ms` to prevent FFmpeg crash on out-of-bounds trim.
