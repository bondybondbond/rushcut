## Architecture

**Tauri 2.x local desktop app. NOT Next.js, Vercel, Lambda, or any cloud service.**

- **Renderer:** React + Vite (`src/`)
- **Backend:** Rust (`src-tauri/`)
- **Pipeline:** Python 3 in WSL2 Ubuntu-24.04 (`pipeline/`)
- **DB:** SQLite via rusqlite (`%APPDATA%\rushcut\rushcut.db`)
- No S3, no Lambda, no Supabase, no Vercel. `lambda/` is ARCHIVED — do not modify.

### UX flow

`/upload` → `/trimmer/:projectId` → `/arrange/:projectId` → `/sound/:projectId` → `/render/:projectId`

### Dev command

`pnpm dev` (starts Vite + compiles Rust + opens Tauri window). `pnpm dev:vite` alone = all `invoke()` calls fail.

---

## Critical Rules (every session)

- **Two instances share one DB.** User runs `src-tauri/target/debug/rushcut.exe` directly (always-on Vite dev server). WDIO tests launch a separate process of the same binary. Both write to `%APPDATA%\rushcut\rushcut.db`. Never confuse their generated artifacts — WDIO renders show `instance=wdio` in the timing log.
- **WSL and PowerShell: use the PowerShell tool, not Bash.** Claude Code Bash = Git Bash; it mangles `/mnt/c/` paths, `$variables`, and `|` pipes inside `powershell.exe -Command "..."`. Use the dedicated `PowerShell` tool for all WSL calls and any PowerShell with variables or pipes. Glob patterns in PowerShell args get expanded by Git Bash — use `cmd.exe /c` for those.
- **`git push` hangs silently in this shell.** Always push as: `GIT_ASKPASS=echo GIT_TERMINAL_PROMPT=0 git push https://<token>@github.com/bondybondbond/rushcut.git main`
- **Asset URLs:** Always `convertFileSrc(winPath)` from `@tauri-apps/api/core`. Never construct `asset://` URLs manually — video element shows nothing.
- **`pipeline-progress` Rust event must NOT include `stage`.** Only emit `{ jobId, progress }`. Stage field clobbers human-readable labels from `pipeline-stage`.
- **`DEFAULT_CONFIG.transition = "none"`** (not "crossfade"). Three options: `"none"` / `"crossfade"` / `"dip_to_black"`.
- **Tailwind:** `src/globals.css` has `@import "tailwindcss"`, imported from `main.tsx`. Do NOT reference `src/app/globals.css` (deleted).
- **gitignore:** `src-tauri/target/` and `src-tauri/gen/` must be in `.gitignore`. Missing = 668 MB of build artifacts blocking GitHub push.
- **ASCII only** in console/UI output — no Unicode or emoji (breaks cp1252 encoding).
- **Grep before claiming "exactly one place".** Before stating that a field, prop, or identifier is consumed in a single file, run `grep -r "field_name" src/` across all `.ts`/`.tsx` files. Claiming a single display site without checking causes missed updates (type errors at best, silent wrong display at worst).
- **Design system:** Read `docs/DESIGN.md` before any UI work — canonical colour palette, typography, button patterns, and copy rules. Do not invent colours or patterns outside it.

---

## Key docs (read when relevant)

| File                | When to read                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `docs/DESIGN.md`    | **Always** before touching any UI — colours, fonts, spacing, copy tone    |
| `docs/CONTEXT.md`   | Start of a feature session — current batch, deferred items, next priority |
| `docs/PRD-DEV.md`   | Planning a new feature or checking the backlog                            |
| `docs/LEARNINGS.md` | Debugging a known class of problem (FFmpeg, pipeline, E2E)                |
| `.claude/rules/`    | Path-specific technical rules — load the relevant file, not all of them   |

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
