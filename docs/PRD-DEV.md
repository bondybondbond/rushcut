# RushCut — Phase 2 Build Plan (strategic)

> **Phase goal:** The founder can upload a full 60+ clip DJI session, have RushCut intelligently filter and compile it into a 3–6 min film with music, card text, zoom, and smart moment selection — a film they're proud enough to publish.
>
> **Phase 2 exit gate:** "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish." Not: paying users. Not: user testing scores. (See `archive/DECISIONS.md` DEC-018, DEC-020.)

---

> **This file is strategic-only.** It holds forward-looking direction, not history or backlog.
>
> **What belongs here:**
> - Phase goal and exit gate
> - Swimlane legend — purpose and scope of each batch series
> - Forward roadmap specs (AI Director, Auth/4K/Tier) — not yet started
> - AI Enablement — goals/principles for the AI feature tier
> - Phase 3 Preview — cloud/backend/monetization direction (high-level)
> - Vision Notes — future directions (inspiration, not scheduled)
>
> **What does NOT belong here (and where it lives instead):**
> - Execution backlog / individual items → **[GitHub Projects #1](https://github.com/users/bondybondbond/projects/1)** (`gh project item-list 1 --owner bondybondbond`)
> - Changelog / "what shipped when" → **git log** (authoritative) + `docs/archive/completed-plans/PRD-DEV-batches-14-N-full.md` (pre-2026-06-17 detail)
> - Specs for delivered batches → archived in `docs/archive/completed-plans/`
> - Current state / next task → **MEMORY.md** (single source; do not duplicate here)
> - Implementation details → `LEARNINGS.md` or `.claude/rules/`
> - Lambda / Next.js / Supabase / R2 references — that infrastructure is gone

---

## Batch Series Swimlane Legend

Each batch series has a distinct purpose. When choosing where a new item belongs, match it to its series by theme — not by batch number.

| Series | Purpose | Status |
|--------|---------|--------|
| **U5** | Trim-screen playback UX — seek responsiveness, clip-to-clip transitions, dual-buffer improvements | U5a/b/c DONE |
| **U6** | Music playback improvements — seek dropout fix, loop toggle | DONE (incl. U6a/U6b) |
| **V1.x** | Critical stability bugs — crashes, wrong output content, data integrity, render failures | V1.1–V1.4 DONE · V1.5 next |
| **V2.x** | UX polish — visual accuracy, discoverability, small quality-of-life improvements | V2.1–V2.3 queued |
| **V3** | Advanced editor features — multi-version renders, add/remove clips, film-tab trim handles, branding | Deferred |
| **V4.x** | Pipeline architecture — clean render intermediate (DaVinci-style cache), parallel decode+encode | Deferred |
| **AI** | AI-powered automation — DJI highlight import, smart defaults, one-tap render, director screen, beat sync | Deferred (pre-GTM) |
| **Photos** | Photo montage feature — Ken Burns sequence, frame styles, fan stack animation | Deferred |
| **Phase3** | Cloud and platform — auth, Stripe, music API, Google Video Intelligence | Out of scope now |

**Swimlane rules:**
- Each batch in a series targets 1–3 items at most
- Bugs and features in the same swimlane share a common theme — do not cross-pollinate
- Deferred items stay in GitHub Issues (Status=Deferred) until a session picks them up
- When a new series is needed, add it here and create the Target Batch options in GitHub Projects (see `.claude/skills/rushcut-wrapup/SKILL.md` Step 2.5 for field IDs)

---

## Forward roadmap specs (not yet started)

### AI Director Screen (deferred)

> **Goal:** Surface the AI's edit proposal explicitly, between Upload and the editor.
> **Prerequisite:** AI Enablement groundwork (below).

New route `/director/:projectId`, inserted after scan, before the editor.

- **Left:** AI Proposal summary — style tags, "N of M clips used · X excluded", actions: **Accept & Edit** / **Regenerate** / **Skip → Manual**
- **Right:** Proposed clip order list — filename, trim duration, transition label per cut. Excluded clips shown dimmed with reason; tap to add back.

**Gate:** Director screen appears after scan · Accept loads editor with AI order pre-populated · Regenerate re-runs analysis · Skip loads original scan order · excluded clips show reason + can be re-added.

### Auth + 4K + Tier (Phase3 entry)

> **Goal:** Product is shareable with paying users; Pro tier enforced.
> **Prerequisite:** DEC-020 conditions met (AI layer shipped).

- Supabase Auth (email + Google OAuth)
- 4K pipeline path (already shipped for free during Phase 2 — gate it here)
- Pro tier gating: AI Director screen, 4K output, advanced transitions, timeline volume slider
- Upgrade chips + locked overlays for free-tier users
- Stripe (£4.99/mo Creator)
- Library: resolution badge (1080p / 4K) per project

---

## AI Enablement (large, pre-GTM)

> **Biggest remaining piece of work. Target: before go-to-market.**

**Goal:** A user who doesn't bother with settings gets a good result immediately. Most decisions pre-configured, including auto-trimmed sections pulled from DJI metadata (Osmo Pocket 3 marks highlights in the DJI app).

- **DJI in-app highlights:** Parse `_DJI_...` XMP/EXIF metadata written by the DJI app to identify user-flagged moments → auto-populate `in_ms`/`out_ms`. User sees pre-trimmed clips in the Trimmer, can adjust or accept.
- **Smart defaults per clip count:** Short session (1–10 clips) → include all, moderate zoom, crossfade. Long session (60+ clips) → AI-score and pre-select best N clips, apply gentle zoom, trim silence.
- **One-tap render:** After scan, show a "Render now" CTA alongside "Customise" — renders with smart defaults without any editing.
- Qualifies under AI policy (user-visible, demonstrable, clearly labelled as AI — see `archive/DECISIONS.md` DEC-025).

---

## Phase 3 Preview (not in scope now)

- Google Video Intelligence frame-level scoring — replaces FFmpeg motion heuristic
- Face/subject-aware zoom — GVI + Vision API
- Stabilisation via ffmpeg-vidstab
- 50 clips / 20GB cap for Creator
- Auth + Stripe (Creator £4.99/mo) + Pro tier (4K, AI Director, advanced transitions)

---

## Vision Notes — Future Directions (inspiration, not scheduled)

> Not a roadmap. Ideas worth keeping in mind when looking for what to build next.

**Codebase score (as of 2026-05-21): 6/10** — well-built for its scope (proxy system, pipeline architecture, E2E suite, two-instance safety, atomic writes, timing logs are senior-engineer decisions) but the feature surface is narrow.

**What would move the needle to 8+** (for the target niche: serious recreational, handheld footage, social output — genuinely better than CapCut for this use case, not DaVinci):

*Product gaps (user-facing):*
- **Multi-track / B-roll** — single clip-per-slot model is the biggest structural gap. Real directorial editing means cutting away to a second angle or overlay.
- **Cut-to-music** — beat detection + auto-sync is the #1 feature serious social editors want. Nothing else signals "this is for creators" more clearly.
- **Text / titles** — even basic lower thirds. Without this, can't compete with CapCut for socials.
- **Export presets** — Reels / TikTok / Shorts ratios and specs as one-click targets.

*Technical gaps (pipeline):*
- GPU encode — DONE (`h264_amf`, auto for 4K). Native fps detection DONE.
- No scrubbing / preview without full render — biggest UX gap vs pro tools.
- No undo history beyond arrangement changes.

Fill the four product gaps → 8/10 for this niche.
