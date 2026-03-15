# Changelog — RushCut

> Session-by-session log of what changed and why.
> AI assistants: check here first to understand where the project is.

---

## [0.5] — 2026-03-15 — Batch 2 upload & storage

### Added
- `src/lib/supabase.ts` — browser client + server (service role) client implemented
- `src/lib/r2.ts` — S3-compatible R2 wrapper: `getPresignedPutUrl`, `getPresignedGetUrl`, `deleteObject`
- `src/utils/execFileNoThrow.ts` — safe `execFile` wrapper, never throws, returns `{ stdout, stderr, code }`
- `src/app/api/upload/presign/route.ts` — validates filename/size/type, creates project + clip rows, returns presigned PUT URL
- `src/app/api/clips/probe/route.ts` — ffprobe via `@ffprobe-installer/ffprobe`, parses `r_frame_rate` fraction + `duration`, updates clip row; skips exec on Vercel (binary too large for Hobby plan)
- `src/app/api/clips/[clipId]/route.ts` — DELETE: removes R2 object then DB row
- `src/app/api/clips/reorder/route.ts` — PATCH: batch-updates `order` column
- `src/app/api/jobs/create/route.ts` — inserts job row (status=queued, mode=draft), returns `jobId`
- `src/types/ffprobe-installer.d.ts` — TS module declaration for `@ffprobe-installer/ffprobe`
- `UploadZone.tsx` — wired: hidden file input, drag/drop, sequential upload flow (presign → XHR PUT → probe), per-clip progress bars
- `ClipList.tsx` — wired: dnd-kit sortable reorder, delete, duration/resolution display, "Make my edit" CTA
- `src/app/upload/page.tsx` — clips state, localStorage `projectId`, navigation to real `/preview/[jobId]`
- Supabase `jobs` table created (schema per BUILD-PLAN §Batch 2)

### Fixed
- `next.config.ts`: added `serverExternalPackages: ['@ffprobe-installer/ffprobe']` — Turbopack was failing with `Unknown module type` on the bundled README.md

### Changed
- Upload CTA now navigates to `/preview/[real-jobId]` — `demo-job-id` hardcode removed
- Client-side size guard changed to **per-file** 1GB (was ambiguous "1GB total")

### Known limitations (deferred)
- Probe skipped on Vercel Hobby (ffprobe binary ~70MB exceeds 50MB function limit); `probe_skipped` flag used in UI instead; Lambda will backfill metadata in Batch 4
- `projectId` in `localStorage` — orphaned R2 objects if tab closed mid-upload; resume-draft flow deferred to Batch 3

---

## [0.4] — 2026-03-15 — Batch 1 skeleton UI + copy/flow

### Added
- All 5 pages scaffolded and navigable: Landing, Upload, Configure, Preview, Download
- Locked copy on all pages — headings, subheads, CTAs, helper text
- `StepIndicator` component (3-step: Upload / Preview / Download)
- `UploadZone`, `ClipList`, `ConfigurePanel`, `VideoPlayer` shell components
- Brief input on Upload page (optional, no logic)
- Configure panels: Order, Music, Title card, Style (shells with option chips)
- Download page: explicit STATE A (processing) / STATE B (ready) structure
- Logo links to homepage (`/`) — cancel-confirm hook marked for Batch 2
- `.claude/launch.json` for preview tooling

### Changed (flow vs original plan)
- **Draft-first flow**: Upload CTA → `/preview/demo-job-id` directly (skips Configure)
- **Configure demoted**: optional, reachable only via "Edit settings" from Preview
- **StepIndicator**: 3 steps only (Configure removed from mandatory rail)
- **Re-render warning**: moved from Preview page → inside ConfigurePanel (point-of-action)
- **Configure CTA**: "Re-render with changes" (not "Make my edit") — disambiguates first render vs re-render
- **Preview subhead**: "Your first cut is ready." (confident, not tentative)
- **Download H1s**: state-specific — "Your edit is being processed" / "Your edit is ready"

---

## [0.3] — March 2026 — PRD reassessment + rename

### Changed
- Product renamed from OneClip → **RushCut** (see DEC-006)
- Problem statement rewritten around founder's personal pain point (DaVinci Resolve hours-per-clip)
- Clipchamp repositioned as primary competitor (not CapCut/Filmora)
- DJI LightCut Windows gap explicitly called out as validated unserved market
- "Direction power" concept introduced as core UX principle
- Competitive table updated with Windows column — key differentiator
- Build plan stripped of fixed week numbers; gated on founder self-use first
- Added "nuclear risk": DJI ships Windows LightCut (low prob, high impact)
- Added founder floor note: tool solves personal problem regardless of commercial outcome
- Added Section 14: Strategic Clarity

### Added
- Section 0: Founder Context (SpellWiz, Chrome extension learning history)
- DECISIONS.md with 8 initial decisions logged
- ARCHITECTURE.md with full stack rationale and pipeline detail
- README.md

### Repo
- Private Git repo initialised

---

## [0.2] — March 2026 — Initial PRD

### Added
- Full PRD drafted: problem statement, target user, feature scope, tech stack, cost model, pricing, competitive table, build plan, risks
- AI vs FFmpeg decision table
- Two-step draft + final render flow confirmed
- Phase 1/2/3 build plan
- Cost modelling per export

---

## [0.1] — Pre-draft

- Product concept: "web-first LightCut for Windows users"
- Working title: OneClip
