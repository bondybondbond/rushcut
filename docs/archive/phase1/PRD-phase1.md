# PRD: RushCut — Rushes to a Cut — One-Click Web Video Editor

> **Product:** RushCut — *Your clips. Edited.*
> **Version:** 0.11 (updated March 2026 — Batch 2 session)
> **Author:** Manasak
> **Status:** Draft — updated after Batch 2 infrastructure session

---

## 0. Why This Exists (Founder Context)

This is a **personal pain point project first, commercial product second.** The author spends hours in DaVinci Resolve producing 3-minute YouTube clips for family — and that trade-off (hours of editing vs. minutes of fun filming) is the exact problem RushCut solves.

**Learning project context:** Third personal dev project after SpellWiz (educational game, still in daily use by author's daughter) and a Chrome extension (successfully launched). First project with paid-tier ambition. Built using Claude Code as primary dev assistant, no-rush timeline, solo.

**If it fails commercially:** Still solves the author's own problem better than any existing tool at any price. That's a valid floor.

---

## 1. Problem Statement

Hobbyist videographers (DJI drone, GoPro, iPhone) who want to produce shareable films face a broken market:

- **DJI LightCut / GoPro Quik:** Best-in-class UX and action awareness — but **mobile/tablet only**. No Windows support after years of requests. Editing capabilities are deliberately shallow — they want you shooting, not editing. Users who outgrow the basics have nowhere to go within the ecosystem.
- **Clipchamp (Windows built-in):** Free, web-first, 1080p — genuinely good competitor. But it's a traditional timeline editor. Beginners still face the same "stare at 40 clips and figure out the structure" problem. No auto-compile, no direction power.
- **DaVinci Resolve / Premiere:** Pro-grade, hours per video. The author's personal reality: spending 3+ hours editing a 3-minute family YouTube clip. The effort-to-output ratio kills the joy of filming.
- **CapCut, Filmora, Kapwing:** AI-obsessed UX, watermarks on free tiers, expensive for casual use, bloated with features most users never touch.

**The real gap — validated by founder's own experience:**

> DJI LightCut's "auto-film" UX is the gold standard — but it's mobile-only and editorially shallow. DaVinci gives full control but costs hours. Nothing in between gives you *direction power* (tell it what kind of film you want, get a solid first draft) without forcing you into micro-managing every 2-second clip.

**The bet:** A focused web tool that does *one job exceptionally* — compile your clips into a watchable film with good transitions, music, and structure — and lets you tweak the result, not rebuild it from scratch. No AI gimmicks. No watermarks. No bloat.

**Why web-first matters for this audience:**

- DJI drone users are predominantly Windows desktop users who transfer footage via cable/SD card
- Workflow is: film → import to PC → edit → export. Mobile editing is a friction point, not a feature
- DJI's own failure to ship a Windows LightCut version despite years of demand = validated unserved market

---

## 2. Target User

| Attribute                | Description                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Primary**              | Hobbyist action/drone/travel videographers                                                              |
| **Device**               | Shoots on DJI drone, GoPro, iPhone — transfers to Windows PC                                            |
| **Destination**          | YouTube (family/friends), Instagram, personal archive                                                   |
| **Core pain**            | The gap between "I want a shareable film" and "I just spent 3 hours in DaVinci on a 3-min clip"         |
| **Current workaround**   | Either tolerating mobile-only tools (LightCut) or suffering through timeline editors (DaVinci, Resolve) |
| **What they want**       | *Direction power* — tell the tool the vibe, get a solid first draft, tweak only what matters            |
| **What they don't want** | Timeline micro-management, AI gimmicks, watermarks, subscriptions for features they never use           |
| **Willingness to pay**   | £4–8/mo to reclaim 2+ hours per video — or more honestly, to *want to edit at all*                      |
| **Tech comfort**         | Beginner–intermediate; has used Clipchamp but found it still too manual                                 |

**User quote (founder, validated):**

> *"I use DaVinci Resolve but spend hours on each 3-min clip I produce for YouTube to show family — it makes little sense. If I could genuinely help people avoid that, they could focus on the fun part — making video."*

**Real footage baseline (founder's own DJI session):**

- 62 clips, 19.6GB total, largest single clip = 1.4GB (4K 30fps, 3 min duration)
- This validates the 2GB per-file limit and the need for aggressive post-render R2 cleanup

---

## 3. Product Vision

> *"From your raw footage to a shareable film in under 5 minutes — no editing skills required."*

Web-first (desktop browser primary, Windows PC workflow). No download. No watermarks on any tier. No AI generation gimmicks.

**The positioning bet:** In a market obsessing over AI features, RushCut wins by doing one thing exceptionally well — compile your clips into a watchable film with good transitions, music, and structure. The differentiator is *simplicity and editorial direction*, not features.

**Design principle:** Every screen should feel like you're making creative choices, not managing software.

### Director, not Editor

RushCut's core UX principle: the user is always making *creative decisions*, never *technical ones*. They say "make it cinematic, start with the mountain shots" — RushCut handles clip selection, trim points, transition timing, zoom in/out animation, and text animation style. The user never touches a timeline. They review a film, not a sequence of clips.

The magic of feeling like a director must never be lost. What gets outsourced is the tedious execution: clip-by-clip assembly, deciding where transitions start and stop, animating text, applying zooms. What stays with the user is intent and creative direction. This is the exact positioning lesson from Magisto's failure — when Vimeo stripped out the AI engine, the "director feeling" disappeared and users left immediately. The AI engine *is* the product.

### The Moment Extraction Mental Model

**This is the core of what RushCut does — and what separates it from every other tool.**

RushCut does not simply aggregate clips and splice them together. Any timeline editor (DaVinci, Clipchamp) can do that — it still requires hours of manual work. The product value is **moment extraction**: finding the best 3–15 seconds within each clip, discarding the dead parts (landing shots, walking to subject, camera shake, silence, static frames), and keeping only the peak moment.

From 62 raw clips:

- Perhaps 50 contribute something worth keeping
- Each contributes 3–15 seconds of their best moment (not the whole clip)
- Output: a 3–6 minute film of ~50 micro-cuts, music-synced, with transitions
- The user never decided which frames to keep — the system did

**This is harder than clip selection (keep/discard entire clips).** It requires understanding where the interesting moment is *within* each clip — the frame where the drone crests the mountain, not the 8 seconds of ascent before it. FFmpeg `silencedetect` + motion frame-diff handles obvious dead sections. Google Video Intelligence handles the subtler editorial judgement at the frame level.

**The product mantra:** *Not “edit your clips” — “capture your moments.”*

---

## 4. What Needs AI vs. What's Free (FFmpeg)

This is the core technical decision — knowing which features require AI vs. can run on pure FFmpeg determines tier gating and cost.

| Feature                                                       | Needs AI?                 | How                                                                                             |
| ------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| **Silence/stillness removal**                                 | ❌ No                      | FFmpeg `silencedetect` + frame-diff motion score — pure signal processing                       |
| **Auto-add transitions** (crossfade, dip to black)            | ❌ No                      | FFmpeg `xfade` filter — applied at every clip join point automatically                          |
| **Auto-fit music to video duration**                          | ❌ No                      | FFmpeg cuts/fades audio track to exact output duration                                          |
| **Beat-sync music cutting**                                   | ❌ No                      | `librosa` open-source Python — free, included on free tier                                      |
| **Zoom effect (generic, centre-frame)**                       | ❌ No                      | FFmpeg `zoompan` filter — auto-applied at clip midpoints                                        |
| **Zoom on faces / people**                                    | ✅ Yes                     | Requires face detection (e.g. Google Vision API or OpenCV)                                      |
| **Zoom on key action moments**                                | ✅ Yes                     | Requires motion + scene scoring (Google Video Intelligence API)                                 |
| **Moment extraction** (best 3–15s within each clip)           | ✅ Yes (full) / ❌ Partial  | FFmpeg frame-diff removes dead sections (free); GVI identifies peak moments within clips (paid) |
| **Context-aware ordering** ("start at flight, then hotel...") | ⚠️ Free (basic)           | Gemini 2.0 Flash ~$0.001/export — included on free tier                                         |
| **Boring clip filtering**                                     | ❌ No (basic)              | FFmpeg frame-diff motion score — free tier; Google Video Intelligence = paid upgrade            |
| **Stabilisation**                                             | ✅ Yes (or FFmpeg vidstab) | `ffmpeg-vidstab` plugin = no AI, but compute-heavy → paid tier                                  |
| **Volume normalisation**                                      | ❌ No                      | FFmpeg `loudnorm` filter — free                                                                 |

**Summary rule:**

- 🆓 Free tier: FFmpeg + librosa + Gemini Flash. Silence/stillness removal + basic moment extraction (dead section removal) + crossfade transitions + beat-sync music + generic centre-zoom + context prompt — near-zero AI cost (~$0.001/export)
- 💰 Paid AI tier: Full moment extraction (GVI frame-level peak detection), smart zoom, face detection, stabilisation, licensed music, 4K export

---

## 5. Production Flow

### User flow (screen by screen)

```
SCREEN 0 — LANDING
  Headline:   "Your clips. Edited."
  Subhead:    "Upload your footage. Get a cut in minutes."
  CTA:        "Get started" → /upload
  No login required.

SCREEN 1 — SELECT CLIPS  (/upload)
  Step indicator: Upload highlighted
  Heading:    "Select your clips"
  Subhead:    "Up to 20 clips. MP4, MOV or MKV, up to 2 GB each."
  Upload zone: drag and drop or click to browse
  Clip list:   clips appear below upload zone
  Optional brief: short text input → "e.g. fast cuts, upbeat, travel feel"
                  helper: "We will use this as a starting point. You can always adjust."
  CTA:        "Continue" → /configure/[projectId]
  NOTE: No login. No server cost. Local state only.

SCREEN 2 — CONFIGURE  (/configure/[projectId])
  Step indicator: Configure highlighted
  Heading:    "Your edit settings"
  Subhead:    "Defaults are already set. Change anything before we start."
  Panel 1 — Order:       Drag to reorder. Default: upload/timestamp order.
  Panel 2 — Music:       Auto / No music / Choose track. Default: auto.
  Panel 3 — Title card:  On / Off. Default: on, auto-generated.
  Panel 4 — Style:       Auto / Fast cuts / Slow and cinematic. Default: auto.
  Small note: "Heavy changes like reordering after render will use one of your included re-renders."
  CTA:        "Make my edit" → triggers LOGIN GATE → upload + draft render
  NOTE: All fields have defaults. User can click CTA without touching anything.
  NOTE: Login/signup gate fires at this CTA — before any server cost is incurred.

SCREEN 3 — PREVIEW  (/preview/[jobId])
  Step indicator: Preview highlighted
  Heading:    "Does this feel right?"
  Subhead:    "Watch your draft. Confirm it or go back and adjust."
  Video area: draft preview player (360p proxy)
  Secondary actions:
    "Edit settings"       → /configure/[projectId]   (cheap: no re-render)
    "Re-render preview"   (expensive: consumes 1 re-render allowance)
  Primary CTA: "Export final edit" → /download/[jobId]
  Small note: "1 re-render included. Additional re-renders may use credits."

SCREEN 4 — DOWNLOAD  (/download/[jobId])
  Step indicator: Download highlighted
  STATE A — Processing:
    Heading:    "Your edit is being processed"
    Subhead:    "This usually takes a few minutes."
    Progress bar (animated, fun — not a plain bar)
    Note:       "You can close this tab. We will save it to your library."
  STATE B — Ready:
    Heading:    "Your edit is ready"
    Subhead:    "Your 1080p file is ready to download."
    Badges:     [1080p]  [4K — upgrade]
    CTA:        "Download edit"
  Always visible: "Saved to your library for 30 days."
```

> ✅ **Confirmed:** Draft proxy is a separate low-memory Lambda job (360p), not client-side blob stitching. User sees actual FFmpeg transitions/music/zoom in preview — not a simulated preview.

> ✅ **Confirmed:** DJI LightCut does auto-adjust music — it detects beat markers and aligns cuts to rhythm automatically. RushCut does the same via `librosa` BPM detection (no AI cost).

> ✅ **Confirmed:** Step 3 (Preview) is a film review, not an editing session. The Respin mechanic (per-clip re-cut) avoids the Magisto trap of either too much or too little control — user nudges, not rebuilds.

> ✅ **Confirmed:** Login gate fires at "Make my edit" CTA on Configure screen — not before. No server cost incurred before authentication.

> ✅ **Confirmed:** Download retention is 30 days in library (not 24-hour link). See DEC-015.

### Why a draft-then-confirm step?

- Avoids wasting a full 4K render on a version the user rejects
- Gives the user editorial control without forcing them into a full timeline editor
- Proxy draft is fast (low-res, server-rendered at 360p) — full render only on confirmation
- Zoom/music adjustments are applied to final confirmed version, not draft

### Re-render cost control (two-tier model)

See DEC-013. Changes after first draft are split:

- **Cheap (no re-render):** Music swap, title card text, style label — metadata only
- **Expensive (re-render):** Clip reorder, transition change, trim changes — alters video timeline
  Free tier: 1 included re-render per project.

---

## 6. Feature Scope

### v1 — Free Tier (PoC)

- [ ] Unlimited projects
- [ ] Up to 20 clips per project (**always 20 — never write 10 anywhere**)
- [ ] **Hard cap: 2GB per file, 10GB per project total** (enforced pre-upload — validated against real DJI 4K footage at 1.4GB/clip)
- [ ] Auto-combine in upload/timestamp order
- [ ] Silence + stillness detection → auto-remove dead sections (FFmpeg) — basic moment extraction
- [ ] Clip trim (in/out handles per clip, no timeline)
- [ ] 5 transition styles: crossfade, dip to black, hard cut, whip, fade to white (auto-applied, style picker)
- [ ] Generic centre-frame zoom at clip midpoint (FFmpeg `zoompan`)
- [ ] ~20 royalty-free music tracks (Pixabay/ccMixter), auto-fitted to duration
- [ ] Volume normalisation (FFmpeg `loudnorm`)
- [ ] 5 basic text/title styles — intro card + end card only
- [ ] Draft preview → confirm → final render
- [ ] Export: **1080p MP4, no watermark, ever**
- [ ] **Saved to library for 30 days** (not 24-hour link — all users are authenticated)
- [ ] **No export count limit** (cost per export ~£0.03 max at 5GB — sustainable)
- [ ] Beat-sync music cuts via `librosa` BPM detection
- [ ] Optional brief: short text hint → sets defaults only (vibe/order direction via Gemini 2.0 Flash ~$0.001/export)
- [ ] Basic boring clip filtering (FFmpeg motion score — removes near-static clips automatically)
- [ ] **Respin per clip** — tap clip in preview strip → Lambda re-cuts just that clip (no full re-render)
- [ ] **1 included re-render per project** (expensive changes only; see DEC-013)
- [ ] **Target output length: default 3 mins** — see SD-007

### v2 — Paid Creator Tier (£4.99/mo or £39.99/yr)

- [ ] Up to 50 clips per project
- [ ] **Hard cap: 4GB per file, 20GB per project total**
- [ ] **Fair usage: max 5 final exports per month** (see Section 8 — real economics after Stripe + VAT)
- [ ] **4K export** (primary upgrade trigger)
- [ ] Smart clip scoring: Google Video Intelligence — action peaks + motion intensity → frame-level moment extraction
- [ ] **Google Video Intelligence capped at 5 min of footage scored per export** (cost protection)
- [ ] Smart zoom: face detection + action moment zoom via Google Vision
- [ ] Advanced context ordering: AI scene labelling via Google Video Intelligence
- [ ] Full licensed music library (Epidemic Sound — gated to paid tier)
- [ ] 15+ transition styles
- [ ] 15+ text/title styles (animated options: fade in, slide up, etc.)
- [ ] Video stabilisation (`ffmpeg-vidstab`)
- [ ] Project save + re-edit
- [ ] Open-ended AI direction (free-text "describe your film") — see DEC-014
- [ ] **Target output length: user-selectable** (3 min / 5 min / 10 min / 15 min) — see SD-007

### Permanently Out of Scope

- AI video generation (text-to-video)
- Multi-track timeline editor
- Colour grading
- Captions / subtitles
- Team / collaboration

---

## 7. Technical Architecture

### Stack

| Layer                             | Tool                                                      | Rationale                                                                                                          |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Frontend                          | Next.js (App Router)                                      | Fast, Vercel-deployable                                                                                            |
| UI                                | Tailwind + shadcn/ui                                      | Rapid prototyping — responsive by default; "best on desktop" banner shown on mobile; no special mobile flow at MVP |
| Auth + DB                         | Supabase                                                  | Free tier covers PoC                                                                                               |
| File storage                      | Cloudflare R2                                             | Zero egress fees — critical for large video files                                                                  |
| Proxy preview                     | FFmpeg (server-side 360p Lambda, separate low-memory job) | Real FFmpeg output at low res — not client blob stitching                                                          |
| Full render                       | FFmpeg on AWS Lambda (containerised)                      | Serverless, scales to zero, pay-per-export                                                                         |
| Silence detection                 | FFmpeg `silencedetect`                                    | Free, no AI                                                                                                        |
| Stillness detection               | FFmpeg frame diff (Python script)                         | Free, no AI                                                                                                        |
| Transitions                       | FFmpeg `xfade`                                            | Free, no AI                                                                                                        |
| Music fit                         | FFmpeg audio trim + fade                                  | Free, no AI                                                                                                        |
| Beat-sync                         | `librosa` Python (Lambda)                                 | Free, open-source                                                                                                  |
| Zoom (generic)                    | FFmpeg `zoompan`                                          | Free, no AI                                                                                                        |
| Zoom (smart, faces)               | OpenCV or Google Vision API                               | AI — paid tier only                                                                                                |
| Scene scoring + moment extraction | Google Video Intelligence API                             | AI — paid tier only; hard-capped at 5 min/export                                                                   |
| Context prompt                    | Gemini 2.0 Flash                                          | AI — free tier (basic vibe prompt / defaults only)                                                                 |
| Stabilisation                     | `ffmpeg-vidstab` plugin                                   | Compute-heavy — paid tier only                                                                                     |
| Payments                          | Stripe                                                    | Standard                                                                                                           |

### Export Pipeline

```
User confirms draft
  → API triggers AWS Lambda (FFmpeg container)
  → Lambda fetches clips from R2
  → Runs: silence removal → moment extraction → trim → xfade transitions → music fit → zoom → normalise
  → Output written to R2 (retained 30 days for authenticated user)
  → Download available in library
```

### R2 Storage Lifecycle (Batch 4 — implement with Lambda)

```
Upload complete    → raw clips in R2
Lambda finishes    → DELETE raw clips immediately (do not wait for user action)
Draft available    → only the 360p draft file persists
User confirms      → final 1080p written to R2
User downloads     → raw clips already gone; final file persists 30 days
30 days elapsed    → daily cleanup job deletes final file
```

> **Why aggressive cleanup?** R2 free tier is 10GB live storage (not monthly allowance — it is live disk usage at any moment). 20 concurrent users each uploading 5GB would exceed free tier. Deleting raw clips post-render keeps live storage near zero at all times.

---

## 8. Cost Model (Realistic, Bootstrapped)

### Real Economics Per Subscriber

The £4.99 headline price is not what lands in the bank. Real budget per paying user:

| Scenario                       | Gross      | Stripe fee (1.5% + 25p) | Net to bank |
| ------------------------------ | ---------- | ----------------------- | ----------- |
| Pre-VAT registration           | £4.99      | £0.325                  | **£4.665**  |
| VAT registered (£4.99 inc VAT) | £4.165 net | £0.312                  | **£3.853**  |

> **VAT registration threshold (UK):** £90,000 turnover. At £4.99/mo, that's ~18,000 subscribers before mandatory VAT registration. Pre-registration, £4.665 is the real budget. Post-registration, £3.853. Plan for the lower figure from day one.

### File Size Hard Caps

| Tier         | Max per file | Max per project | Max exports/month  |
| ------------ | ------------ | --------------- | ------------------ |
| Free         | 2GB          | 10GB            | Unlimited          |
| Paid Creator | 4GB          | 20GB            | **5 (fair usage)** |

> **Why 2GB per file?** Validated against real DJI footage: 4K 30fps clips at 3 min duration reach 1.4GB. The previous 500MB/1GB cap was too restrictive for the actual target user.

> **Why 5 exports/month?** After Stripe fees, real budget is £4.665 pre-VAT. At a typical 5GB project, paid tier costs ~£0.56/export. 5 exports = £2.80 infra — leaving ~£1.86 actual margin (~40%). At 10 exports = £5.60 infra, which exceeds the £4.665 net revenue.

### Cloudflare R2 Pricing Reference

| Monthly live storage | Cost       |
| -------------------- | ---------- |
| Under 10GB           | Free       |
| 50GB                 | ~$0.60/mo  |
| 100GB                | ~$1.35/mo  |
| 500GB                | ~$7.35/mo  |
| 1TB                  | ~$14.85/mo |

> Pricing: $0.015/GB over the free 10GB. Zero egress fees. Class A ops: 1M free then $4.50/million. Class B ops: 10M free then $0.36/million. At PoC scale (solo dev + early users) cost is effectively $0. At 500GB–1TB you have hundreds of active concurrent users and revenue to cover it.

> **R2 is live disk usage, not a rolling monthly data transfer allowance.** Aggressive post-render cleanup (delete raw clips immediately after Lambda completes) keeps live storage near zero regardless of throughput.

### Per-Export Cost at 10GB Input

| Component                                 | Free 1080p           | Paid 4K + AI (capped)   |
| ----------------------------------------- | -------------------- | ----------------------- |
| Lambda FFmpeg (10 min job)                | ~$0.060              | ~$0.210 (4K, 3.5× time) |
| `librosa` beat-sync                       | ~$0                  | ~$0                     |
| Gemini 2.0 Flash (context prompt)         | ~$0.001              | ~$0.001                 |
| Basic motion filter (FFmpeg frame-diff)   | ~$0                  | ~$0                     |
| Lambda vidstab (if used)                  | $0                   | ~$0.025                 |
| R2 storage (30-day retention)             | ~$0.0075             | ~$0.015                 |
| Google Video Intelligence (**5 min cap**) | $0                   | ~$0.50                  |
| Google Vision face detection (34 clips)   | $0                   | ~$0.143                 |
| **Total per export (10GB input)**         | **~$0.061 (£0.049)** | **~$0.879 (£0.703)**    |

> ⚠️ Without the 5 min GVI cap, paid AI cost hits ~$2.38/export (£1.90) on a 10GB project — well over net sub revenue. The cap is **mandatory**.

### Monthly Fixed Infrastructure

| Service                    | Free tier                         | Cost beyond           |
| -------------------------- | --------------------------------- | --------------------- |
| Vercel                     | Free (hobby)                      | $20/mo at scale       |
| Supabase                   | Free (500MB DB)                   | $25/mo at 8GB+        |
| Cloudflare R2              | 10GB live storage free, $0 egress | $0.015/GB after       |
| AWS Lambda                 | 400,000 GB-s free/mo              | $0.0000167/GB-s after |
| **Total: 0–200 users**     | **~$0**                           | —                     |
| **Total: 200–1,000 users** | —                                 | **~$30–80/mo**        |

---

## 9. Pricing

| Tier        | Price                 | Clips | Max file | Max project | Resolution | AI Auto-Edit                                                  | Exports/mo | Music           | Watermark |
| ----------- | --------------------- | ----- | -------- | ----------- | ---------- | ------------------------------------------------------------- | ---------- | --------------- | --------- |
| **Free**    | £0                    | 20    | 2GB      | 10GB        | 1080p      | ✅ Basic (beat-sync, vibe prompt, dead section removal)        | Unlimited  | ~20 free tracks | ❌ Never   |
| **Creator** | £4.99/mo or £39.99/yr | 50    | 4GB      | 20GB        | 4K         | ✅ Smart (GVI frame-level moment extraction, face/action zoom) | 5/mo       | Epidemic Sound  | ❌ Never   |

---

## 10. Competitive Positioning

**Clipchamp is the primary competitor to beat** — not CapCut or Filmora. It's pre-installed on every Windows PC, free at 1080p, web-first, and has no watermarks.

| Tool            | Web-first     | Windows | Auto-compile | Moment Extraction | Watermark   | Price     |
| --------------- | ------------- | ------- | ------------ | ----------------- | ----------- | --------- |
| **RushCut**     | ✅             | ✅       | ✅            | ✅ (paid: GVI)     | ❌ Never     | £4.99/mo  |
| DJI LightCut    | ❌ mobile only | ❌       | ✅            | ⚠️ basic          | ❌           | Free      |
| GoPro Quik      | ❌ mobile only | ❌       | ✅            | ⚠️ basic          | ❌           | Free      |
| Clipchamp       | ✅             | ✅       | ❌            | ❌                 | ❌           | Free/M365 |
| Kapwing         | ✅             | ✅       | ⚠️ prompt    | ❌                 | ✅ free tier | $16/mo    |
| CapCut          | ⚠️            | ⚠️      | ✅            | ⚠️                | ✅ free tier | £64.99/yr |
| DaVinci Resolve | ❌             | ✅       | ❌            | ❌                 | ❌           | Free/£270 |

---

## 11. Build Plan (Solo Dev, No-Rush, Claude Code Assisted)

### Phase 1 — Build for Yourself (Full Pipeline, Personal Validation)

> Goal: Produce one real YouTube video faster than DaVinci Resolve using only RushCut.

- [ ] **Batch 0:** FFmpeg pipeline spike — confirmed working ✅
- [ ] **Batch 1:** Next.js scaffold + all skeleton pages (navigable shells, no logic) ✅
- [ ] **Batch 2:** Supabase + Cloudflare R2 setup, presigned upload, ffprobe metadata, clip list wired
- [ ] **Batch 3:** FFmpeg Lambda — silence removal → moment extraction (basic) → clip splice → `xfade` transitions → `loudnorm` → 360p proxy
- [ ] **Batch 4:** Lambda integration + job queue + polling + R2 cleanup post-render (delete raw clips)
- [ ] **Batch 5:** `librosa` beat-sync + FFmpeg motion filter + Gemini 2.0 Flash context prompt
- [ ] **Batch 6:** 1080p final export end-to-end → author self-tests with own DJI footage
- [ ] **Batch 7:** Google Video Intelligence — frame-level moment extraction + clip ranking (5 min cap)
- [ ] **Batch 8:** Google Vision face detection → smart zoom target
- [ ] **Batch 9:** `ffmpeg-vidstab` stabilisation
- [ ] **Batch 10:** Full AI pipeline self-test

> ✅ Gate 1: Author produces one YouTube video using only RushCut. Genuinely faster than DaVinci?
> ✅ Gate 2: AI version extracts better moments than FFmpeg-only with no extra user effort?

### Phase 2 — Validate & Charge

- [ ] Fix top 3 issues from real user feedback
- [ ] Add Stripe — Creator tier (4K + smart AI)
- [ ] Implement export counter — enforce 5/month cap, reset on billing cycle
- [ ] Target: 5 paying strangers before any further feature work

---

## 12. Risks & Mitigations

| Risk                                                        | Likelihood | Impact    | Mitigation                                                                   |
| ----------------------------------------------------------- | ---------- | --------- | ---------------------------------------------------------------------------- |
| Clipchamp adds auto-compile                                 | Medium     | High      | Own the action/drone niche and moment extraction framing                     |
| DJI ships LightCut for Windows                              | Low        | Very High | Pivot to cross-device mixing (DJI + GoPro + iPhone)                          |
| Lambda cold start slows UX                                  | Medium     | Medium    | Provisioned concurrency for paid tier; progress indicator                    |
| Google Video Intelligence cost spikes                       | Medium     | High      | Hard cap at 5 min footage scored per export                                  |
| Paid user hits 5 export limit and churns                    | Low        | Medium    | Show counter transparently; offer £1 top-up credits (Phase 2+)               |
| 4K file uploads time out                                    | Medium     | Medium    | R2 presigned direct upload from browser                                      |
| Free tier too generous → low conversion                     | Medium     | Medium    | 4K wall + project size wall + GVI moment extraction wall are unbypassable    |
| Music licensing dispute                                     | Low        | High      | Start with Pixabay/ccMixter; Epidemic Sound only after revenue               |
| xfade transitions fail on mixed codecs/fps                  | High       | Medium    | Normalise all clips to consistent codec/fps on upload                        |
| Director feeling lost if Respin loop is slow                | Medium     | High      | Respin must complete in <10s at 360p                                         |
| Lambda /tmp overflow on large projects                      | Medium     | High      | Process clips sequentially/streamed — never load full project into memory    |
| Unlimited re-renders break unit economics                   | Medium     | High      | Two-tier change model (DEC-013) — cheap vs expensive changes                 |
| R2 storage overrun from concurrent users                    | Low        | Medium    | Delete raw clips immediately post-render; 30-day cleanup job for final files |
| Output length mismatch — user gets 8 min when they wanted 3 | Medium     | Medium    | Default to 3 min; surface length control early (see SD-007)                  |

---

## 13. Open Questions

1. **Music licensing:** ~20 Pixabay/ccMixter tracks on free tier; Epidemic Sound gated to paid tier. ✅ Resolved.
2. **Draft proxy quality:** Server-side 360p Lambda job. Real FFmpeg output. ✅ Resolved.
3. **Export free limit:** Unlimited exports on free tier. 1080p + 10GB project cap are the only hard limits. ✅ Resolved.
4. **Mobile web:** "Best on desktop" banner on mobile. No special mobile flow at MVP. ✅ Resolved.
5. **Stabilisation:** Benchmark `ffmpeg-vidstab` Lambda cost before committing to paid tier.
6. **Respin latency:** Single-clip re-cut at 360p must complete in <10s. Benchmark in Phase 1 Batch 3.
7. **Export counter UX:** Subtle persistent counter ("2 of 5 exports used") in dashboard header. Extra exports at £1.00 each (Phase 2+).
8. **Price point review:** Do not revisit until 50 paying users.
9. **AI direction (open-ended):** Deferred to v2 paid tier. v1 brief is a short hint only (DEC-014).

---

## 14. Pending Strategic Decisions

These need a decision before the relevant batch — flag when approaching each one:

| #          | Decision                                                                                                                                       | Needed by | Options                                                                                                                                                                                                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SD-001** | **R2 cleanup trigger** — delete raw clips immediately when Lambda finishes, or only after user confirms draft?                                 | Batch 4   | (a) Delete on Lambda complete — saves storage, user cannot re-render from original; (b) Delete on user confirm — keeps raw clips available for respin but costs more storage                                                                                                                                                                       |
| **SD-002** | **30-day retention scope** — does the 30-day library apply to free users or paid only?                                                         | Batch 4   | (a) All users authenticated → all get 30 days; (b) Free users get 24h link, paid get 30 days (stronger upgrade incentive)                                                                                                                                                                                                                          |
| **SD-003** | **Concurrent user queuing** — what does a user see when the system is busy?                                                                    | Batch 4   | (a) Show estimated wait time ("~3 mins"); (b) Silent queue, notify when ready; (c) Hard limit concurrent jobs and show "try again later"                                                                                                                                                                                                           |
| **SD-004** | **File size enforcement on paid tier** — 4GB per file cap. Real DJI 4K footage at 3 min = 1.4GB, so this is generous. Revisit if users hit it. | Phase 2   | Monitor usage data before changing                                                                                                                                                                                                                                                                                                                 |
| **SD-005** | **Respin scope** — single clip re-cut only, or allow full re-render from respin?                                                               | Batch 5   | PRD says single clip only; if Lambda complexity too high, fall back to full re-render as only correction path                                                                                                                                                                                                                                      |
| **SD-006** | **Auth timing** — PRD says login gate fires at "Make my edit" CTA. Does PoC (no auth) need a placeholder for this gate, or skip entirely?      | Batch 2/3 | Currently PoC uses localStorage projectId with no auth — decide when to wire Supabase Auth                                                                                                                                                                                                                                                         |
| **SD-007** | **Target output length** — should users be able to set their desired film duration?                                                            | Batch 3   | (a) Fixed default 3 min for all users — simplest, opinionated; (b) Free tier locked to 3 min, paid tier unlocks 5/10/15 min (upgrade incentive); (c) All users get a simple slider (1–15 min) — most flexible but adds UI complexity. Founder baseline: 3 min is right for hobbyist/YouTube. Vloggers needing 15 min are a different user segment. |

---

## 15. Strategic Clarity

**What this is:** LightCut UX + Clipchamp's web-first delivery + frame-level moment extraction that neither offers. That's the whole product.

**What "direction power" means in practice:** User uploads 62 clips from their vacation. Picks a vibe. Clicks compile. Gets a 3-minute film of the best moments — not a 3-hour editing session. Tweaks the 10% that feels off.

**The product mantra:** *Not “edit your clips” — “capture your moments.”*

**The honest moat:** The market is full of tools that either do too little or too much. RushCut's moat is restraint — knowing what to leave out. That's a product design moat, not a technical one.

**The Magisto lesson:** Their AI engine *was* the product. When Vimeo stripped it out post-acquisition, the "director feeling" disappeared and users left immediately. Never let the execution layer become a commodity.

---

*Last updated: March 2026 — Batch 2 infrastructure session. Next step: complete .env.local setup, then Claude Code implements Batch 2 wiring.*
