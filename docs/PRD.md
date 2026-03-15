# PRD: RushCut — Rushes to a Cut — One-Click Web Video Editor

> **Product:** RushCut — *Your clips. Edited.*
> **Version:** 0.9 (updated March 2026)
> **Author:** Manasak
> **Status:** Draft — updated after Batch 1 UX/flow session

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

| Attribute | Description |
|---|---|
| **Primary** | Hobbyist action/drone/travel videographers |
| **Device** | Shoots on DJI drone, GoPro, iPhone — transfers to Windows PC |
| **Destination** | YouTube (family/friends), Instagram, personal archive |
| **Core pain** | The gap between "I want a shareable film" and "I just spent 3 hours in DaVinci on a 3-min clip" |
| **Current workaround** | Either tolerating mobile-only tools (LightCut) or suffering through timeline editors (DaVinci, Resolve) |
| **What they want** | *Direction power* — tell the tool the vibe, get a solid first draft, tweak only what matters |
| **What they don't want** | Timeline micro-management, AI gimmicks, watermarks, subscriptions for features they never use |
| **Willingness to pay** | £4–8/mo to reclaim 2+ hours per video — or more honestly, to *want to edit at all* |
| **Tech comfort** | Beginner–intermediate; has used Clipchamp but found it still too manual |

**User quote (founder, validated):**
> *"I use DaVinci Resolve but spend hours on each 3-min clip I produce for YouTube to show family — it makes little sense. If I could genuinely help people avoid that, they could focus on the fun part — making video."*

---

## 3. Product Vision

> *"From your raw footage to a shareable film in under 5 minutes — no editing skills required."*

Web-first (desktop browser primary, Windows PC workflow). No download. No watermarks on any tier. No AI generation gimmicks.

**The positioning bet:** In a market obsessing over AI features, RushCut wins by doing one thing exceptionally well — auto-compiling footage into a watchable film with smart structure, transitions, and music. The differentiator is *simplicity and editorial direction*, not features.

**Design principle:** Every screen should feel like you're making creative choices, not managing software.

### Director, not Editor

RushCut's core UX principle: the user is always making *creative decisions*, never *technical ones*. They say "make it cinematic, start with the mountain shots" — RushCut handles clip selection, trim points, transition timing, zoom in/out animation, and text animation style. The user never touches a timeline. They review a film, not a sequence of clips.

The magic of feeling like a director must never be lost. What gets outsourced is the tedious execution: clip-by-clip assembly, deciding where transitions start and stop, animating text, applying zooms. What stays with the user is intent and creative direction. This is the exact positioning lesson from Magisto's failure — when Vimeo stripped out the AI engine, the "director feeling" disappeared and users left immediately. The AI engine *is* the product.

---

## 4. What Needs AI vs. What's Free (FFmpeg)

This is the core technical decision — knowing which features require AI vs. can run on pure FFmpeg determines tier gating and cost.

| Feature | Needs AI? | How |
|---|---|---|
| **Silence/stillness removal** | ❌ No | FFmpeg `silencedetect` + frame-diff motion score — pure signal processing |
| **Auto-add transitions** (crossfade, dip to black) | ❌ No | FFmpeg `xfade` filter — applied at every clip join point automatically |
| **Auto-fit music to video duration** | ❌ No | FFmpeg cuts/fades audio track to exact output duration |
| **Beat-sync music cutting** | ❌ No | `librosa` open-source Python — free, included on free tier |
| **Zoom effect (generic, centre-frame)** | ❌ No | FFmpeg `zoompan` filter — auto-applied at clip midpoints |
| **Zoom on faces / people** | ✅ Yes | Requires face detection (e.g. Google Vision API or OpenCV) |
| **Zoom on key action moments** | ✅ Yes | Requires motion + scene scoring (Google Video Intelligence API) |
| **Smart clip trimming** (best N seconds per clip) | ✅ Yes | Motion scoring + saliency detection per clip |
| **Context-aware ordering** ("start at flight, then hotel...") | ⚠️ Free (basic) | Gemini 2.0 Flash ~$0.001/export — included on free tier |
| **Boring clip filtering** | ❌ No (basic) | FFmpeg frame-diff motion score — free tier; Google Video Intelligence = paid upgrade |
| **Stabilisation** | ✅ Yes (or FFmpeg vidstab) | `ffmpeg-vidstab` plugin = no AI, but compute-heavy → paid tier |
| **Volume normalisation** | ❌ No | FFmpeg `loudnorm` filter — free |

