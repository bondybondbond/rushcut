# Pipeline — invocation & FFmpeg rules

Applies when working on `pipeline/**`, `src-tauri/src/lib.rs` (pipeline spawn), or `src/pages/Output.tsx`.

## Proxy pipeline rules

- **`generate_proxy()` timeout must be 600s** — 120s is too short for 4K HEVC clips > 60s at software decode. FFmpeg killed by timeout leaves a corrupt partial file.
- **Validate existing proxies before skipping re-encode** — `Path(proxy_wsl).exists()` is not sufficient. Run `ffprobe -v quiet -show_format <file>` and check `returncode == 0`. A missing moov atom (FFmpeg killed mid-write) makes the file unplayable in WebView2 but `Path.exists()` still returns True. See `is_valid_proxy()` in `proxy.py`.
- **proxy.py manifest /tmp path must be a WSL path** — writing the manifest to Git Bash `/tmp/file.json` makes it invisible to WSL (`/tmp/` is a different filesystem). Always write manifests to a Windows path (`%TEMP%\rushcut\*.json`) and reference as `/mnt/c/Users/.../AppData/Local/Temp/rushcut/file.json` in WSL.
- **Proxy re-encode order: thumbnail → waveform → encode** — extract thumbnail and waveform from source first (fast: ~2s each), then run the slow H.264 encode. This ensures the TrimBar gets visual data within ~5s of proxy gen starting, regardless of how long the encode takes.
- **Proxy spec for normalise-compatible intermediates (Batch C):** To use a proxy as a normalise substitute (skipping the 80s HEVC decode entirely on re-renders), it must match normalise output exactly: `-map 0:v:0 -map 0:a:0? -vf scale=-2:1080,format=yuv420p -r 25 -fps_mode cfr -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -ar 48000`. Missing any of these (especially `-c:a copy` which passes 96kHz DJI audio through) produces a proxy that cannot substitute for a normalised intermediate.
- **Proxy height check before reuse** — legacy 480p proxies must NOT be used as normalise substitutes (upscaling 480p → 1080p in transitions degrades final output). Check `ffprobe -select_streams v:0 -show_entries stream=height -of csv=p=0` before accepting any proxy. Only `height >= 1080` qualifies. Function `_proxy_height(proxy_wsl)` in `render.py` handles this.
- **B-0 trim offset mutation — proxy clips need original `in_ms`/`out_ms` restored** — `_pretrim_worker` in `render.py` runs for ALL clips and rewrites `pipeline_clips[i]["in_ms"]`/`["out_ms"]` to be relative to the pre-trim window start (e.g. `15.569s → 2.0s` after subtracting `a_start = in_s - 2`). For clips that use a proxy (full-duration file), the Step 2 trim must apply the ORIGINAL absolute offsets, not the B-0-relative ones. Fix in `render.py` proxy loop: `pipeline_clips[i] = {**pipeline_clips[i], "in_ms": clips[i].get("in_ms"), "out_ms": clips[i].get("out_ms")}`. Without this, proxy clips are trimmed from the wrong segment (correct duration, wrong content).
- **`proxy_path` must be included in `start_job` manifest** — the Rust `start_job` function builds the clip JSON; `proxy_path` must be explicitly added (`"proxy_path": c.proxy_path`) or `run.py` always sees `null` and all clips fall through to the normalise path on every render.
- **Proxy height gate in `render.py` must be resolution-aware** — `height >= 1080` is correct for 1080p output, but a 1080p proxy used for a 4K render upscales from 1080p → 2160p and degrades quality. Use `required_proxy_h = 2160 if output_resolution == "4k" else 1080`; reject proxies below this threshold and fall through to normalise. A 2160p proxy qualifies for both 1080p and 4K renders.
- **Background proxy gen (`generate_proxy_file_low_priority`) must encode at 2160p** — encoding at `scale=-2:1080` permanently limits the proxy to 1080p reuse only. Always use `scale=-2:2160`; the extra encode cost (~20% more than 1080p at ultrafast) is negligible compared to the bug it prevents. `_proxy_height()` in `render.py` distinguishes old 1080p proxies from new 2160p ones and logs accordingly.
- **`get_clips_needing_bg_proxy` must return ALL `include=1` clips, not only `proxy_status IS NULL`** — filtering by `proxy_status != 'done'` prevents upgrading legacy 1080p proxies to 2160p. The Rust `run_bg_proxy_batch` function calls `proxy_height_native()` per clip and decides: skip (≥2160p), upgrade (existing but <2160p), or encode fresh. Height check in Rust is authoritative; DB filter is only for `include=1`.

