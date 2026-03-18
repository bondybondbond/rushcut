# CLAUDE.md — rushcut project notes

## Key file paths

- `spike/render.py` — Batch 0 throwaway spike; confirms FFmpeg pipeline works end-to-end
- `C:\clips\` — test DJI source clips (dji_01/02/03.mp4); not in repo
- `C:\clips\processed\` — spike output destination; gitignored, safe from accidental upload
- `spike/tmp/` — normalised intermediate clips; gitignored, auto-cleaned by script
- `docs/BUILD-PLAN.md` — canonical phase plan; tick off batches here as they complete
- `.gitignore` — includes `spike/tmp/` and `spike/output*`

## Env & tool quirks (Windows)

- FFmpeg installed via winget (Gyan.FFmpeg); auto-discovered by render.py — no PATH change needed
- FFmpeg 8.0.1: `xfade` transition name is `fade` NOT `crossfade` (crossfade not implemented — returns "Not yet implemented in FFmpeg")
- `scale=-2:360` must go INSIDE `-filter_complex` when xfade is used — cannot mix `-vf` (simple filtergraph) and `-filter_complex` on the same output stream
- Default codec without `-c:v libx264` when using filter_complex falls through to HEVC — Windows Photos/Media Player error 0x80004005. Always specify `-c:v libx264 -pix_fmt yuv420p -profile:v main` explicitly
- Windows console (cp1252): avoid Unicode arrows `→` and emoji `✅❌` in print() — causes encoding errors. Use `->`, `[PASS]`, `[FAIL]`
- DJI OsmoPocket3 clips contain an embedded MJPEG thumbnail as a second video stream — ffprobe will report two video streams per file; the real stream is `hevc` stream 0

## Next.js / Turbopack quirks (Batch 2+)

- `@ffprobe-installer/ffprobe` must be in `serverExternalPackages` in `next.config.ts` — Turbopack can't handle the bundled README.md and throws `Unknown module type` 500
- Vercel Hobby plan: 50MB serverless function limit — ffprobe binary (~70MB) exceeds this. Probe route checks `process.env.VERCEL` and returns `{ skipped: true }` instead of running exec. Lambda will backfill in Batch 4.
- Do NOT install `@supabase/ssr` or `@supabase/auth-helpers-nextjs` — the project uses plain `@supabase/supabase-js` createClient directly. Wrong wrapper breaks existing lib/supabase.ts signatures.
- Supabase schema cache does not auto-refresh after CREATE TABLE — new tables return `PGRST205` until Dashboard → API Settings → Reload schema is clicked.

## UX / flow decisions (locked — do not revert)

- **Draft-first flow**: Upload CTA goes direct to Preview (`/preview/[jobId]`). Do NOT add a Configure step between Upload and Preview.
- **Configure is optional**: reachable only via "Edit settings" button on the Preview page. It is not a mandatory step and does not appear in the StepIndicator.
- **StepIndicator**: 3 steps only — Upload / Preview / Download. Configure is excluded.
- **Next.js 15 async params**: `params` in App Router dynamic pages is a Promise — `params.jobId` / `params.projectId` may render empty in shells until properly awaited. Batch 2 concern, not a Batch 1 bug.
- **Copy is locked**: see `docs/CHANGELOG.md` v0.4 for the canonical string for every heading, subhead, CTA, and note across all 5 pages.

## Lambda pipeline (Batch 3+)

- `lambda/pipeline/utils.py` — FFMPEG/FFPROBE paths read from `FFMPEG_BIN`/`FFPROBE_BIN` env vars (default `/usr/local/bin/ffmpeg`). Set these to test locally without Docker.
- Local pipeline test (no Docker needed): `cd lambda && python3 -c "import os,shutil,sys; sys.path.insert(0,'.'); os.environ['FFMPEG_BIN']=shutil.which('ffmpeg'); os.environ['FFPROBE_BIN']=shutil.which('ffprobe'); from pipeline.render import run_local; run_local('C:/clips','C:/clips/processed')"`
- Docker requires WSL 2 on Windows — `wsl --install --no-distribution` + **restart** before Docker Desktop will start. Check state: `"C:/Program Files/Docker/Docker/resources/bin/docker.exe" info 2>&1 | grep wslUpdateRequired`.
- `docker build -t rushcut-lambda ./lambda` — first step of Batch 4 (after WSL restart).

## Efficiency notes

- Specify "Windows environment" at session start — avoids back-and-forth on path separators, encoding, and console issues
- Put test clips in a path with NO SPACES (e.g. `C:\clips\`) — spaces in paths require careful quoting and caused the first failed run
- Output files for testing should go to `C:\clips\processed\` or a gitignored subfolder — not inside the repo where they risk being committed or staged
- Run the script from `C:\apps\rushcut` (repo root), not from the clips folder — relative paths in render.py (spike/tmp, spike/output*) resolve from cwd
