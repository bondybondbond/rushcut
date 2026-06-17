# PRD: RushCut — Rushes to a Cut

> **Product:** RushCut — *Your clips. Edited.*
> **Status:** Phase 2 active — local Tauri desktop app (Windows). Cloud infra retired.
> For batch specs and build roadmap, see `docs/PRD-DEV.md`.

---

## 0. Why This Exists

Personal pain point project first, commercial product second. The author spends hours in DaVinci Resolve producing 3-minute YouTube clips for family — that trade-off (hours of editing vs. minutes of fun filming) is the exact problem RushCut solves.

**If it fails commercially:** Still solves the author's own problem better than any existing tool at any price. That's a valid floor.

---

## 1. Problem Statement

Hobbyist videographers (DJI drone, GoPro, iPhone) who want to produce shareable films face a broken market:

- **DJI LightCut / GoPro Quik:** Best-in-class UX — but mobile/tablet only. No Windows support. Deliberately shallow editing capabilities.
- **Clipchamp:** Free, web-first, 1080p — genuinely good. But it's a traditional timeline editor. Beginners still face "stare at 40 clips and figure out the structure." No auto-compile, no direction power.
- **DaVinci Resolve / Premiere:** Pro-grade, hours per video.
- **CapCut, Filmora, Kapwing:** AI-obsessed UX, watermarks on free tiers, expensive for casual use, bloated.

**The gap:**

> DJI LightCut's auto-film UX is the gold standard — but it's mobile-only and editorially shallow. DaVinci gives full control but costs hours. Nothing in between gives you *direction power* without forcing you into micro-managing every 2-second clip.

**The bet:** A focused desktop tool that does one job exceptionally — compile your clips into a watchable film with good transitions, music, and structure — and lets you shape the result, not rebuild it from scratch.

---

## 2. Target User

| Attribute              | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **Primary**            | Hobbyist action/drone/travel videographers                                                    |
| **Device**             | Shoots on DJI drone, GoPro, iPhone — transfers to Windows PC                                  |
| **Destination**        | YouTube (family/friends), Instagram, personal archive                                         |
| **Core pain**          | Gap between "I want a shareable film" and "I just spent 3 hours in DaVinci on a 3-min clip"   |
| **Current workaround** | Mobile-only tools (LightCut) or suffering through timeline editors (DaVinci)                  |
| **What they want**     | *Direction power* — set the vibe, get a solid first draft, tweak only what matters            |
| **What they don't**    | Timeline micro-management, AI gimmicks, watermarks, subscriptions for features they never use |
| **Willingness to pay** | £4–8/mo to reclaim 2+ hours per video — or more honestly, to *want to edit at all*            |

