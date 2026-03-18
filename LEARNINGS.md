# LEARNINGS.md — rushcut

## 2026-03-15 — Batch 0 (pipeline spike)

### FFmpeg

- `xfade` transition name is `fade` not `crossfade` — `crossfade` raises "Not yet implemented in FFmpeg, patches welcome"
- `scale` filter must live inside `-filter_complex` when you're already using `-filter_complex`; using `-vf` alongside it causes "Simple and complex filtering cannot be used together for the same stream"
- Always specify `-c:v libx264 -pix_fmt yuv420p -profile:v main` explicitly in the concat step — omitting `-c:v` after `-filter_complex` can default to HEVC, which Windows can't play without codec packs (error 0x80004005)
- DJI OsmoPocket3: HEVC Main 10 (`yuv420p10le`), 1728×3072 portrait, 29.97fps — normalise to H.264 `yuv420p` 25fps CFR before any filter operations
- DJI files embed a 720×1280 MJPEG thumbnail as a second video stream — ffprobe reports two video streams; filter on codec name to get the real one
- `acrossfade` audio (not `crossfade`) — correct filter name for audio fade between clips in filter_complex

### Python / Windows subprocess

- Avoid Unicode in `print()` on Windows — cp1252 console chokes on `→`, `✅`, `❌`. Use `->`, `[PASS]`, `[FAIL]`
- `subprocess.run(cmd, check=True)` with list args handles paths-with-spaces correctly — no shell=True needed
- Run scripts from repo root (`C:\apps\rushcut`) — relative paths like `spike/tmp/` resolve from cwd, not script location

### Workflow

- Spike-first validated the hardest unknown (FFmpeg pipeline on DJI footage) in ~1 session before touching any infrastructure
- Draft render (360p CRF35 ultrafast) is genuinely useful for reviewing cuts/transitions — don't skip it
- Silence detection on DJI clips shows lots of near-silent sections (camera handling noise) — threshold tuning will be needed in Batch 3

## 2026-03-15 — Batch 2 (upload & storage)

### Next.js / Turbopack

- `@ffprobe-installer/ffprobe` includes a README.md that Turbopack can't bundle — causes `Unknown module type` 500 on the first API call. Fix: add `serverExternalPackages: ['@ffprobe-installer/ffprobe']` to `next.config.ts`.
- Supabase PostgREST schema cache does NOT auto-refresh when a new table is added via SQL editor — `PGRST205` errors until you reload the cache (Dashboard → API Settings → Reload) or the table is simply not there.

### Cloudflare R2 + AWS SDK

- R2 presign works with `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` using region `'auto'` and the full `https://{accountId}.r2.cloudflarestorage.com` endpoint. No custom endpoint middleware needed.

### ffprobe on DJI clips via presigned URL

- Using `-select_streams v:0` is sufficient to skip the embedded MJPEG thumbnail (stream 1) — no need to filter by codec name when running via presigned URL. `r_frame_rate` returns a fraction string (`"30000/1001"`) — must split on `/` and divide; it is never a decimal float.

---

## 2026-03-15 — Batch 1 (skeleton UI + copy/flow)

### UX / Flow

- **Draft-first, configure-optional**: showing the first render before any configuration is the highest-value UX move. Mandatory configure screens before a draft add friction at the worst moment — before the product has proved itself. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **Lock copy before handing pages to Claude**: if copy isn't locked in the prompt, Claude invents its own. A copy-locked prompt (exact strings, no paraphrase) prevents copy drift across pages and saves multiple correction rounds.
- **Step indicator reflects actual user path, not technical structure**: StepIndicator should show the mandatory steps only. Optional/secondary pages (e.g. Configure as a drawer) must not appear as steps — they signal mandatory work that doesn't exist.
- **Re-render cost warnings belong at point-of-action**: showing "1 re-render included" on the Preview page (peak excitement moment) creates anxiety. Move it to the Configure page where the user is actually about to trigger a re-render.

## 2026-03-18 — Batch 3 (FFmpeg Lambda pipeline)

### FFmpeg pipeline architecture

- **Trim durations must be re-measured post-trim** — `get_duration()` must run on trimmed clip paths before building filter_complex xfade offsets. Using pre-trim durations silently misaligns xfade timing. Pattern: always derive durations from the most recent path list, not from an earlier step.
- **Pairwise `acrossfade` breaks for 3+ clips** — chained acrossfade overlaps audio incorrectly for N>2. Use `acrossfade` only for exactly 2 clips; for 3+ use `concat=n={N}:v=0:a=1` (hard cuts at audio joins, but correct).
- **`-map 0:a:0?` not `-map 0:a?`** — DJI clips can contain multiple audio streams. `0:a?` maps all of them; `0:a:0?` pins to the first (optional). Always use the indexed form when normalising DJI footage.
- **`xfade=transition=fadeblack`** is a native FFmpeg xfade transition — no custom black-fill logic needed. Map `dip_to_black` → `fadeblack`, `crossfade` → `fade`.
- **Lambda timeout guard for loudnorm** — two-pass loudnorm adds ~2–4x real-time processing. Add `LAMBDA_TIMEOUT_BUFFER_S` env var (default 30s); check `context.get_remaining_time_in_millis()` before running and skip with WARNING if insufficient.
- **Cards as pre-rendered video segments** — rendering intro/end cards as short H.264 clips before the filter_complex step lets them pass through xfade unchanged. Avoids mixing lavfi sources with real clips inside a single filter_complex.

### Python / Lambda

- **`FFMPEG_BIN`/`FFPROBE_BIN` env vars** — hardcoding `/usr/local/bin/ffmpeg` in utils.py blocks local testing without Docker. Read binary paths from env vars with Lambda-path defaults; this also makes CI/CD flexible.
- **Supabase REST from Lambda via `requests`** — use raw REST API with service role key in headers (`apikey` + `Authorization: Bearer`); skip supabase-py to avoid import weight and version conflicts. PATCH needs `Prefer: return=minimal` header.
- **`run_local()` safe defaults** — synthetic job dicts in local test functions must default all boolean config flags to `False` explicitly. Missing keys cause KeyError deep in the pipeline, not at entry point.

### Docker / WSL (Windows)

- **Docker Desktop on Windows requires WSL 2** — fresh install will report `wslUpdateRequired: true` and fail to start the engine. Run `wsl --install --no-distribution` first; requires a Windows restart to take effect. Plan for this before any session where Docker is needed.
