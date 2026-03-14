# PRD: RushCut — Rushes to a Cut — One-Click Web Video Editor

> **Product:** RushCut — *From your rushes to a cut. In minutes.*
> **Version:** 0.4 (updated March 2026)
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

---

## 4. What Needs AI vs. What's Free (FFmpeg)

This is the core technical decision — knowing which features require AI vs. can run on pure FFmpeg determines tier gating and cost.

| Feature | Needs AI? | How |
|---|---|---|
| **Silence/stillness removal** | ❌ No | FFmpeg `silencedetect` + frame-diff motion score — pure signal processing |
| **Auto-add transitions** (crossfade, dip to black) | ❌ No | FFmpeg `xfade` filter — applied at every clip join point automatically |
| **Auto-fit music to video duration** | ❌ No | FFmpeg cuts/fades audio track to exact output duration |
| **Beat-sync music cutting** | ❌ No | `librosa` (open-source Python) — BPM detection + cut-point alignment |
| **Zoom effect (generic, centre-frame)** | ❌ No | FFmpeg `zoompan` filter — auto-applied at clip midpoints |
| **Zoom on faces / people** | ✅ Yes | Requires face detection (e.g. Google Vision API or OpenCV) |
| **Zoom on key action moments** | ✅ Yes | Requires motion + scene scoring (Google Video Intelligence API) |
| **Smart clip trimming** (best N seconds per clip) | ✅ Yes | Motion scoring + saliency detection per clip |
| **Context-aware ordering** ("start at flight, then hotel...") | ✅ Yes | Multimodal LLM (Gemini 2.0 Flash) reads user prompt + video metadata |
| **Boring clip filtering** | ✅ Yes | Action/motion scoring to rank clips, skip low-score segments |
| **Stabilisation** | ✅ Yes (or FFmpeg vidstab) | `ffmpeg-vidstab` plugin = no AI, but compute-heavy → paid tier |
| **Volume normalisation** | ❌ No | FFmpeg `loudnorm` filter — free |

**Summary rule:**
- 🆓 Free tier: FFmpeg-only pipeline. Silence/stillness detection + basic trim + crossfade transitions + music duration-fit + generic centre-zoom
- 💰 Paid AI tier: Smart clip scoring, action-aware zoom, boring clip skipping, beat-sync, context prompt, face zoom, stabilisation, licensed music library

---

## 5. Production Flow (Updated)

### One-click ideal (confirmed flow)

```
STEP 1 — UPLOAD
  User uploads all raw clips (drag & drop, bulk select)
  Free: up to 20 clips, no duration cap | Paid: up to 50 clips

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
  User sees: timeline strip with proposed cuts + zoom markers.

STEP 4 — REVIEW & CONFIRM
  User can:
  - Adjust in/out trim per clip (drag handles)
  - Accept/reject proposed zoom moments
  - Swap music track
  - Accept/reject AI-proposed clip order
  User clicks "Looks good — produce final"

STEP 5 — FINAL RENDER
  Full-quality render triggered (server-side Lambda)
  Music track auto-fitted/beat-synced to final approved duration
  Download MP4: 1080p (free) | 4K (paid)
  Download link valid 24h
```

> ✅ **Confirmed:** Draft proxy is a separate low-memory Lambda job (360p), not client-side blob stitching. User sees actual FFmpeg transitions/music/zoom in preview — not a simulated preview.

> ✅ **Confirmed:** DJI LightCut does auto-adjust music — it detects beat markers and aligns cuts to rhythm automatically. RushCut does the same via `librosa` BPM detection (no AI cost).

### Why a draft-then-confirm step?
- Avoids wasting a full 4K render on a version the user rejects
- Gives the user editorial control without forcing them into a full timeline editor
- Proxy draft is fast (low-res, server-rendered at 360p) — full render only on confirmation
- Zoom/music adjustments are applied to final confirmed version, not draft

---

## 6. Feature Scope

### v1 — Free Tier (PoC)
- [ ] Unlimited projects
- [ ] Up to 20 clips per project, no duration cap
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
- [ ] **No export count limit**