**Real footage baseline (founder's DJI session):** 62 clips, 19.6 GB total, largest clip = 1.4 GB (4K 30fps, 3 min).

---

## 3. Product Vision

> *"From your raw footage to a shareable film in under 5 minutes — no editing skills required."*

Desktop-first (Windows, local pipeline). No watermarks on any tier. No AI generation gimmicks.

**Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."

**Design principle:** Every screen should feel like you're making creative choices, not managing software.

### Director, not Editor

The user makes *creative decisions*, never *technical ones*. They say "make it cinematic, start with the mountain shots" — RushCut handles clip selection, trim points, transition timing, zoom animation, and text. The user never touches a timeline. They review a film, not a sequence of clips.

The magic of feeling like a director must never be lost. The AI engine *is* the product — this is the Magisto lesson. When Vimeo stripped their AI engine post-acquisition, the "director feeling" disappeared and users left immediately.

### The Moment Extraction Mental Model

RushCut doesn't aggregate clips and splice them — any timeline editor can do that. The value is **moment extraction**: finding the best 3–15 seconds within each clip, discarding the dead parts (landing shots, camera shake, silence, static frames), keeping only the peak.

From 62 raw clips → ~50 contribute something → each contributes 3–15s of their best moment → output: a 3–6 min film of micro-cuts, music-synced, with transitions. The user never decided which frames to keep.

**This is harder than clip selection (keep/discard whole clips).** It requires finding where the interesting moment is *within* each clip — the frame where the drone crests the mountain, not the 8 seconds of ascent before it.

**The product mantra:** *Not "edit your clips" — "capture your moments."*

---

## 4. What Needs AI vs. What's FFmpeg

| Feature                                           | Needs AI?          | How                                                      |
| ------------------------------------------------- | ------------------ | -------------------------------------------------------- |
| Silence/stillness removal                         | No                 | FFmpeg `silencedetect` + frame-diff                      |
| Auto-add transitions (crossfade, dip to black)    | No                 | FFmpeg `xfade`                                           |
| Auto-fit music to video duration                  | No                 | FFmpeg trim/fade                                         |
| Beat-sync music cutting                           | No                 | `librosa` — free, open-source                            |
| Zoom effect (generic, centre-frame)               | No                 | FFmpeg `zoompan`                                         |
| Zoom on faces / people                            | Yes                | Face detection (Google Vision or OpenCV)                 |
| Zoom on key action moments                        | Yes                | Motion + scene scoring (Google Video Intelligence)       |
| Moment extraction (best N seconds within clip)    | Partial            | FFmpeg frame-diff removes dead sections; GVI finds peaks |
| Context-aware ordering ("start at flight, hotel") | Minimal (Gemini)   | Gemini Flash ~$0.001/export                              |
| Stabilisation                                     | No (compute-heavy) | `ffmpeg-vidstab` — paid tier only                        |
| Volume normalisation                              | No                 | FFmpeg `loudnorm`                                        |

**Rule:** FFmpeg + librosa handles the free tier. GVI/Vision/Gemini are paid-tier upgrades, hard-capped per export.

---

## 5. Feature Scope

### Tier summary

| Tier        | Price    | Resolution | AI Auto-Edit                                    | Music            | Watermark |
| ----------- | -------- | ---------- | ----------------------------------------------- | ---------------- | --------- |
| **Free**    | £0       | 1080p      | Basic (silence/motion removal, beat-sync, vibe) | ~20 free tracks  | Never     |
| **Creator** | £4.99/mo | 4K         | Smart (GVI frame-level extraction, face zoom)   | Licensed library | Never     |

### Near-term feature backlog (pre-monetisation)

These are the gaps between current state and a **solid, complete tool** for the serious recreational user. Not pro features — the minimum to be genuinely better than CapCut for this niche.

| Feature | Value | Complexity | Priority |
| --- | --- | --- | --- |
| **Beat-sync cutting** (`librosa`) | Cuts land on music hits — the single biggest "wow" moment for users; transforms slideshow → trailer feel | Medium | High |
| **Text / lower thirds** | Basic title overlays. Without this, can't compete with CapCut for social output | Medium | High |
| **Export presets** | Instagram Reels, TikTok, YouTube Shorts — one-click correct aspect ratio + spec | Low | High |
| **Multi-track / B-roll** | Drop a second angle over the main clip. Unlocks real "directorial" editing | High | Medium |
| **GPU encode — NVENC/AMF/QSV** | 5–10x faster render for GPU-equipped users. AMD (h264_amf) first; NVENC + QSV when user hardware diversity is known | Medium | Medium |
| **Scrub/preview without full render** | Biggest UX gap vs. pro tools today | High | Medium |
| **Undo history** | Beyond arrangement changes | Low | Low |

### Permanently Out of Scope

- AI video generation (text-to-video)
- Multi-track timeline editor (full)
- Colour grading
- Captions / subtitles
- Team / collaboration

---

## 6. Competitive Positioning

**Clipchamp is the primary competitor** — pre-installed on every Windows PC, free at 1080p, no watermarks. Beat it on direction power and moment extraction, not features.

| Tool            | Windows | Auto-compile | AI Direction | Zero Timeline | Moment Extraction | Watermark | Price       |
| --------------- | ------- | ------------ | ------------ | ------------- | ----------------- | --------- | ----------- |
| **RushCut**     | ✅       | ✅            | ✅ (v3 vision) | ✅             | ✅ (paid: GVI)     | Never     | £4.99/mo    |
| DJI LightCut    | ❌       | ✅            | ❌ template   | ✅             | Basic             | No        | Free        |
| GoPro Quik      | ❌       | ✅            | ❌ template   | ✅             | Basic             | No        | Free        |
| Clipchamp       | ✅       | ❌            | ❌            | ❌             | ❌                 | No        | Free / M365 |
| CapCut          | Partial | ✅            | ❌ template   | ✅             | Basic             | Free tier | £64.99/yr   |
| DaVinci Resolve | ✅       | ❌            | ❌ passive¹   | ❌             | ❌                 | No        | Free / £270 |
| Runway ML       | ✅       | ❌            | Generative²  | ✅             | ❌                 | Yes       | $15+/mo     |

¹ DaVinci Resolve 19 added "IntelliTrack" (object/face tracking) and AI scene cut detection — but these are passive assists to manual editing, not creative direction. The user still builds the timeline.

² Runway generates synthetic footage from text prompts. Not direction over real clips — a fundamentally different product category.

### The whitespace nobody owns

**Visual intelligence over your own real footage + zero-timeline UX + desktop 4K output.**

- CapCut gets close on UX but is template-driven — it applies a style, it doesn't understand your footage.
- Resolve gets close on output quality but requires full manual timeline editing.
- LightCut/Quik get close on zero-timeline but are mobile-only and editorially shallow.
- Nobody has assembled all three for desktop. That's the gap.

---

## 7. Strategic Clarity

**What this is:** LightCut UX + desktop-first delivery + frame-level moment extraction that neither LightCut nor Clipchamp offers.

**What "direction power" means in practice:** User uploads 62 clips from their vacation. Picks a vibe. Clicks compile. Gets a 3-minute film of the best moments — not a 3-hour editing session. Tweaks the 10% that feels off.

**The honest moat:** The market is full of tools that do too little or too much. RushCut's moat is restraint — knowing what to leave out. That's a product design moat, not a technical one.

**AI policy:** AI only where the improvement is user-visible, demonstrable, and sellable. Never invisible internals. "Anti-fake-AI, not anti-AI."

**Key decisions:**

- DEC-018: Phase 2 gate = founder's own successful 60+ clip session (not paying users)
- DEC-022: Local build — 84-min upload time at 30 Mbps made cloud-upload model unworkable
- DEC-023: Motion scoring removed — FFmpeg-per-clip adds >10 min on 10 min footage; unacceptable
- DEC-024: Guided clip-review editor — user sets IN/OUT + focal point; pipeline does deterministic assembly
- DEC-025: AI policy — selective, user-visible only
- DEC-026: Two review modes — Quick (default) and Precise (opt-in per clip)
- DEC-027: Post-review Editor is intentionally minimal

Full decision log: `docs/DECISIONS.md`

---

## 8. Long-Term Vision — AI Director (v3+)

> *"You filmed it. RushCut directed it."*

The north star product: the user imports raw footage and receives a finished film that required zero creative decisions from them. Not AI generation — AI direction over real footage.

### What this requires

**Visual intelligence layer** — the pipeline must understand *what is happening* in each frame, not just silence/motion heuristics:

- **Face + subject detection** — identify people, centre attention on them for zoom/crop decisions
- **Action recognition** — detect the peak moment within a clip (drone cresting a mountain, a goal being scored, a jump landing) — not just "motion is high here"
- **Scene classification** — sky, water, crowd, landscape, indoor — drives vibe-appropriate transitions and music matching
- **Saliency mapping** — where should the viewer's eye go? Drives focal point selection automatically

**Orchestration layer** — once visual intelligence exists, the AI Director combines:

1. Beat-sync music cutting (librosa — already planned)
2. Automatic focal point selection (face/action detection → zoom target)
3. Fitting text/title overlays at natural pause points
4. Transition selection based on energy level (cut on beat, dissolve on slow moments)
5. Sound effect triggers on action peaks
6. Clip ordering by narrative arc (establish → build → peak → resolution)

### Why this is the monetisation moment

The current product saves time. The AI Director creates output the user *could not have produced themselves* — even with hours in DaVinci. That's a fundamentally different value proposition and justifies a higher price point (£9.99–14.99/mo Creator+ tier).

This is also the competitive moat that's hardest to copy: the visual intelligence model trained on action/drone/travel footage specifically, combined with RushCut's opinionated output style.

### Key UX constraint

AI direction works brilliantly ~80% of the time — and embarrassingly 20% of the time. The AI Director must ship with a strong **"override anything" UX layer** so users can fix the 20% without rebuilding from scratch. Without this safety net, first-time failures cause churn.

### Technical prerequisites

| Capability | Approach | When |
| --- | --- | --- |
| Face/subject detection | OpenCV (local, free tier) or Google Vision API (paid tier) | v2 |
| Action peak detection | Google Video Intelligence API | v2 paid |
| Beat-sync cutting | `librosa` (already in plan) | Near-term |
| Scene classification | GVI scene labels | v2 paid |
| Narrative ordering | Gemini Flash with clip thumbnails + metadata (~$0.005/export) | v3 |
| Orchestration logic | Deterministic rules engine first; LLM-assisted second | v3 |

**Deferred reason:** Visual intelligence APIs add per-export cost and latency. Build the deterministic pipeline to excellence first — beat-sync, text, export presets — then layer AI direction on top as a paid upgrade. Don't add AI cost before there's revenue to cover it.
