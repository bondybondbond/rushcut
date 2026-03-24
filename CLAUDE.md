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
- **FFmpeg in WSL2:** Must be installed natively. If missing, run `wsl -d Ubuntu-24.04 -u root -- apt-get install -y --fix-missing ffmpeg` (installed version is v6.1.1 at `/usr/bin/ffmpeg`). Do NOT rely on the Windows ffmpeg.exe in PATH — WSL root shell does not inherit the Windows PATH entries for it.
- **WSL commands from Git Bash mangle paths:** Git Bash rewrites `/mnt/c/...` paths to Windows paths, breaking all WSL invocations. Always run `wsl` commands from PowerShell, not Git Bash.
- **PowerShell `Out-File` writes UTF-8 BOM:** Python's `json` module raises "Unexpected UTF-8 BOM" on files written by PowerShell's `Out-File`. Write pipeline JSON manifests via Python or WSL `cat >` — never `Out-File`.
- **Pipeline relative imports:** `pipeline/` modules use relative imports (`from .cards import ...`). `run.py` must insert the *parent* of `pipeline/` into `sys.path` and import as `from pipeline.render import run_pipeline`. Using `from render import run_pipeline` with `pipeline/` itself in `sys.path` breaks all relative imports in submodules.
- **Dev launch:** Run `pnpm dev` from `C:\apps\rushcut`. Requires `cargo` in PATH — Rustup installs to `%USERPROFILE%\.cargo\bin` but only new terminals pick it up. If `cargo not found`, open a fresh terminal (or run `$env:PATH += ";$env:USERPROFILE\.cargo\bin"` once). First Cargo build takes several minutes; subsequent are fast.
- **gitignore for Tauri:** `src-tauri/target/` and `src-tauri/gen/` MUST be in `.gitignore`. They are NOT added automatically. Forgetting this means committing hundreds of MB of binary build artifacts, which blocks GitHub push (`GH001: Large files detected`) and requires `git filter-branch` to fix.
- **git push in Claude Code shell hangs silently:** Windows Credential Manager intercepts `git push` even when a token is embedded in the remote URL, causing the process to hang indefinitely with no output. Fix: always push as `GIT_ASKPASS=echo GIT_TERMINAL_PROMPT=0 git push https://<token>@github.com/... main`. Never use plain `git push` — it will hang.
- **Recovering large files already in git history:** If build artifacts were committed and are blocking push, use `git filter-branch --tree-filter 'rm -rf src-tauri/target src-tauri/gen' -- <bad-commit>^..HEAD`, then `git push --force` (not `--force-with-lease` — stale info check fails after rewrite). Kill any hung git processes first with PowerShell `Stop-Process -Name git -Force`.
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