### v2 — Paid Creator Tier (£4.99/mo or £39.99/yr)
- [ ] Up to 50 clips per project
- [ ] **4K export** (primary upgrade trigger)
- [ ] Context prompt: user describes video ("vacation in Bali, starts at airport...")
- [ ] AI scene scoring: detects action peaks, motion, faces → smart clip trimming
- [ ] Boring clip filtering: skips low-motion, low-content segments
- [ ] Smart zoom: face detection + action moment zoom (not generic centre)
- [ ] Beat-sync cutting via `librosa` BPM
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
| Scene scoring | Google Video Intelligence API | AI — paid tier only |
| Context prompt | Gemini 2.0 Flash | AI — paid tier only |
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

### Assumptions
- Average project: 10 clips × 30s = 5 min raw footage → 2 min compiled film
- 1080p output: ~300MB | 4K output: ~1.2GB
- Lambda config: 3,008MB RAM (needed for FFmpeg video)
- Lambda pricing: $0.0000000333/GB-ms → 60s 1080p job = ~$0.006 | 240s 4K = ~$0.024
- R2: $0.015/GB storage, $0 egress (Cloudflare waives egress fees)
- Google Video Intelligence: $0.10/min after first 1,000 min/month free

### Per-Export Cost

| Component | Free 1080p | Paid 4K + AI |
|---|---|---|
| Lambda FFmpeg (splice + transitions + music) | ~$0.006 | ~$0.024 |
| Lambda librosa beat-sync | $0 | ~$0.001 |
| Lambda vidstab stabilisation (if used) | $0 | ~$0.010 |
| R2 storage (temp 24h) | ~$0.000005 | ~$0.000018 |
| Google Video Intelligence (shot + label, 2 min) | $0 | ~$0.20 (post free tier) |
| Google Vision API (face detection, per clip) | $0 | ~$0.014 (10 clips × $0.0014) |
| Gemini 2.0 Flash (context prompt) | $0 | ~$0.001 |
| **Total per export** | **~$0.006 (£0.005)** | **~$0.25 (£0.20)** |

> ✅ Google Video Intelligence: first 1,000 min/month free. At 2 min per project = **500 free AI exports/month** before any AI cost. Covers the entire PoC phase at zero AI cost.

### Monthly Fixed Infrastructure

| Service | Free tier | Cost beyond |
|---|---|---|
| Vercel | Free (hobby) | $20/mo at scale |
| Supabase | Free (500MB DB) | $25/mo at 8GB+ |
| Cloudflare R2 | 10GB-mo free, $0 egress | $0.015/GB storage after |
| AWS Lambda | 400,000 GB-s free/mo | $0.0000167/GB-s after |
| **Total: 0–200 users** | **~$0** | — |
| **Total: 200–1,000 users** | — | **~$30–80/mo** |

### Revenue vs. Cost at Paid Tier

| Paying Users | Revenue (£4.99/mo) | Est. Infra | Gross Margin |
|---|---|---|---|
| 10 | £49.90 | ~£5 | ~90% |
| 50 | £249.50 | ~£20 | ~92% |
| 200 | £998 | ~£65 | ~93% |

> ⚠️ Music licensing is the wildcard. Epidemic Sound API: ~$15/mo for indie devs. Artlist: ~$200/yr. Pixabay/ccMixter: free. Start free, add licensed library as paid-only upgrade.

---

## 9. Pricing

| Tier | Price | Projects | Clips/Project | Resolution | AI Auto-Edit | Music | Watermark |
|---|---|---|---|---|---|---|---|
| **Free** | £0 | Unlimited | 20, no duration cap | 1080p | ❌ | ~20 free tracks (Pixabay/ccMixter) | ❌ Never |
| **Creator** | £4.99/mo or £39.99/yr | Unlimited | 50 | 4K | ✅ | Full licensed library (Epidemic Sound) | ❌ Never |

> **Conversion model note:** Resolution (1080p vs 4K) is the primary conversion lever — not project count or watermarks. Modelled on Clipchamp's approach: generous free tier builds habit; 4K paywall is unbypassable regardless of multi-account abuse.

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

### Phase 1 — PoC Free Tier (personal validation first)
- [ ] **Step 1:** Next.js scaffold, Supabase auth, Cloudflare R2 presigned upload working
- [ ] **Step 2:** FFmpeg Lambda — silence removal → clip splice → `xfade` transitions → `loudnorm`
- [ ] **Step 3:** Music auto-fit, generic `zoompan` zoom, intro/end card, draft preview flow
- [ ] **Step 4:** 1080p export pipeline end-to-end → **author self-tests with own DJI footage**

