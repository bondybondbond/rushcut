## Architecture & Core Rules

- **Stack:** Next.js 15 (App Router), plain `@supabase/supabase-js` ONLY (do NOT install SSR wrappers).
- **UX Flow:** Upload (`/upload`) → Editor (`/editor/[projectId]`) → Output (`/output/[jobId]`). Settings panel lives inside the editor page — not a separate route or step.
- **Design system:** Read `docs/DESIGN.md` before any UI work. It is the canonical colour palette, typography, button patterns, and copy rules. Do not invent colours or patterns outside it.
- **Vercel Limits:** `ffprobe` exceeds Hobby 50 MB limit. Skip `ffprobe` execution in serverless routes; use client-supplied `duration_ms` fallback.

## Windows 11 Local Dev

- **Console + UI output:** ASCII only (`->`, `[PASS]`, `[FAIL]`). No Unicode arrows or emojis — breaks cp1252 encoding and looks inconsistent in the UI.
- **Paths:** Run all scripts from `C:\apps\rushcut`. Source test clips from `C:\clips\` (no spaces). Output to `C:\clips\processed\`.
- **AWS CLI:** Run via PowerShell or `wsl -d Ubuntu-24.04 -u root -- aws`. IAM role creation requires browser CloudShell (rushcut-cli lacks `iam:CreateRole`).
- **Supabase schema reload:** Run `NOTIFY pgrst, 'reload schema';` in the SQL editor after schema changes. The Dashboard "Reload Schema" button has been removed.
- **Supabase SQL editor (Monaco):** Inject SQL programmatically via `window.monaco.editor.getModels()[0].setValue(sql)` — keyboard shortcuts do not reliably target the editor.

## FFmpeg Quirks (v8.0.1)

- **DJI Osmo Pocket 3:** Real video is HEVC stream `0`; stream `1` is an embedded MJPEG thumbnail. Always use `-map 0:v:0`.
- **Encoding:** Always `-c:v libx264 -pix_fmt yuv420p -profile:v main` — omitting it can silently fall back to HEVC, which Windows Media Player rejects.
- **Filters:** Use `xfade=transition=fade` (not `crossfade`). `scale` must go INSIDE `-filter_complex` when combining streams; never mix with `-vf`.

## Docker & Lambda

- **Daemon:** Docker Desktop is broken. Always run via WSL2: `wsl -d Ubuntu-24.04 -u root -- bash -c "service docker start && docker ..."`
- **Build:** Lambda rejects standard builds. Always use: `docker build --platform linux/arm64 --provenance=false -t rushcut-lambda ./lambda`
- **Lambda update-function-code** must run as a separate top-level WSL call — not nested inside another `wsl -c "..."` command (causes "wsl: command not found").
- **Target:** ECR `459338751297.dkr.ecr.eu-west-2.amazonaws.com/rushcut-lambda`. Function `rushcut-lambda` (ARM64, 3008 MB, eu-west-2).