**Summary rule:**
- 🆓 Free tier: FFmpeg + librosa + Gemini Flash. Silence/stillness detection + basic trim + crossfade transitions + beat-sync music + generic centre-zoom + basic motion filter + context prompt (vibe/order) — near-zero AI cost (~$0.001/export)
- 💰 Paid AI tier: Smart clip scoring (Google Video Intelligence), action-aware zoom, boring clip filtering, face zoom (Google Vision), stabilisation, licensed music library, 4K export, project saves

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
  Subhead:    "Up to 20 clips. MP4, MOV or MKV, up to 1 GB each."
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
- [ ] **Hard cap: 500MB per file, 5GB per project total** (enforced pre-upload)
- [ ] Auto-combine in upload/timestamp order
- [ ] Silence + stillness detection → auto-remove dead sections (FFmpeg)
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

### v2 — Paid Creator Tier (£4.99/mo or £39.99/yr)
- [ ] Up to 50 clips per project
- [ ] **Hard cap: 1GB per file, 10GB per project total** (enforced pre-upload)
- [ ] **Fair usage: max 5 final exports per month** (see Section 8 — real economics after Stripe + VAT)
- [ ] **4K export** (primary upgrade trigger)
- [ ] Smart clip scoring: Google Video Intelligence — action peaks + motion intensity → ranks best moments
- [ ] **Google Video Intelligence capped at 5 min of footage scored per export** (cost protection)
- [ ] Smart zoom: face detection + action moment zoom via Google Vision
- [ ] Advanced context ordering: AI scene labelling via Google Video Intelligence
- [ ] Full licensed music library (Epidemic Sound — gated to paid tier)
- [ ] 15+ transition styles
- [ ] 15+ text/title styles (animated options: fade in, slide up, etc.)
- [ ] Video stabilisation (`ffmpeg-vidstab`)
- [ ] Project save + re-edit
- [ ] Open-ended AI direction (free-text "describe your film") — see DEC-014

### Permanently Out of Scope
- AI video generation (text-to-video)
- Multi-track timeline editor
- Colour grading
- Captions / subtitles
- Team / collaboration

---

## 7. Technical Architecture

### Stack
| Layer | Tool | Rationale |
|---|---|---|
| Frontend | Next.js (App Router) | Fast, Vercel-deployable |
| UI | Tailwind + shadcn/ui | Rapid prototyping — responsive by default; "best on desktop" banner shown on mobile; no special mobile flow at MVP |
| Auth + DB | Supabase | Free tier covers PoC |
| File storage | Cloudflare R2 | Zero egress fees — critical for large video files |
| Proxy preview | FFmpeg (server-side 360p Lambda, separate low-memory job) | Real FFmpeg output at low res — not client blob stitching |
| Full render | FFmpeg on AWS Lambda (containerised) | Serverless, scales to zero, pay-per-export |
| Silence detection | FFmpeg `silencedetect` | Free, no AI |
| Stillness detection | FFmpeg frame diff (Python script) | Free, no AI |
| Transitions | FFmpeg `xfade` | Free, no AI |
| Music fit | FFmpeg audio trim + fade | Free, no AI |
| Beat-sync | `librosa` Python (Lambda) | Free, open-source |
| Zoom (generic) | FFmpeg `zoompan` | Free, no AI |
| Zoom (smart, faces) | OpenCV or Google Vision API | AI — paid tier only |
| Scene scoring | Google Video Intelligence API | AI — paid tier only; hard-capped at 5 min/export |
| Context prompt | Gemini 2.0 Flash | AI — free tier (basic vibe prompt / defaults only) |
| Stabilisation | `ffmpeg-vidstab` plugin | Compute-heavy — paid tier only |
| Payments | Stripe | Standard |

### Export Pipeline
```
User confirms draft
  → API triggers AWS Lambda (FFmpeg container)
  → Lambda fetches clips from R2
  → Runs: silence removal → trim → xfade transitions → music fit → zoom → normalise
  → Output written to R2 (retained 30 days for authenticated user)
  → Download available in library
```

---

## 8. Cost Model (Realistic, Bootstrapped)

### Real Economics Per Subscriber

The £4.99 headline price is not what lands in the bank. Real budget per paying user:

| Scenario | Gross | Stripe fee (1.5% + 25p) | Net to bank |
|---|---|---|---|
| Pre-VAT registration | £4.99 | £0.325 | **£4.665** |
| VAT registered (£4.99 inc VAT) | £4.165 net | £0.312 | **£3.853** |