## Concurrent renders and log isolation

- **Exit code 15 = SIGTERM from WSL restart** — not a code bug. Check `wsl -- ls /tmp/<job_id>` before debugging; a missing dir means WSL killed everything (memory pressure or a concurrent heavy render). Re-run once WSL is stable.
- **`pipeline-latest.log` must be a symlink, not a shared file** — two concurrent `run.py` processes opening the same file with `mode="w"` produce a sparse file with null-byte gaps (second process truncates but retains old offset). Pattern: each job writes to `pipeline-{job_id}.log`; update `pipeline-latest.log` symlink atomically: `latest.unlink(missing_ok=True); latest.symlink_to(f"pipeline-{job_id}.log")`.

## Sync / performance fixes — logs first

Before writing any A/V sync fix or normalise speed fix, run a real render and read the `[sync-check]` log output. Identify WHERE drift enters (normalise output? post-trim? concat?) before touching code. `aresample=async` worsens DJI monotonic drift — see LEARNINGS.md.

**Normalise performance (post-Batch C):** render.py pre-trims each clip to `[in_s - 2s, out_s + 0.5s]` via FFmpeg copy before calling `normalise()`. Files land in WSL2 `/tmp` (tmpfs = RAM). `normalise()` uses `ThreadPoolExecutor(max_workers=min(4, os.cpu_count()))` with per-worker `-threads N` flag. Result: 10 min → ~3 min for a 1m26s 10-clip DJI 4K film. **Batch C proxy reuse:** on re-renders where 1080p H.264 proxies exist, normalise is skipped entirely — `TIMING:normalise=` drops from ~45s to ~2s (proxy_skip=N/N). The B-0 pre-trim still runs for all clips (fast copy) but normalise only runs for clips without a valid 1080p proxy. First renders are unchanged. The I/O-bound warning still applies to pre-trim (reads from NTFS): parallelising pre-trim does not improve total time.

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
- **`crop` filter has NO `eval` option (FFmpeg 6.1.1)** — writing `crop=W:H:x_expr:y_expr:eval=frame` raises `Error applying option 'eval' to filter 'crop': Option not found`. The `crop` filter re-evaluates `x` and `y` expressions every frame natively; only `scale` needs `:eval=frame` for time-varying width/height. Drop `:eval=frame` from any `crop` filter — the time-varying expressions still work.
- **Gradual zoom (`kb_*`) FFmpeg approach** — use `scale=w='…':h='…':eval=frame,crop=W:H:x_expr:y_expr` (NOT zoompan). The constant crop window forces output to `W×H` every frame while scale changes; both run in a single pass at ~encode speed. Speed fractions: slow=1.0, med=0.75, fast=0.5 of trimmed clip duration. Comma-free smoothstep clamp: `clip(t/M,0,1)` = `(a+1-abs(a-1))/2` where `a=t/M`.
- **`start_job` filters `include==0` clips** at manifest time (Rust). Empty manifest (all clips skipped) returns error to UI. `out_ms` clamped to `duration_ms` to prevent FFmpeg crash on out-of-bounds trim.
- **Single-pass loudnorm is fused into the encode — never apply it twice.** `render.py` sets `music_on = bool(music_filename or custom_music_path_wsl)` before Step 5. Step 5 (render encode) appends loudnorm to the filter chain ONLY when `not music_on`. Step 6 (music mix) applies loudnorm via `apply_loudnorm=(mode != "draft")` ONLY when music is active. The two paths are mutually exclusive by design. Adding loudnorm in both paths produces double-compression and a loud-soft-loud pump artifact. The `loudnorm_filter()` helper in `loudnorm.py` is the single source of the filter string.
