# RushCut — Phase 1 Build Plan (PoC Free Tier)

## Context

RushCut is a web-first video compiler targeting the Windows desktop gap DJI LightCut left open. Phase 1 goal: produce a working free-tier PoC the author can self-validate with real DJI footage before charging anyone. No code exists yet. Only Node.js is installed — all other tooling must be installed as part of the build.

**Design stance:** Minimal/functional skeleton with dark base theme (`#0a0a0a`). Good layout structure and component hierarchy so the "dark, cinematic, LightCut-esque" aesthetic can be layered on later without rewrites. Core functionality first.

**Approach philosophy:** Simplest safe option first. Fail fast on the hardest unknown (FFmpeg pipeline) before building anything around it. Two-step draft → final render. FFmpeg-first, no AI in Phase 1.

**UX principle (Director, not Editor):** User gives *intent*, RushCut handles *execution*. User says "make it cinematic, start with the mountain shots" — the tool handles clip selection, trim points, transition timing, zoom, text style. The user reviews a *film*, not a sequence of clips. Review language is "Does this feel right?" not "accept/reject zoom moments."

**Export limit decision:** No per-month export cap in Phase 1. PRD v0.6 says unlimited exports. Do not build enforcement logic for a limit that's already been removed.

**Auth decision for PoC:** No Supabase Auth in Phase 1 — use `localStorage` project ID. However: schema must include `user_id UUID NULL` on `projects` now so Phase 2 auth doesn't force a migration. No RLS policies in PoC (service role key used for all API routes). Add RLS in Phase 2 when auth is wired.

---

## Batch 0 — Pipeline Spike (local, no infra) ✅ DONE

*Goal: Confirm FFmpeg produces a watchable output from real DJI footage BEFORE touching Next.js. ~2 hours. Highest-risk unknown — fail fast.*
*Completed 2026-03-15. Deviations: `xfade=crossfade` not implemented in FFmpeg 8 — use `fade`. Scale must go inside filter_complex. Output → `C:\clips\processed\`. See LEARNINGS.md.*

### Steps

1. [x] **Install FFmpeg locally**
   
   - Windows: `winget install ffmpeg` or download static build from https://www.gyan.dev/ffmpeg/builds/
   - Verify: `ffmpeg -version`

2. [x] **Write `spike/render.py`** — bare-bones script, no Lambda wiring
   
   ```python
   # spike/render.py
   # Usage: python render.py clip1.mp4 clip2.mp4 clip3.mp4
   # Output: spike/output_draft.mp4
   ```
   
   Steps to run inline:
   a. Normalise each input clip → H.264/AAC/25fps/1080p (resolves DJI H.265 / GoPro H.264 mismatch)
   b. `silencedetect` pass on each normalised clip — print detected silent ranges
   c. Concatenate with `xfade=crossfade:duration=0.5` between joins
   d. Overlay one test music track (`ffmpeg -i video -i music -shortest -af "afade=t=out:st=X:d=3"`)
   e. Output `spike/output_draft.mp4` at 360p, CRF 35, fast preset

3. [x] **Run against 3 real DJI clips**
   
   - `python spike/render.py DJI_001.MP4 DJI_002.MP4 DJI_003.MP4`
   - Open output in VLC or browser

4. [x] **Verification gate**
   
   - Output plays without codec errors
   - xfade crossfade visible at join points
   - No audio sync drift
   - Silence detection prints plausible results
   - ✅ → proceed to Batch 1 with confidence
   - ❌ → diagnose before building anything else (codec normalisation, xfade filter version, audio stream handling)

---

## Batch 1 — Environment Setup & Project Scaffold ✅ DONE (skeleton UI + copy/flow)

*Goal: Working dev environment, running Next.js app, verified tooling.*
*Completed 2026-03-15. Deviations from plan: (1) Flow changed to draft-first — Upload CTA goes direct to Preview, Configure demoted to optional drawer reachable from Preview only. (2) StepIndicator trimmed to 3 steps: Upload / Preview / Download (Configure removed as mandatory step). (3) Copy locked and iterated in-session — final copy differs from original plan placeholders. (4) Download page has explicit STATE A (processing, default) / STATE B (ready) structure with own H1 per state, ready for Batch 2 conditional wiring.*

### Steps

1. **Verify & install remaining prerequisites**
   
   - Confirm Node ≥ 20 (`node -v`)
   - Install pnpm globally (`npm i -g pnpm`)
   - Install Docker Desktop (required for FFmpeg Lambda container local testing)
   - Install AWS CLI v2 (needed for Batch 4 Lambda deploy)
   - FFmpeg already installed from Batch 0 ✓

2. **Scaffold Next.js app**
   
   - `pnpm create next-app@latest rushcut --typescript --tailwind --app --src-dir --import-alias "@/*"`
   - `pnpm dlx shadcn@latest init` — select **dark** theme, neutral base
   - Install core deps:
     
     ```
     pnpm add @supabase/supabase-js @aws-sdk/client-s3 lucide-react zod react-hook-form @hookform/resolvers @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
     ```
   - **dnd-kit only** — do not use react-beautiful-dnd (deprecated, React 18+ issues)

3. **Project structure** (upload and configure are separate pages — not merged)
   
   ```
   src/
     app/
       page.tsx                        # Landing
       upload/page.tsx                 # Upload clips only
       configure/[projectId]/page.tsx  # Configure (order, transitions, music, cards)
       preview/[jobId]/page.tsx        # Draft preview + "Does this feel right?"
       download/[jobId]/page.tsx       # Final render complete + download
     components/
       ui/                             # shadcn primitives
       upload/                         # UploadZone, ClipList, ClipCard
       configure/                      # MusicPicker, TransitionPicker, IntroEndCard
       preview/                        # VideoPlayer, ProgressBar, ConfirmPanel
     lib/
       supabase.ts                     # Browser client + server (service role) client
       r2.ts                           # S3-compatible R2 client, presigned URL helpers
       ffmpeg-client.ts                # Lambda invoke + job poll
     types/
       project.ts                      # Project, Clip, Job types
   ```

4. **Skeleton UI pages** — dark layout, no logic, navigable
   
   - Landing: headline ("From your rushes to a cut. In minutes."), single CTA
   - Upload: drag-and-drop zone + clip list placeholder, "Continue →" button
   - Configure: 4 panels (order/reorder, transitions, music, intro+end card), "Make my film →" button
   - Preview: video player placeholder, step label "Does this feel right?", Respin + Confirm buttons
   - Download: download button placeholder
   - Shared top nav: `RushCut` wordmark, dark `#0a0a0a` background, `#e5e5e5` text
   - Step indicator across all pages: Upload → Configure → Preview → Download

