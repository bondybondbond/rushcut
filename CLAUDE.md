## 🎨 Design Rules (always follow — override any defaults)

- **Follow `docs/DESIGN.md` strictly.** It is the canonical design system. Do not invent new colours or patterns.
- **Always white text on dark backgrounds. Never use grey for readable text.** Background is `#0a0a0a`. Use `#e5e5e5` (primary readable text) or `#a3a3a3` (secondary/metadata — timestamps, subtitles, helper text). `#555555` is decorative/placeholder ONLY — empty states, disabled icons — never for any text a user needs to read. When in doubt, go whiter.
- **Two accent colours:**
  - **Peach `#FF8A65`** — headings, CTAs, active button states, success states.
  - **Sand `#C9A96E`** — upload zone border, 4K badges, info notices, secondary highlights, contextual warnings. Use this wherever a softer accent is needed below the primary peach layer.
- **No duplicate copy.** If text appears in the page heading, do not repeat it inside the component below.
- **No emojis in rendered UI or console output.** ASCII only (`->`, `[i]`, `[PASS]`, `[FAIL]`). Emojis break cp1252 encoding on Windows and look inconsistent in the UI.

## 🏗️ Architecture & Core Rules

- **Stack:** Next.js 15 (App Router), plain `@supabase/supabase-js` ONLY (do NOT install SSR wrappers).

- **UX Flow:** strictly Upload → Preview → Download. "Configure" is a hidden optional step, not part of the main StepIndicator.

- **Copy & Planning:** Canonical copy is locked in `docs/CHANGELOG.md v0.4`. Canonical task list is `docs/BUILD-PLAN.md`.

- **Vercel Limits:** `ffprobe` exceeds Hobby 50MB limit. Skip `ffprobe` execution in serverless routes.

## 💻 Windows 11 Local Dev

- **Console Output:** Use ASCII only (`->`, `[PASS]`, `[FAIL]`). Never print Unicode arrows or emojis (breaks cp1252 encoding).

- **Paths:** Run all scripts from `C:\apps\rushcut`. Source test clips strictly from `C:\clips\` (no spaces). Output to `C:\clips\processed\`.

- **AWS CLI & IAM:** Run via PowerShell or `wsl -d Ubuntu-24.04 -u root -- aws`. IAM role creation must be done manually via browser CloudShell.

- **Supabase:** Manually hit "Reload schema" in Dashboard API Settings after `CREATE TABLE` to clear PGRST205 errors.

## 🎬 FFmpeg Quirks (v8.0.1)

- **DJI Osmo Pocket 3:** The real video is HEVC stream `0` (stream `1` is an embedded MJPEG thumbnail).

- **Encoding:** Always explicitly use `-c:v libx264 -pix_fmt yuv420p -profile:v main` to ensure Windows playback compatibility.

- **Filters:** Use `fade` (not `crossfade`). `scale` must go INSIDE `-filter_complex` when combining streams; do not mix with `-vf`.

## 🐳 Docker & Lambda

- **Daemon:** Docker Desktop is broken. Always run via WSL2: `wsl -d Ubuntu-24.04 -u root -- bash -c "service docker start && docker ..."`

- **Build Command:** Lambda rejects standard builds. ALWAYS use: `docker build --platform linux/arm64 --provenance=false -t rushcut-lambda ./lambda`

- **Target Details:** ECR `459338751297.dkr.ecr.eu-west-2.amazonaws.com/rushcut-lambda`. Function `rushcut-lambda` (ARM64, 3008MB).