> **VAT registration threshold (UK):** £90,000 turnover. At £4.99/mo, that's ~18,000 subscribers before mandatory VAT registration. Pre-registration, £4.665 is the real budget. Post-registration, £3.853. Plan for the lower figure from day one.

### File Size Hard Caps

| Tier | Max per file | Max per project | Max exports/month |
|---|---|---|---|
| Free | 500MB | 5GB | Unlimited |
| Paid Creator | 1GB | 10GB | **5 (fair usage)** |

> **Why 5 exports/month?** After Stripe fees, real budget is £4.665 pre-VAT. At a typical 5GB project, paid tier costs ~£0.56/export. 5 exports = £2.80 infra — leaving ~£1.86 actual margin (~40%). At 10 exports = £5.60 infra, which exceeds the £4.665 net revenue.

### Per-Export Cost at 10GB Input

| Component | Free 1080p | Paid 4K + AI (capped) |
|---|---|---|
| Lambda FFmpeg (10 min job) | ~$0.060 | ~$0.210 (4K, 3.5× time) |
| `librosa` beat-sync | ~$0 | ~$0 |
| Gemini 2.0 Flash (context prompt) | ~$0.001 | ~$0.001 |
| Basic motion filter (FFmpeg frame-diff) | ~$0 | ~$0 |
| Lambda vidstab (if used) | $0 | ~$0.025 |
| R2 storage (30-day retention) | ~$0.0075 | ~$0.015 |
| Google Video Intelligence (**5 min cap**) | $0 | ~$0.50 |
| Google Vision face detection (34 clips) | $0 | ~$0.143 |
| **Total per export (10GB input)** | **~$0.061 (£0.049)** | **~$0.879 (£0.703)** |

> ⚠️ Without the 5 min GVI cap, paid AI cost hits ~$2.38/export (£1.90) on a 10GB project — well over net sub revenue. The cap is **mandatory**.

### Monthly Fixed Infrastructure

| Service | Free tier | Cost beyond |
|---|---|---|
| Vercel | Free (hobby) | $20/mo at scale |
| Supabase | Free (500MB DB) | $25/mo at 8GB+ |
| Cloudflare R2 | 10GB-mo free, $0 egress | $0.015/GB storage after |
| AWS Lambda | 400,000 GB-s free/mo | $0.0000167/GB-s after |
| **Total: 0–200 users** | **~$0** | — |
| **Total: 200–1,000 users** | — | **~$30–80/mo** |

---

## 9. Pricing

| Tier | Price | Clips | Max file | Max project | Resolution | AI Auto-Edit | Exports/mo | Music | Watermark |
|---|---|---|---|---|---|---|---|---|---|
| **Free** | £0 | 20 | 500MB | 5GB | 1080p | ✅ Basic (beat-sync, vibe prompt, motion filter) | Unlimited | ~20 free tracks | ❌ Never |
| **Creator** | £4.99/mo or £39.99/yr | 50 | 1GB | 10GB | 4K | ✅ Smart (scene scoring, face/action zoom) | 5/mo | Epidemic Sound | ❌ Never |

---

## 10. Competitive Positioning

**Clipchamp is the primary competitor to beat** — not CapCut or Filmora. It's pre-installed on every Windows PC, free at 1080p, web-first, and has no watermarks.

| Tool | Web-first | Windows | Auto-compile | Direction Power | Watermark | Price |
|---|---|---|---|---|---|---|
| **RushCut** | ✅ | ✅ | ✅ | ✅ | ❌ Never | £4.99/mo |
| DJI LightCut | ❌ mobile only | ❌ | ✅ | ✅ | ❌ | Free |
| GoPro Quik | ❌ mobile only | ❌ | ✅ | ⚠️ | ❌ | Free |
| Clipchamp | ✅ | ✅ | ❌ | ❌ | ❌ | Free/M365 |
| Kapwing | ✅ | ✅ | ⚠️ prompt | ⚠️ | ✅ free tier | $16/mo |
| CapCut | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ free tier | £64.99/yr |
| DaVinci Resolve | ❌ | ✅ | ❌ | ❌ | ❌ | Free/£270 |

---

## 11. Build Plan (Solo Dev, No-Rush, Claude Code Assisted)

### Phase 1 — Build for Yourself (Full Pipeline, Personal Validation)

> Goal: Produce one real YouTube video faster than DaVinci Resolve using only RushCut.