5. **Verification**
   
   - `pnpm dev` runs without errors
   - All 5 pages render and are navigable
   - `pnpm tsc --noEmit` passes

---

## Batch 2 — Upload & Storage ✅ DONE

*Goal: User can drag-drop clips → land in Cloudflare R2 → Supabase records clips with duration metadata.*
*Completed 2026-03-15. Deviations: (1) Client-side guard is per-file 1GB (not total) — consistent with presign validation. (2) Probe skipped on Vercel Hobby (ffprobe binary ~70MB > 50MB limit) — `probe_skipped` flag used; Lambda will backfill metadata in Batch 4. (3) `next.config.ts` required `serverExternalPackages: ['@ffprobe-installer/ffprobe']` — Turbopack can't bundle the package's README.md. (4) Supabase `jobs` table created ahead of schedule (needed for Batch 2 CTA → `/preview/[jobId]`).*

### Steps

1. **Supabase setup**
   
   - Create project at supabase.com (free tier)
   - Schema:
     
     ```sql
     projects (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id UUID NULL,          -- nullable now; Phase 2 will populate + add RLS
       status TEXT DEFAULT 'uploading',
       created_at TIMESTAMPTZ DEFAULT now()
     )
     clips (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
       filename TEXT,
       r2_key TEXT,
       "order" INT,
       duration_ms INT,            -- populated by /api/clips/probe after upload
       size_bytes BIGINT,
       width INT, height INT, fps NUMERIC,  -- from ffprobe
       created_at TIMESTAMPTZ DEFAULT now()
     )
     ```
   - `.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `src/lib/supabase.ts`: browser client + server client (service role for all API routes in PoC)

2. **Cloudflare R2 setup**
   
   - Create R2 bucket `rushcut-uploads` (private)
   - Create R2 API token with Object Read & Write
   - `.env.local`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`
   - `src/lib/r2.ts`: S3 client wrapper — `getPresignedPutUrl()`, `getPresignedGetUrl()`, `deleteObject()`

