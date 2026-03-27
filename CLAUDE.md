## Architecture

**Tauri 2.x local desktop app. NOT Next.js, Vercel, Lambda, or any cloud service.**

- **Renderer:** React + Vite (`src/`)
- **Backend:** Rust (`src-tauri/`)
- **Pipeline:** Python 3 in WSL2 Ubuntu-24.04 (`pipeline/`)
- **DB:** SQLite via rusqlite (`%APPDATA%\rushcut\rushcut.db`)
- No S3, no Lambda, no Supabase, no Vercel. `lambda/` is ARCHIVED — do not modify.

### UX flow

`/upload` → `/editor/:projectId` → `/output/:jobId`

### Dev command

`pnpm dev` (starts Vite + compiles Rust + opens Tauri window). `pnpm dev:vite` alone = all `invoke()` calls fail.

---

## Critical Rules (every session)

- **WSL must go via PowerShell.** Claude Code Bash = Git Bash; Git Bash mangles `/mnt/c/` paths. Wrap all WSL calls as `powershell.exe -Command "wsl -d Ubuntu-24.04 -u root -- ..."`. Glob patterns in PowerShell args get expanded by Git Bash — use `cmd.exe /c` for those.
- **`git push` hangs silently in this shell.** Always push as: `GIT_ASKPASS=echo GIT_TERMINAL_PROMPT=0 git push https://<token>@github.com/bondybondbond/rushcut.git main`
- **Asset URLs:** Always `convertFileSrc(winPath)` from `@tauri-apps/api/core`. Never construct `asset://` URLs manually — video element shows nothing.
- **`pipeline-progress` Rust event must NOT include `stage`.** Only emit `{ jobId, progress }`. Stage field clobbers human-readable labels from `pipeline-stage`.
- **`DEFAULT_CONFIG.transition = "none"`** (not "crossfade"). Three options: `"none"` / `"crossfade"` / `"dip_to_black"`.
- **Tailwind:** `src/globals.css` has `@import "tailwindcss"`, imported from `main.tsx`. Do NOT reference `src/app/globals.css` (deleted).
- **gitignore:** `src-tauri/target/` and `src-tauri/gen/` must be in `.gitignore`. Missing = 668 MB of build artifacts blocking GitHub push.
- **ASCII only** in console/UI output — no Unicode or emoji (breaks cp1252 encoding).
- **Design system:** Read `docs/DESIGN.md` before any UI work — canonical palette, typography, and copy rules.

---

## Detail in `.claude/rules/`

- **Pipeline invocation, manifest, FFmpeg quirks:** `.claude/rules/pipeline.md`
- **Tauri commands, permissions, capabilities:** `.claude/rules/rust-tauri.md`
- **E2E testing (WDIO + rushcut-eval skill):** `.claude/rules/e2e.md`

---

## Retired infrastructure (do not rebuild)

- Lambda / ECR / IAM role: DELETED
- R2 bucket: DELETED
- Supabase: PAUSED (data preserved, may be needed Phase 3)
- Docker Desktop: broken, irrelevant