> ✅ Gate: Author produces one YouTube video using only RushCut. If it's usable, proceed to real users.

### Phase 2 — Validate & Charge (5 strangers before anything else)
- [ ] Fix top 3 issues from real user feedback (find via DJI forums, r/dji, r/gopro)
- [ ] Add Stripe, annual Creator tier only first
- [ ] Target: 5 paying strangers before building AI anything

### Phase 3 — AI Tier (only post Phase 2 validation)
- [ ] Google Video Intelligence shot/action scoring + clip ranking
- [ ] Google Vision face detection → smart zoom target
- [ ] `librosa` beat-sync cuts
- [ ] `ffmpeg-vidstab` stabilisation
- [ ] Context prompt (Gemini 2.0 Flash)
- [ ] 4K Lambda export (higher memory config)
- [ ] Licensed music library integration (Epidemic Sound)

**Timeline philosophy:** No rush. Each phase must genuinely work before moving on. The author's own filming sessions are the real-world test loop.

---

## 12. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Clipchamp adds auto-compile feature | Medium | High | Own the action/drone niche and "direction power" framing; Clipchamp is a Microsoft product unlikely to move fast on this |
| DJI ships LightCut for Windows | Low | Very High | This is the nuclear scenario — monitor DJI roadmap; if they ship, pivot to cross-device (DJI + GoPro + iPhone) mixing which they'll never prioritise |
| Lambda cold start slows export UX | Medium | Medium | Provisioned concurrency for paid tier; show progress indicator |
| Google Video Intelligence cost spikes | Medium | High | Cap AI processing time per project; meter at 5 min max |
| 4K file uploads time out | Medium | Medium | R2 presigned direct upload from browser (bypasses server) |
| Free tier too generous → low conversion | Medium | Medium | 4K wall is unbypassable; AI features must feel genuinely magical in v2 or upgrade motivation weakens |
| Music licensing dispute | Low | High | Start with Pixabay/ccMixter; add Epidemic Sound only after revenue |
| xfade transitions fail on mixed codecs/fps | High | Medium | Normalise all clips to consistent codec/fps on upload (FFmpeg pre-pass) — must be solved in Week 2 |

**Founder floor:** If commercial validation fails, the tool still solves the author's own DaVinci Resolve time problem. That's a valid floor — no sunk cost pressure.

---

## 13. Open Questions

1. **Music licensing:** ~~Pixabay/ccMixter (free) → Epidemic Sound ($15/mo) when?~~ **RESOLVED:** ~20 Pixabay/ccMixter tracks on free tier; Epidemic Sound gated to paid tier from day 1.
2. **Draft proxy quality:** ~~How low-res is acceptable for the "confirm before final render" step?~~ **RESOLVED:** Server-side 360p Lambda job. Real FFmpeg output — not a simulation.
3. **Export free limit:** ~~Is 3 exports/month tight enough without frustrating free users?~~ **RESOLVED:** Unlimited exports on free tier. 1080p resolution wall is the only hard limit.
4. **Mobile web:** ~~At MVP, should mobile just trigger upload + configure, with render happening async and notified via email?~~ **RESOLVED:** Tailwind responsive by default. "Best on desktop" banner shown on mobile. No special mobile flow at MVP.
5. **Stabilisation:** `ffmpeg-vidstab` is free but slow — benchmark Lambda cost before committing to paid tier feature.

---

## 14. Strategic Clarity (v0.3 additions)

**What this is:** LightCut UX + Clipchamp's web-first delivery + slightly more editing control than either. That's the whole product. Don't let scope drift from this.

**What "direction power" means in practice:** User uploads clips, picks a vibe (adventure / relaxed / cinematic), picks music, clicks compile. Gets a 90% film. Tweaks the 10%. That interaction model is the core IP — not any specific feature.

**The honest moat:** The market is full of tools that either do too little or too much. RushCut's moat is restraint — knowing what to leave out. That's a product design moat, not a technical one.

---

*Next step: Build the Lambda pipeline locally in Docker. Feed it 5 real DJI clips. Get one exported MP4 out. If that works, everything else is solvable.*