3. **Upload API route** (`/api/upload/presign/route.ts`)
   
   - Validates: filename, size ≤ 1GB per file, type (`video/mp4`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`)
   - Creates `project` row on first clip of a session (project ID stored in client `localStorage`)
   - Creates `clip` row (duration_ms/width/height/fps NULL until probe runs)
   - Returns: `{ uploadUrl, clipId, projectId }`

4. **UploadZone component**
   
   - Drag-and-drop + click-to-browse (`accept="video/*"`)
   - Client-side guard: max 10 clips, 1GB total across all clips
   - Per clip: validate type + size → presign → PUT directly to R2 (no server proxy)
   - Upload progress via `XMLHttpRequest` `progress` event → per-clip progress bar
   - On complete: call `/api/clips/probe` with `clipId`

5. **Clip probe route** (`/api/clips/probe/route.ts`) — **critical gap fix**
   
   - Receives `clipId`
   - Fetches clip's R2 key → generates presigned GET URL
   - Runs `ffprobe` (Node child_process) against the R2 URL directly:
     
     ```
     ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -of json <presigned_url>
     ```
   - Updates `clips` row: `duration_ms`, `width`, `height`, `fps`
   - Returns parsed metadata to client
   - **Catches corrupt/unreadable files early** — surface error to user before Lambda ever runs

6. **ClipList component**
   
   - Shows each clip: filename, duration (from probe), resolution badge, delete button
   - Drag-to-reorder via `@dnd-kit/sortable` — persists order to Supabase `clips."order"`
   - "Continue to configure →" enabled once ≥ 1 clip uploaded and all probes complete

7. **Verification**
   
   - Upload 3 test clips → confirm objects in R2 dashboard
   - Probe runs → `clips` rows show `duration_ms`, `width`, `height`, `fps`
   - Drag reorder persists (refresh page → order maintained)
   - Deleting a clip removes R2 object + Supabase row

---

## Batch 3 — FFmpeg Pipeline (Docker) ✅ DONE

*Goal: Full Lambda-ready pipeline works end-to-end in Docker with real DJI footage.*
*Completed 2026-03-18. Deviations: (1) Docker/WSL not available on machine — pipeline tested directly via local Python + FFmpeg (same logic, proven end-to-end on 3 DJI clips → draft.mp4). Docker build deferred to start of Batch 4 after WSL restart. (2) `supabase-py` excluded from requirements.txt — Supabase REST called directly via `requests` to avoid import weight. (3) `utils.py` added as shared module for FFMPEG/FFPROBE paths + helpers. (4) FFMPEG_BIN/FFPROBE_BIN env vars added to utils.py for local testing without Docker. (5) Audio: acrossfade 2-clip only, concat n>2 — spike's pairwise acrossfade pattern replaced. (6) Loudnorm timeout guard added (LAMBDA_TIMEOUT_BUFFER_S=30). (7) -map 0:a:0? used instead of -map 0:a? to avoid DJI multi-audio-stream issue.*

### Steps

1. **Lambda container scaffold**
   
   ```
   lambda/
     Dockerfile
     requirements.txt        # boto3, requests, supabase-py
     handler.py              # Lambda entry point
     pipeline/
       __init__.py
       normalise.py          # H.264/AAC/25fps/1080p transcode
       detect.py             # silencedetect + frame-diff stillness
       trim.py               # Apply in/out handles
       transitions.py        # xfade crossfade / dip-to-black
       music.py              # Trim/fade music to video duration
       zoom.py               # zoompan centre-frame (optional)
       loudnorm.py           # Two-pass loudnorm (-14 LUFS)
       cards.py              # Intro 3s + end 3s title cards
       render.py             # Orchestrator
   music/                    # 5 royalty-free tracks bundled here
   ```

2. **FFmpeg binary — pinned version**
   
   - **Pin to `ffmpeg-release-6.1-amd64-static`** (xfade filter stable since 4.3; pin prevents silent breakage on Docker rebuild)
   - ARM64 build for Lambda: `ffmpeg-release-arm64-static` (same version)
   - Dockerfile excerpt:
     
     ```dockerfile
     FROM public.ecr.aws/lambda/python:3.12
     ARG FFMPEG_VERSION=6.1
     RUN curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz \
         | tar xJ --strip-components=1 -C /usr/local/bin ffmpeg*/ffmpeg ffmpeg*/ffprobe
     ```

3. **Pipeline implementation (in execution order)**
   
   - `normalise.py` — transcode all clips → H.264/AAC/25fps/1080p. **Must run first** — prevents xfade codec mismatch (DEC-006). Accepts DJI H.265, GoPro H.264, iPhone HEVC.
   - `detect.py` — `silencedetect` filter + motion vector frame diff → returns `{clip_id, trim_start_ms, trim_end_ms}[]`
   - `trim.py` — apply detected or user-specified in/out points via `-ss` / `-to`
   - `transitions.py` — `xfade=crossfade:duration=0.5` (or `fade` for dip-to-black) at every join
   - `music.py` — trim selected track to `total_video_duration`, `afade=t=out:st={end-3}:d=3`
   - `zoom.py` — `zoompan=z='min(zoom+0.0015,1.5)':d=125` at midpoints of each clip (toggle off by default for speed)
   - `loudnorm.py` — two-pass loudnorm targeting -14 LUFS
   - `cards.py` — prepend 3s intro card (`drawtext`, black bg), append 3s end card
   - `render.py` — orchestrates all above; accepts job JSON from `handler.py`

4. **Draft vs final modes**
   
   - Draft: `-vf scale=-2:360` CRF 35 `-preset ultrafast` — ~30–60s per 3 clips, browser playable
   - Final: `-vf scale=-2:1080` CRF 22 `-preset slow` — full quality for download

5. **Local Docker test**
   
   ```bash
   docker build -t rushcut-lambda ./lambda
   docker run --rm \
     -v "C:/path/to/test/clips:/clips" \
     -v "C:/path/to/output:/output" \
     rushcut-lambda python -c "
       from pipeline.render import run_local
       run_local('/clips', '/output')
     "
   ```

6. **Verification**
   
   - Docker build succeeds, ffmpeg 6.1 confirmed (`ffmpeg -version` in container)
   - 360p draft plays in browser from 3 DJI clips
   - Crossfade visible at joins, no codec errors
   - Music fades out cleanly
   - Silence removed from dead sections

---

## Batch 4 — AWS Lambda Deploy & Job Queue ✅ DONE

*Goal: Next.js triggers Lambda, polls job status, plays draft in browser, downloads final.*
*Completed 2026-03-19. Deviations: (1) Docker Desktop v4.65.0 broken on Windows — `dockerInference` Unix socket bug; bypassed by installing Docker Engine natively in WSL2 Ubuntu-24.04. (2) Image built with `--platform linux/arm64 --provenance=false` to produce Lambda-compatible single-arch manifest (manifest list rejected by Lambda). (3) AWS CLI installed via winget; IAM role created via CloudShell (rushcut-cli lacked iam:CreateRole). (4) End-to-end test passed: 3 DJI clips → draft_ready in 66s.*

### Steps

1. **AWS setup**
   
   - Create ECR private repo `rushcut-lambda` in chosen region (e.g. `eu-west-2`)
   - Lambda function config: 3 GB RAM, 15min timeout, **ARM64** architecture
   - IAM execution role: `AWSLambdaBasicExecutionRole` + inline policy for R2 (S3-compatible PutObject, GetObject on `rushcut-uploads/*`)
   - `.env.local`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LAMBDA_FUNCTION_NAME`

2. **Build & push ARM64 container**
   
   ```bash
   docker buildx build --platform linux/arm64 -t rushcut-lambda ./lambda
   aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI
   docker tag rushcut-lambda:latest $ECR_URI/rushcut-lambda:latest
   docker push $ECR_URI/rushcut-lambda:latest
   aws lambda update-function-code --function-name rushcut-lambda --image-uri $ECR_URI/rushcut-lambda:latest
   ```

3. **Supabase `jobs` table**
   
   ```sql
   jobs (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id UUID REFERENCES projects(id),
     status TEXT DEFAULT 'queued',  -- queued | processing | draft_ready | final_ready | failed
     mode TEXT DEFAULT 'draft',      -- draft | final
     config JSONB,                   -- transition, music track, zoom toggle, card text
     draft_r2_key TEXT,
     final_r2_key TEXT,
     error TEXT,
     created_at TIMESTAMPTZ DEFAULT now(),
     updated_at TIMESTAMPTZ DEFAULT now()
   )
   ```
   
   - Lambda writes status updates via Supabase REST API (service role key in Lambda env vars)

4. **Next.js API routes**
   
   - `POST /api/jobs/create` — inserts job row, invokes Lambda async (`InvocationType: Event`), returns `jobId`
   - `GET /api/jobs/[jobId]/status` — reads job row, returns `{ status, draftUrl?, finalUrl? }` (presigned GET URLs generated on demand when keys are present)
   - `POST /api/jobs/[jobId]/finalise` — creates new job row for `mode: final`, invokes Lambda async

5. **Preview page polling — with hard timeout**
   
   - Poll `GET /api/jobs/[jobId]/status` every 3s
   - **Hard cap: max 20 polls (60s total)**
   - Progress labels: "Normalising clips…" → "Detecting silence…" → "Assembling film…" → "Draft ready ✓"
   - On `draft_ready`: render `<video>` with presigned draft URL
   - On `failed`: show error message + "Try again" button
   - **On timeout (20 polls exhausted, still `processing`):** show "Still working — this can take up to 5 minutes for longer clips. [Refresh status]" with manual refresh button (does not auto-poll further)

6. **"Does this feel right?" confirm panel**
   
   - Three options visible after draft plays:
     - "Looks great → Export full quality" → triggers finalise
     - "Respin this clip" → highlights clip strip, triggers single-clip re-cut (deferred to Batch 5)
     - "Change the vibe" → navigates back to configure (preserves clips, clears job)
   - Final render polling: same 20-poll / 60s cap, extended message "Full quality render takes 2–5 min"
   - On `final_ready`: show download button (presigned GET, 24h expiry)

7. **Verification**
   
   - Upload 3 DJI clips → configure → trigger draft → draft 360p plays in browser
   - Confirm → final 1080p downloads and plays in VLC
   - Lambda CloudWatch logs show each pipeline step
   - Simulate Lambda crash → UI surfaces timeout message after 60s (not infinite spinner)

---

## Batch 5 — End-to-End Polish & Self-Validation ✅ DONE

*Goal: Author produces one real YouTube video using RushCut. Phase 1 gateway cleared.*
*E2E confirmed 2026-03-22: 3 DJI clips uploaded → editor → render → film watched. Outro card timing fixed (3s confirmed). Progress bar smoothing confirmed.*

### Deviations from original plan

- Music schema pivoted: `music_track: string | null` → `music_mood: 'none'|'cinematic'|'upbeat'|'chill'|'electronic'` — enables Phase 2 commercial API (Loudly/Soundraw) without migration
- Music picker guarded by `NEXT_PUBLIC_MUSIC_ENABLED` flag (default false) — renders "Coming soon" until MP3s are in Lambda and flag is set
- Respin single clip deferred to Phase 2 (Lambda complexity too high for Phase 1 gate)
- Free tier limit: **20 clips** (not 10) — confirmed free tier allowance
- CRC32 checksum bug fixed: AWS SDK v3.1009+ adds checksum by default; disabled via `requestChecksumCalculation: "WHEN_REQUIRED"` in r2.ts
- `params` in Next.js 15 client pages must be unwrapped with `React.use()` — fixed in configure page

### Code completed ✅

1. **Configure panel** — full state + all controls wired (transition, music mood, silence/zoom toggles, intro/end card with text + 3-color swatch)
2. **Configure → job create flow** — CTA POSTs config to `/api/jobs/create`, navigates to `/preview/[jobId]`
3. **`/api/jobs/create`** — accepts and persists `config: JobConfig` JSONB
4. **Error states** — probe failures surfaced per-clip, 20-clip guard enforced
5. **Lambda** — `music_mood` → filename mapping in `render.py`

### Remaining manual steps ⬜

1. **R2 CORS** (Cloudflare Dashboard → R2 → `rushcut-uploads` → Settings → CORS Policy):
   
   ```json
   [{"AllowedOrigins":["http://localhost:3000","http://localhost:3001","https://*.vercel.app"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3000}]
   ```
2. **Vercel** — connect GitHub repo, set env vars:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`,
   `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `LAMBDA_FUNCTION_NAME`,
   `NEXT_PUBLIC_MUSIC_ENABLED=false`
3. **Music tracks** (optional, when ready) — drop `cinematic.mp3`, `upbeat.mp3`, `chill.mp3`, `electronic.mp3` into `lambda/music/`, rebuild Lambda image, set `NEXT_PUBLIC_MUSIC_ENABLED=true` in Vercel
4. **Self-validation** — upload 5–8 real DJI clips on prod URL → draft → final → publish to YouTube → **Phase 1 gate cleared ✅**

---

## Critical Files (to be created)

**Next.js app**

- `src/app/page.tsx`
- `src/app/upload/page.tsx`
- `src/app/configure/[projectId]/page.tsx`  ← split from upload
- `src/app/preview/[jobId]/page.tsx`
- `src/app/download/[jobId]/page.tsx`
- `src/components/upload/UploadZone.tsx`
- `src/components/upload/ClipList.tsx`
- `src/components/configure/ConfigurePanel.tsx`
- `src/app/api/upload/presign/route.ts`
- `src/app/api/clips/probe/route.ts`         ← new (ffprobe post-upload)
- `src/app/api/jobs/create/route.ts`
- `src/app/api/jobs/[jobId]/status/route.ts`
- `src/app/api/jobs/[jobId]/finalise/route.ts`
- `src/lib/supabase.ts`
- `src/lib/r2.ts`
- `src/types/project.ts`

**Lambda**

- `lambda/Dockerfile`                        ← ffmpeg 6.1 pinned
- `lambda/requirements.txt`
- `lambda/handler.py`
- `lambda/pipeline/normalise.py`
- `lambda/pipeline/detect.py`
- `lambda/pipeline/trim.py`
- `lambda/pipeline/transitions.py`
- `lambda/pipeline/music.py`
- `lambda/pipeline/zoom.py`
- `lambda/pipeline/loudnorm.py`
- `lambda/pipeline/cards.py`
- `lambda/pipeline/render.py`

**Spike (pre-Batch 1, throwaway)**

- `spike/render.py`

---

## Decisions Locked In This Plan

| #   | Decision                                                                | Rationale                                                                            |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1  | Batch 0 pipeline spike before any frontend                              | Highest-risk unknown; 2 hours to validate before building around it                  |
| D2  | Upload and Configure are separate pages                                 | Cleaner navigation, easier "back" from preview, honours PRD flow                     |
| D3  | FFmpeg pinned to 6.1 static                                             | xfade stable since 4.3; prevents silent breakage on future Docker rebuilds           |
| D4  | dnd-kit only (no react-beautiful-dnd)                                   | react-beautiful-dnd is abandoned with React 18+ issues                               |
| D5  | `/api/clips/probe` runs ffprobe post-upload                             | Catches corrupt files early; populates duration/resolution for UX                    |
| D6  | Polling hard cap: 20 polls / 60s then manual refresh                    | Prevents infinite spinner on silent Lambda failure                                   |
| D7  | No export cap (unlimited)                                               | PRD v0.6 removed 3/month limit; do not build enforcement for removed feature         |
| D8  | Schema has `user_id UUID NULL` now                                      | Avoids Phase 2 migration when Supabase Auth is added; no RLS in PoC                  |
| D9  | Respin single clip: attempt in Batch 5, defer to Phase 2 if too complex | PRD "Director, not Editor" principle requires it; but don't block Phase 1 gate on it |

---

## Refactoring Backlog

- [ ] **`thumbnail_data` for pre-existing clips** — clips uploaded before this session have `thumbnail_data = NULL` in Supabase; the editor falls back to presigned-URL video seek for those. Once all test clips are re-uploaded the fallback path is moot, but a one-off backfill script would clean it up. Priority: Low.
- [ ] **`cards.py` text overlay** — intro/end cards render as solid colour only; text entered in ConfigurePanel is silently ignored because `drawtext` is unavailable in the ARM64 static FFmpeg build. Fix via Pillow: generate a PNG frame with text baked in, loop it to a 3s video. Priority: Med (user-visible gap).
- [ ] **UX flow label drift** — CLAUDE.md still says "UX Flow: Upload → Preview → Download" but the live app routes are `upload → editor → output`. Update the CLAUDE.md flow description to match actual routes before next batch. Priority: Low.

## Phase 2 Preview (not in scope now)

- Supabase Auth (user accounts)
- RLS policies (now schema is ready)
- Stripe payments (£4.99/mo Creator tier)
- AI tier: Google Video Intelligence, face detection, Gemini context prompt, beat-sync
- Fix top 3 issues from self-validation
- Target: 5 paying strangers
- **Lazy / deferred upload** — see DEC-017. Only upload trimmed segments (not raw clips). Trigger: when timeline scrubber with in/out handles is added and exact segment boundaries are known client-side before upload.
