# PRD: RushCut — Rushes to a Cut — One-Click Web Video Editor

> **Product:** RushCut — *From your rushes to a cut. In minutes.*
> **Version:** 0.8 (updated March 2026)
> **Author:** Manasak
> **Status:** Draft — reassessed after founder validation session

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
| **Context-aware ordering** (\"start at flight, then hotel...\") | ⚠️ Free (basic) | Gemini 2.0 Flash ~$0.001/export — included on free tier |
| **Boring clip filtering** | ❌ No (basic) | FFmpeg frame-diff motion score — free tier; Google Video Intelligence = paid upgrade |
| **Stabilisation** | ✅ Yes (or FFmpeg vidstab) | `ffmpeg-vidstab` plugin = no AI, but compute-heavy → paid tier |
| **Volume normalisation** | ❌ No | FFmpeg `loudnorm` filter — free |

**Summary rule:**
- 🆓 Free tier: FFmpeg + librosa + Gemini Flash. Silence/stillness detection + basic trim + crossfade transitions + beat-sync music + generic centre-zoom + basic motion filter + context prompt (vibe/order) — near-zero AI cost (~$0.001/export)
- 💰 Paid AI tier: Smart clip scoring (Google Video Intelligence), action-aware zoom, boring clip filtering, face zoom (Google Vision), stabilisation, licensed music library, 4K export, project saves

---

## 5. Production Flow (Updated)

### One-click ideal (confirmed flow)

```
STEP 1 — UPLOAD
  User uploads all raw clips (drag & drop, bulk select)
  Free: up to 20 clips, max 500MB per file, max 5GB per project
  Paid: up to 50 clips, max 1GB per file, max 10GB per project
  Hard limits enforced client-side (pre-upload validation) AND server-side (reject oversized uploads).

STEP 2 — CONFIGURE (optional, single screen)
  - Order: auto (filename/time) or drag to reorder
  - AI tier: optional prompt → "Vacation in Bali — starts at airport, then hotel, beach, sunset"
  - Style: select transition style (crossfade / dip to black / hard cut / whip / fade to white)
  - Music: select from library (free: ~20 tracks | paid: full library)
  - Intro card: title text (optional)
  - End card: title text (optional)

STEP 3 — ONE CLICK → FIRST DRAFT
  App generates draft preview via a separate low-memory server-side Lambda job (360p).
  Draft proxy is NOT client-side blob stitching — it runs actual FFmpeg transitions, music,
  and zoom on the server at 360p. User sees real transitions/music/zoom in preview, not a simulation.
  AI tier: proposes key moments, zoom points, clip order on screen.
  User sees: film plays through with a clip strip below — not a timeline editor.

STEP 4 — REVIEW & CONFIRM ("Does this feel right?")
  The user reviews the film as a viewer, not an editor. Three actions only:
  - "Looks great → Export" — proceed to final render
  - Tap a clip in the strip → "Try a different moment from this clip" (Respin)
    → Lambda re-cuts just that one clip, no full re-render
  - "Change the vibe" → respin the whole film with a different style/music selection
  No frame-level controls. No accept/reject zoom UI. No timeline.
  User clicks "Looks good — produce final"

STEP 5 — FINAL RENDER
  Full-quality render triggered (server-side Lambda)
  Music track auto-fitted/beat-synced to final approved duration
  Download MP4: 1080p (free) | 4K (paid)
  Download link valid 24h
```

> ✅ **Confirmed:** Draft proxy is a separate low-memory Lambda job (360p), not client-side blob stitching. User sees actual FFmpeg transitions/music/zoom in preview — not a simulated preview.

> ✅ **Confirmed:** DJI LightCut does auto-adjust music — it detects beat markers and aligns cuts to rhythm automatically. RushCut does the same via `librosa` BPM detection (no AI cost).

> ✅ **Confirmed:** Step 4 is a film review, not an editing session. The Respin mechanic (per-clip re-cut) avoids the Magisto trap of either too much or too little control — user nudges, not rebuilds.

### Why a draft-then-confirm step?
- Avoids wasting a full 4K render on a version the user rejects
- Gives the user editorial control without forcing them into a full timeline editor
- Proxy draft is fast (low-res, server-rendered at 360p) — full render only on confirmation
- Zoom/music adjustments are applied to final confirmed version, not draft

---

## 6. Feature Scope

### v1 — Free Tier (PoC)
- [ ] Unlimited projects
- [ ] Up to 20 clips per project
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
- [ ] Download link valid 24h (auto-deleted from R2)
- [ ] **No export count limit** (cost per export ~£0.03 max at 5GB — sustainable)
- [ ] Beat-sync music cuts via `librosa` BPM detection
- [ ] Context prompt: user describes vibe/order ("adventure", "starts at airport then beach") — Gemini 2.0 Flash (~$0.001/export)
- [ ] Basic boring clip filtering (FFmpeg motion score — removes near-static clips automatically)
- [ ] **Respin per clip** — tap clip in preview strip → Lambda re-cuts just that clip (no full re-render)

### v2 — Paid Creator Tier (£4.99/mo or £39.99/yr)
- [ ] Up to 50 clips per project
- [ ] **Hard cap: 1GB per file, 10GB per project total** (enforced pre-upload)
- [ ] **Fair usage: max 5 final exports per month** (see Section 8 — real economics after Stripe + VAT)
- [ ] **4K export** (primary upgrade trigger)
- [ ] Smart clip scoring: Google Video Intelligence — action peaks + motion intensity → ranks best moments (upgrade over free basic motion filter)
- [ ] **Google Video Intelligence capped at 5 min of footage scored per export** (cost protection — see Section 8)
- [ ] Smart zoom: face detection + action moment zoom via Google Vision (upgrade over free generic centre zoom)
- [ ] Advanced context ordering: AI scene labelling via Google Video Intelligence (upgrade over free vibe prompt)
- [ ] Full licensed music library (Epidemic Sound — gated to paid tier)
- [ ] 15+ transition styles
- [ ] 15+ text/title styles (animated options: fade in, slide up, etc.)
- [ ] Video stabilisation (`ffmpeg-vidstab`)
- [ ] Project save + re-edit

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
| Context prompt | Gemini 2.0 Flash | AI — free tier (basic vibe prompt) |
| Stabilisation | `ffmpeg-vidstab` plugin | Compute-heavy — paid tier only |
| Payments | Stripe | Standard |

### Export Pipeline
```
User confirms draft
  → API triggers AWS Lambda (FFmpeg container)
  → Lambda fetches clips from R2
  → Runs: silence removal → trim → xfade transitions → music fit → zoom → normalise
  → Output written to R2 (temp 24h signed URL)
  → Download link returned to frontend
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

> **AWS/Google invoice VAT:** If VAT registered, you can reclaim input VAT on AWS/Google costs. If not, infra costs are ~20% higher in real terms on those bills.

### File Size Hard Caps

These caps are non-negotiable constraints — they exist to ensure per-export infrastructure cost never exceeds real subscription revenue after fees.

| Tier | Max per file | Max per project | Max exports/month |
|---|---|---|---|
| Free | 500MB | 5GB | Unlimited |
| Paid Creator | 1GB | 10GB | **5 (fair usage)** |

> **Why 5 exports/month (not 10)?** After Stripe fees, real budget is £4.665 pre-VAT. At a typical 5GB project, paid tier costs ~£0.56/export. 5 exports = £2.80 infra — leaving ~£1.86 actual margin (~40%). At 10 exports = £5.60 infra, which exceeds the £4.665 net revenue. 5 is the safe, profitable ceiling. Typical hobbyist (1–2 exports/month) never gets close.

> **Why unlimited on free?** Free tier at 5GB costs ~£0.025/export. 20 exports/month = £0.50. Still negligible vs. fixed infra costs.

### Cost Assumptions (Corrected for Large Projects)

- **Realistic project:** 10GB raw input → 5 min compiled output
- Lambda config: 3,008MB RAM
- Lambda pricing: $0.0000000333/GB-ms
- Processing time (10GB input): ~8–12 min Lambda job (codec normalise + silence removal + zoompan)
- 4K render = ~3.5× the 1080p Lambda time
- R2: $0.015/GB storage, $0 egress
- Google Video Intelligence: $0.10/min — **hard cap: 5 min of footage scored per export**
- Google Vision face detection: $0.0014/image × 3 frames × up to 34 clips

### Per-Export Cost at 10GB Input

| Component | Free 1080p | Paid 4K + AI (capped) |
|---|---|---|
| Lambda FFmpeg (10 min job) | ~$0.060 | ~$0.210 (4K, 3.5× time) |
| `librosa` beat-sync | ~$0 | ~$0 |
| Gemini 2.0 Flash (context prompt) | ~$0.001 | ~$0.001 |
| Basic motion filter (FFmpeg frame-diff) | ~$0 | ~$0 |
| Lambda vidstab (if used) | $0 | ~$0.025 |
| R2 storage (temp 24h) | ~$0 | ~$0 |
| Google Video Intelligence (**5 min cap**) | $0 | ~$0.50 |
| Google Vision face detection (34 clips) | $0 | ~$0.143 |
| **Total per export (10GB input)** | **~$0.061 (£0.049)** | **~$0.879 (£0.703)** |

> ⚠️ Without the 5 min GVI cap, paid AI cost hits ~$2.38/export (£1.90) on a 10GB project — well over net sub revenue. The cap is **mandatory** and must be enforced in the Lambda pipeline.

### Per-Export Cost at Typical Project Sizes

| Project size | Free cost | Paid cost (capped) | Safe exports within £4.665 net (20% buffer) |
|---|---|---|---|
| 3GB (light) | ~£0.015 | ~£0.510 | ~7 |
| 5GB (typical) | ~£0.025 | ~£0.560 | ~6 |
| 10GB (max) | ~£0.049 | ~£0.703 | ~5 |

> **Cap set at 5** to be safe at worst-case (10GB) project size with ~20% margin buffer built in.

### If Introducing Pay-Per-Export (Top-Up Credits)

For users who hit the 5/month cap and want more, a credit top-up avoids forcing a tier upgrade:

| Project size | Infra cost | Price per extra export (20% margin + Stripe) |
|---|---|---|
| ~3GB | £0.49 | ~£0.88 |
| ~5GB | £0.55 | ~£0.95 |
| ~10GB | £0.70 | ~£1.15 |

> **Simplest implementation:** Flat £1.00 per extra export (covers all project sizes with margin). Sell in packs of 5 (£5.00) via Stripe. This is a Phase 2+ feature — do not build at MVP.

### Monthly Fixed Infrastructure

| Service | Free tier | Cost beyond |
|---|---|---|
| Vercel | Free (hobby) | $20/mo at scale |
| Supabase | Free (500MB DB) | $25/mo at 8GB+ |
| Cloudflare R2 | 10GB-mo free, $0 egress | $0.015/GB storage after |
| AWS Lambda | 400,000 GB-s free/mo | $0.0000167/GB-s after |
| **Total: 0–200 users** | **~$0** | — |
| **Total: 200–1,000 users** | — | **~$30–80/mo** |

### Revenue vs. Cost at Paid Tier (Real Net)

| Paying Users | Net revenue after Stripe (£4.665/mo) | Est. infra (5GB project, 2 exports/mo) | Real margin |
|---|---|---|---|
| 10 | £46.65 | ~£11 | ~76% |
| 50 | £233.25 | ~£56 | ~76% |
| 200 | £933 | ~£224 | ~76% |

> ⚠️ Music licensing is the wildcard. Epidemic Sound API: ~$15/mo for indie devs. Artlist: ~$200/yr. Pixabay/ccMixter: free. Start free, add licensed library as paid-only upgrade.

---

## 9. Pricing

| Tier | Price | Clips | Max file | Max project | Resolution | AI Auto-Edit | Exports/mo | Music | Watermark |
|---|---|---|---|---|---|---|---|---|---|
| **Free** | £0 | 20 | 500MB | 5GB | 1080p | ✅ Basic (beat-sync, vibe prompt, motion filter) | Unlimited | ~20 free tracks | ❌ Never |
| **Creator** | £4.99/mo or £39.99/yr | 50 | 1GB | 10GB | 4K | ✅ Smart (scene scoring, face/action zoom) | 5/mo | Epidemic Sound | ❌ Never |

> **Conversion model note:** Free tier includes genuine AI auto-edit — better than Clipchamp's free tier by design. Paid upgrades sell *smarter* AI decisions (scene scoring, face/action zoom) + 4K + larger project capacity + premium music. Hook: free gets you a great first film; paid gets you a better film with zero extra effort.

> **Fair usage note (paid):** 5 exports/month is a safety ceiling based on real net revenue after Stripe fees. Typical hobbyist uses 1–2/month — this limit is never felt. Shown transparently in UI as a counter. Extra exports available at £1.00 each (Phase 2+).

---

## 10. Competitive Positioning

**Clipchamp is the primary competitor to beat** — not CapCut or Filmora. It's pre-installed on every Windows PC, free at 1080p, web-first, and has no watermarks. Clipchamp allows 99 clips/project on free with no watermark and unlimited exports at 1080p. RushCut differentiates not on generosity but on auto-compile and direction power — Clipchamp is still a blank timeline.

| Tool | Web-first | Windows | Auto-compile | Direction Power | Watermark | Price |
|---|---|---|---|---|---|---|
| **RushCut** | ✅ | ✅ | ✅ | ✅ | ❌ Never | £4.99/mo |
| DJI LightCut | ❌ mobile only | ❌ | ✅ | ✅ | ❌ | Free |
| GoPro Quik | ❌ mobile only | ❌ | ✅ | ⚠️ | ❌ | Free |
| Clipchamp | ✅ | ✅ | ❌ | ❌ | ❌ | Free/M365 |
| Kapwing | ✅ | ✅ | ⚠️ prompt | ⚠️ | ✅ free tier | $16/mo |
| CapCut | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ free tier | £64.99/yr |
| DaVinci Resolve | ❌ | ✅ | ❌ | ❌ | ❌ | Free/£270 |

**The real white space:** DJI LightCut's UX on a desktop browser, with slightly more editing control. That's the entire product brief.

---

## 11. Build Plan (Solo Dev, No-Rush, Claude Code Assisted)

**Context:** Third personal dev project. Previous: SpellWiz game (success — daughter uses daily), Chrome extension (shipped, launching on Product Hunt). First paid-tier ambition. Using Claude Code as primary coding assistant. No fixed deadline — solve the personal problem first, validate commercial potential second.

### Phase 1 — Build for Yourself (Full Pipeline, Personal Validation)

> Goal: Produce one real YouTube video faster than DaVinci Resolve using only RushCut.

- [ ] **Step 1:** Next.js scaffold, Supabase auth, Cloudflare R2 presigned upload working
- [ ] **Step 1b:** File size validation — reject uploads exceeding per-file and per-project caps at the client AND server
- [ ] **Step 2:** FFmpeg Lambda — silence removal → clip splice → `xfade` transitions → `loudnorm`
- [ ] **Step 3:** `librosa` beat-sync + FFmpeg motion filter (basic boring clip removal)
- [ ] **Step 4:** Gemini 2.0 Flash context prompt (vibe/order direction)
- [ ] **Step 5:** 1080p export end-to-end → author self-tests with own DJI footage
- [ ] **Step 6:** Google Video Intelligence scene scoring + clip ranking — **implement 5 min footage cap here**
- [ ] **Step 7:** Google Vision face detection → smart zoom target
- [ ] **Step 8:** `ffmpeg-vidstab` stabilisation
- [ ] **Step 9:** Full AI pipeline self-test — does it produce a noticeably better first draft than FFmpeg-only?

> ✅ Gate 1: Author produces one YouTube video using only RushCut. Genuinely faster than DaVinci?
> ✅ Gate 2: AI version produces a better first draft than FFmpeg-only version with no extra user effort?

⚠️ Cost discipline: Use FFmpeg-only pipeline for all dev testing. Only run full AI stack for genuine validation sessions.

### Phase 2 — Validate & Charge (5 Strangers Before Anything Else)
- [ ] Fix top 3 issues from real user feedback (DJI forums, r/dji, r/gopro)
- [ ] Add Stripe — Creator tier (4K + smart AI)
- [ ] Implement export counter in Supabase — enforce 5/month cap for paid users, reset on billing cycle
- [ ] Target: 5 paying strangers before any further feature work
- [ ] Phase 2+ only: flat £1.00 per extra export credit pack (5 for £5.00)

**Timeline philosophy:** No rush. Each gate must be genuinely passed before moving on. The author's own DJI filming sessions are the real-world test loop.

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Clipchamp adds auto-compile feature | Medium | High | Own the action/drone niche and "direction power" framing; Clipchamp is a Microsoft product unlikely to move fast on this |
| DJI ships LightCut for Windows | Low | Very High | This is the nuclear scenario — monitor DJI roadmap; if they ship, pivot to cross-device (DJI + GoPro + iPhone) mixing which they'll never prioritise |
| Lambda cold start slows export UX | Medium | Medium | Provisioned concurrency for paid tier; show progress indicator |
| Google Video Intelligence cost spikes | Medium | High | **Hard cap at 5 min footage scored per export — enforced in Lambda, not just config** |
| Paid user hits 5 export limit and churns | Low | Medium | Show counter transparently; offer £1 top-up credits (Phase 2+); typical user never hits the cap |
| Stripe fee erosion at higher volume | Low | Low | At scale, negotiate Stripe pricing or switch to Stripe Billing optimised plans |
| VAT registration triggered at scale | Low | Medium | Price is £4.99 inc VAT from day one — absorb until registration, then reclaim on costs |
| 4K file uploads time out | Medium | Medium | R2 presigned direct upload from browser (bypasses server) |
| Free tier too generous → low conversion | Medium | Medium | 4K wall + project size wall (5GB vs 10GB) are unbypassable; AI features must feel genuinely magical in v2 |
| Music licensing dispute | Low | High | Start with Pixabay/ccMixter; add Epidemic Sound only after revenue |
| xfade transitions fail on mixed codecs/fps | High | Medium | Normalise all clips to consistent codec/fps on upload (FFmpeg pre-pass) — must be solved in Week 2 |
| "Director feeling" lost if Respin loop is too slow | Medium | High | Respin must feel instant — Lambda re-cut of single clip should complete in <10s at 360p; gate this in Phase 1 testing |
| Lambda /tmp overflow on large projects | Medium | High | Process clips sequentially/streamed — never load full project into Lambda memory at once. Default /tmp = 512MB; max = 10GB but must be explicitly configured |

**Founder floor:** If commercial validation fails, the tool still solves the author's own DaVinci Resolve time problem. That's a valid floor — no sunk cost pressure.

---

## 13. Open Questions

1. **Music licensing:** ~~Pixabay/ccMixter (free) → Epidemic Sound ($15/mo) when?~~ **RESOLVED:** ~20 Pixabay/ccMixter tracks on free tier; Epidemic Sound gated to paid tier from day 1.
2. **Draft proxy quality:** ~~How low-res is acceptable for the "confirm before final render" step?~~ **RESOLVED:** Server-side 360p Lambda job. Real FFmpeg output — not a simulation.
3. **Export free limit:** ~~Is 3 exports/month tight enough without frustrating free users?~~ **RESOLVED:** Unlimited exports on free tier. 1080p + 5GB project cap are the only hard limits.
4. **Mobile web:** ~~At MVP, should mobile just trigger upload + configure, with render happening async and notified via email?~~ **RESOLVED:** Tailwind responsive by default. "Best on desktop" banner shown on mobile. No special mobile flow at MVP.
5. **Stabilisation:** `ffmpeg-vidstab` is free but slow — benchmark Lambda cost before committing to paid tier feature.
6. **Respin latency:** Single-clip re-cut at 360p must complete in <10s to preserve director feeling. Benchmark this in Phase 1 Step 2.
7. **Export counter UX:** How to surface the 5/month paid cap without feeling punitive? **Open** — consider a subtle persistent counter ("2 of 5 exports used this month") in the dashboard header. Extra exports available at £1.00 each.
8. **Price point review:** At scale, if 76% gross margin is stable after real Stripe+infra costs, consider whether £4.99 leaves headroom or if £6.99 is more defensible. Do not revisit until 50 paying users.

---

## 14. Strategic Clarity (v0.3 additions)

**What this is:** LightCut UX + Clipchamp's web-first delivery + slightly more editing control than either. That's the whole product. Don't let scope drift from this.

**What "direction power" means in practice:** User uploads clips, picks a vibe (adventure / relaxed / cinematic), picks music, clicks compile. Gets a 90% film. Tweaks the 10%. That interaction model is the core IP — not any specific feature.

**The honest moat:** The market is full of tools that either do too little or too much. RushCut's moat is restraint — knowing what to leave out. That's a product design moat, not a technical one.

**The Magisto lesson:** Their AI engine *was* the product. When Vimeo stripped it out post-acquisition, the "director feeling" disappeared and users left immediately. Never let the execution layer become a commodity — it is the product.

---

*Next step: Build the Lambda pipeline locally in Docker. Feed it 5 real DJI clips. Get one exported MP4 out. If that works, everything else is solvable.*
