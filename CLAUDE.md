## Architecture (current — Batch 9+)

**This is a Tauri 2.x local desktop app. NOT a Next.js/Vercel/Lambda project.**

- **Renderer:** React + Vite (`src/`)
- **Backend:** Rust (`src-tauri/`)
- **Pipeline:** Python 3 in WSL2 Ubuntu-24.04 (`pipeline/`)
- **DB:** SQLite via rusqlite (`%APPDATA%\rushcut\rushcut.db`)
- **No S3, no Lambda, no Supabase, no Vercel**
- `lambda/` is ARCHIVED reference only — do not modify it

### Why the pivot (DEC-022 + DEC-023)
Upload bottleneck is fatal: 19 GB / 62-clip session = ~84 min upload before any processing. Local-first removes this entirely. Tauri chosen over Electron for lighter binary (~10-30 MB) and faster cold start.

### UX flow
Folder picker (`/upload`) -> Editor (`/editor/:projectId`) -> Output (`/output/:jobId`)

### Pipeline invocation
`wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py --job-id <uuid> --manifest-path <wsl_path>`

Manifest JSON is written to `%TEMP%\rushcut\<job_id>.json` by Rust before spawning. Contains clips array + settings + output_path. WSL path passed to `run.py`.

Folder scan: `wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/scan.py --folder <wsl_path>`

Progress is read line-by-line from stdout: `PROGRESS:N`, `DONE:/mnt/c/...`, `ERROR:msg`

### Output
Written to `C:\clips\processed\<jobId>.mp4`. Served to the WebView via Tauri asset protocol (`asset://`).

---

## Architecture & Core Rules

- **Stack:** Tauri 2.x + React 19 + Vite. Do NOT use Next.js, Supabase, AWS SDK, or R2.
- **UX Flow:** Folder select (`/upload`) -> Editor (`/editor/:projectId`) -> Output (`/output/:jobId`). Settings panel lives inside the editor page.
- **Design system:** Read `docs/DESIGN.md` before any UI work. It is the canonical colour palette, typography, button patterns, and copy rules. Do not invent colours or patterns outside it.
- **Local only (Phase 2):** Run via `cargo tauri dev`. No Vercel. No cloud deployment.

## Windows 11 Local Dev

- **Console + UI output:** ASCII only (`->`, `[PASS]`, `[FAIL]`). No Unicode arrows or emojis — breaks cp1252 encoding and looks inconsistent in the UI.
- **Paths:** Run all scripts from `C:\apps\rushcut`. Source clips from any local folder (default `C:\clips\`). Output to `C:\clips\processed\`.
- **Pipeline:** Always run via WSL2: `wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py --job-id ...`
- **FFmpeg in WSL2:** Already installed at `/usr/bin/ffmpeg` (v7.x). Use this — do NOT use the old ARM64 static build path.
- **Dev launch:** Run `pnpm dev` from `C:\apps\rushcut`. Requires `cargo` in PATH — Rustup installs to `%USERPROFILE%\.cargo\bin` but only new terminals pick it up. If `cargo not found`, open a fresh terminal (or run `$env:PATH += ";$env:USERPROFILE\.cargo\bin"` once). First Cargo build takes several minutes; subsequent are fast.
- **Tauri 2.x permissions:** All plugin commands must be declared in `src-tauri/capabilities/default.json`. Missing entries throw `not allowed` at runtime, NOT at compile time. Example: folder picker requires `"dialog:allow-open"` in the permissions array.
- **Tauri plugin config in tauri.conf.json:** Use `null` for plugins with no options (e.g. `"dialog": null`). Using `{}` throws a deserialization panic at startup.
- **Tailwind CSS entry point:** `src/globals.css` must contain `@import "tailwindcss"` and be imported in `src/main.tsx`. Do NOT reference `src/app/globals.css` — that path was a Next.js artifact and the directory is deleted.

## FFmpeg Quirks (WSL2 local build)

- **DJI Osmo Pocket 3:** Real video is HEVC stream `0`; stream `1` is an embedded MJPEG thumbnail. Always use `-map 0:v:0`.
- **Encoding:** Always `-c:v libx264 -pix_fmt yuv420p -profile:v main` — omitting it can silently fall back to HEVC, which Windows Media Player rejects.
- **Filters:** Use `xfade=transition=fade` (not `crossfade`). `scale` must go INSIDE `-filter_complex` when combining streams; never mix with `-vf`.
- **Paths in WSL2:** Windows path `C:\clips\DJI_01.MP4` becomes `/mnt/c/clips/DJI_01.MP4`. Always convert before passing to FFmpeg.

## Docker & Lambda (RETIRED for local build)

- Lambda is retired as the processing backend. Do NOT rebuild or redeploy Lambda for Phase 2.
- Docker Desktop is still broken — irrelevant now.
- AWS credentials / ECR / Lambda function remain live but idle. Do not delete them (Phase 3 cloud mode will reuse).
- The `lambda/` directory is kept as reference only. Active pipeline code lives in `pipeline/` (top-level).