- [ ] **Batch 0:** FFmpeg pipeline spike — confirmed working ✅
- [ ] **Batch 1:** Next.js scaffold + all skeleton pages (navigable shells, no logic)
- [ ] **Batch 2:** Supabase auth, Cloudflare R2 presigned upload, file size validation
- [ ] **Batch 3:** FFmpeg Lambda — silence removal → clip splice → `xfade` transitions → `loudnorm` → 360p proxy
- [ ] **Batch 4:** `librosa` beat-sync + FFmpeg motion filter + Gemini 2.0 Flash context prompt
- [ ] **Batch 5:** 1080p final export end-to-end → author self-tests with own DJI footage
- [ ] **Batch 6:** Google Video Intelligence scene scoring + clip ranking (5 min cap)
- [ ] **Batch 7:** Google Vision face detection → smart zoom target
- [ ] **Batch 8:** `ffmpeg-vidstab` stabilisation
- [ ] **Batch 9:** Full AI pipeline self-test

> ✅ Gate 1: Author produces one YouTube video using only RushCut. Genuinely faster than DaVinci?
> ✅ Gate 2: AI version produces a better first draft than FFmpeg-only with no extra user effort?

### Phase 2 — Validate & Charge
- [ ] Fix top 3 issues from real user feedback
- [ ] Add Stripe — Creator tier (4K + smart AI)
- [ ] Implement export counter — enforce 5/month cap, reset on billing cycle
- [ ] Target: 5 paying strangers before any further feature work

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Clipchamp adds auto-compile | Medium | High | Own the action/drone niche and direction power framing |
| DJI ships LightCut for Windows | Low | Very High | Pivot to cross-device mixing (DJI + GoPro + iPhone) |
| Lambda cold start slows UX | Medium | Medium | Provisioned concurrency for paid tier; progress indicator |
| Google Video Intelligence cost spikes | Medium | High | Hard cap at 5 min footage scored per export |
| Paid user hits 5 export limit and churns | Low | Medium | Show counter transparently; offer £1 top-up credits (Phase 2+) |
| 4K file uploads time out | Medium | Medium | R2 presigned direct upload from browser |
| Free tier too generous → low conversion | Medium | Medium | 4K wall + project size wall are unbypassable |
| Music licensing dispute | Low | High | Start with Pixabay/ccMixter; Epidemic Sound only after revenue |
| xfade transitions fail on mixed codecs/fps | High | Medium | Normalise all clips to consistent codec/fps on upload |
| Director feeling lost if Respin loop is slow | Medium | High | Respin must complete in <10s at 360p |
| Lambda /tmp overflow on large projects | Medium | High | Process clips sequentially/streamed — never load full project into memory |
| Unlimited re-renders break unit economics | Medium | High | Two-tier change model (DEC-013) — cheap vs expensive changes |

---

## 13. Open Questions

1. **Music licensing:** ~20 Pixabay/ccMixter tracks on free tier; Epidemic Sound gated to paid tier. ✅ Resolved.
2. **Draft proxy quality:** Server-side 360p Lambda job. Real FFmpeg output. ✅ Resolved.
3. **Export free limit:** Unlimited exports on free tier. 1080p + 5GB project cap are the only hard limits. ✅ Resolved.
4. **Mobile web:** "Best on desktop" banner on mobile. No special mobile flow at MVP. ✅ Resolved.
5. **Stabilisation:** Benchmark `ffmpeg-vidstab` Lambda cost before committing to paid tier.
6. **Respin latency:** Single-clip re-cut at 360p must complete in <10s. Benchmark in Phase 1 Batch 3.
7. **Export counter UX:** Subtle persistent counter ("2 of 5 exports used") in dashboard header. Extra exports at £1.00 each (Phase 2+).
8. **Price point review:** Do not revisit until 50 paying users.
9. **AI direction (open-ended):** Deferred to v2 paid tier. v1 brief is a short hint only (DEC-014).

---

## 14. Strategic Clarity

**What this is:** LightCut UX + Clipchamp's web-first delivery + slightly more editing control than either. That's the whole product.

**What "direction power" means in practice:** User uploads clips, picks a vibe (adventure / relaxed / cinematic), picks music, clicks compile. Gets a 90% film. Tweaks the 10%.

**The honest moat:** The market is full of tools that either do too little or too much. RushCut's moat is restraint — knowing what to leave out. That's a product design moat, not a technical one.

**The Magisto lesson:** Their AI engine *was* the product. When Vimeo stripped it out post-acquisition, the "director feeling" disappeared and users left immediately. Never let the execution layer become a commodity.

---

*Next step: Complete Batch 1 scaffold. Get all 5 pages navigable locally. Then Batch 2: auth + upload.*
