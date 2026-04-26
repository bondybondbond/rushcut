# RushCut — Phase 2 Build Plan

> **Phase goal:** The founder can upload a full 60+ clip DJI session, have RushCut intelligently filter and compile it into a 3–6 min film with music, card text, zoom, and smart moment selection — a film they're proud enough to publish.
> 
> **Phase 2 exit gate:** "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish." Not: paying users. Not: user testing scores. (See DEC-018, DEC-020.)

---

> **What belongs in this file:**
> 
> - Phase goal and exit gate
> - Specs for batches not yet started or actively in progress
> - Backlog items with enough detail to act on when prioritised
> - Phase 3 preview (high-level only)
> - Compact changelog table
> 
> **What does NOT belong here:**
> 
> - Specs for delivered batches — once a batch ships, trim to a one-line "done" note in the changelog and delete the detail
> - Lambda / Next.js / Supabase / R2 references — that infrastructure is gone
> - "Superseded" or "deferred" batch specs — move to `docs/archive/` or delete
> - Research notes, user testing plans — those go in `docs/COMPETITORS.md` or a dedicated notes file
> - Implementation details already captured in `LEARNINGS.md` or `.claude/rules/`

---

## Batch 14 — Clip Review + UX Overhaul

> **Scope:** Guided clip-review editor — user decides, pipeline executes.
> **Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."
> **Status:** 14a, 14b, 14c complete. Next: 14d (quick wins + upload delight).

### 14a — Sequential clip review screen (**DONE 2026-04-02**)

`/review/:projectId` route, Quick + Precise modes, keyboard shortcuts, focal point picker, IN/OUT trim sliders, zoom chips, sessionStorage resume, Skip Review escape hatch. Full detail in CONTEXT.md.

### 14b — Proxy generation (**DONE 2026-04-02**)

H.264 720p proxies generated post-render via `proxy.py` + `generate_proxies_cmd`. Full detail in CONTEXT.md.

### 14c — Per-clip data model (**DONE 2026-04-01**)

7 columns added to `clips` table. Full detail in CONTEXT.md.

---

### 14d — Quick Wins + Upload Delight (**DONE 2026-04-03**)

Review.tsx: back button `ml-10` clears hamburger, proxy pending badge removed, centre focal point button removed, Skip Review tooltip added. Upload.tsx: full-screen spinner replaced with progressive skeleton grid — folder scan grows cards 1/200ms; file picker shows exactly N cards with staggered fly-in. `@keyframes rc-fly-in` added to globals.css. Cards use `aspect-video` (compact). 25/25 E2E PASS.

### 14e — "Build Your Film" redesign + hotfix (**DONE 2026-04-05**)

14e-core: `reorder_clips_cmd` Tauri command + DB helper; `ClipNavStrip.tsx` (DnD thumbnail strip, auto-scroll, duration counter); Review.tsx full redesign — title "Build Your Film", ClipNavStrip wired, focal pulse/zoom animation, `saveCurrentClip()` + `isSaving` guard, Skip demoted to text-link, autoPlay/progress bar/last-clip CTA distinction removed. 25/25 E2E PASS.

14e-hotfix: `REVIEW_THRESHOLD` removed — Upload always routes to `/review`. Product direction pivot: task-based screen architecture confirmed (Upload→Trimmer→Transitions→Sound→Render); explicit-add assembly model confirmed for Batch 15a. `docs/trimmer-designs.html` created (Design A selected).

### Batch 14 Gate

- [x] Quick mode is default; Include/Skip keyboard-accessible; Precise expands per clip (14a)
- [x] Proxy generation runs after render completes; proxies used in review screen scrubbing (14b)
- [x] Per-clip in_ms, out_ms, focal_x/y, zoom_mode passed through manifest to pipeline (14c)
- [x] Pipeline applies user IN/OUT over silence trim when set (14c)
- [x] Skipped clips excluded from render (14c)
- [x] Upload shows progressive animated cards (14d)
- [x] "Build Your Film" screen with clip nav strip, focal feedback, Skip demoted (14e)
- [x] All projects route to Review/Trimmer regardless of clip count (14e-hotfix)

---

## Batch 15 — Task-Based Screen Architecture

> **Architecture decision (2026-04-05):** Replace the single Review + Editor flow with discrete task-based screens. Each screen = one decision type. Screens: Upload → Trimmer → Transitions → Sound → Render.
> **Assembly model:** Explicit add — user adds clips to film (include starts 0). All-IN default changes when Batch 15a ships.

### 15a — Trimmer screen (**DONE 2026-04-05**)

`/trimmer/:projectId` route, Media Pantry (2-col grid, HTML5 DnD), video player (click-to-play), TrimBar (floating handle labels, dark surface, white playhead, `currentMs` seek), FilmStrip (drag-to-add), StepNav. include=0 fix at INSERT. Staging screen removed. 26/26 E2E PASS.

### 15b — Persistent step nav (**DONE 2026-04-05**)

`StepNav.tsx` component — Upload · Trim · Transitions · Sound · Render. Active step peach, completed steps clickable, pending steps dimmed. Shipped as part of 15a.

### 15c — Trimmer Bug Fixes + UX Polish (**PARTIAL — C2/C3/C6 done in Batch 16b**)

Six items from founder review session (2026-04-23):

**Bugs:**

- **C1 — Broken thumbnails:** Clip thumbnails show as broken images in both Media Pantry and FilmStrip. `proxy.py` generates H.264 proxies but no poster frames. Fix: extract one frame per clip via FFmpeg (`-ss 2 -vframes 1 thumbnail.jpg`) in `proxy.py` during proxy gen; emit `THUMBNAIL_DONE:clip_id:base64`; store in new `thumbnail_data TEXT` column on `clips` (pos 18, ahead of waveform at 19). Pantry tiles and FilmStrip use `<img src={clip.thumbnail_data}>`.
- **C2 — Text hidden under FilmStrip:** Text between TrimBar and the bottom FilmStrip drawer is occluded by the drawer's z-index. Fix: audit layout stacking; add padding or restructure so TrimBar hint text is always visible.
- **C3 — "In Film" blocks multiple cuts:** After adding a clip, the Add button reads "In Film" and the user cannot add further trim cuts from the same source. Fix: remove "In Film" button state entirely (the green tick in the pantry is sufficient). Always show "Add to Film". Per-clip multiple-cut model: each "add" creates a new row in the film strip with the current `in_ms`/`out_ms` snapshot — same source path, distinct cut. DB supports multiple rows per source clip already (no unique constraint on `file_path`).

**UX improvements:**

- **C4 — TrimBar: click = seek, drag handles = trim only:** Currently any click on the TrimBar moves the nearest handle. New behaviour: clicking anywhere on the track seeks the video to that position (`video.currentTime = clickPct * durationMs / 1000`). Trim handles only move when the user explicitly drags them. The playhead should be the visual target for clicks — make it clear the track is a seek surface.
- **C5 — Thicker playhead:** White playhead line is `w-0.5` (2px). Increase to `w-1` (4px) for visibility, keep `bg-white/80`.
- **C6 — Resizable video preview:** Add a drag handle on the bottom edge of the video container. Dragging it up/down adjusts a `videoHeight` state (CSS `height` on the video wrapper, min 200px, max 70vh). No library needed — `onMouseDown` on the handle div, `mousemove`/`mouseup` on `window`. This matches the DaVinci "drag timeline rail to resize preview" pattern.

**Deferred from 15a Group C — Waveform:**

- **C7 — Waveform in TrimBar:** `proxy.py` emits `showwavespic` PNG as base64 (`WAVEFORM_DONE:clip_id:base64`). New `waveform_data TEXT` column (pos 19, after thumbnail). TrimBar renders `<img z-2 opacity-40>` below selected region. FilmStrip gets a timecode ruler above the strip.

**Gate:**
- [x] Thumbnails visible in Media Pantry tiles and FilmStrip (not broken) — done 15c Pkg 1
- [x] TrimBar hint text / any text between TrimBar and FilmStrip is not occluded — done 16b (overflow-y-auto)
- [x] "In Film" state removed; Add button always active — done 16b (C3)
- [x] Click on TrimBar track seeks video; handles only move on drag (C4) — done 15c remaining
- [x] Playhead is visibly thicker (4px) + triangle pip above track (C5) — done 15c remaining
- [x] Video preview height is user-resizable via drag handle — done 16b (C6)
- [x] (C7 stretch) Waveform renders as dim overlay in TrimBar — done 15c Pkg 1

### 15e — Transitions screen (`/transitions/:projectId`)

Current Editor transition picker extracted into a standalone screen. Options: None / Crossfade / Dip to black. Selection persisted in `sessionStorage` (`rc_transition_${projectId}`) for the Render screen to consume.

**Future — Rename to `/edit/:projectId` when 15f (text cards) ships:**
The Transitions-only screen is intentionally thin now. When text cards are built, rename the route and StepNav label to "Edit" and add tabs: Transitions / Text Cards / Animations. Stack sections vertically with disabled/coming-soon states until each tab is built — avoids permanently empty tabs. StepNav becomes: Upload → Trim → **Edit** → Sound → Render. Do NOT call it "Effects" (implies VFX). Research: iMovie, CapCut, GoPro Quik all collapse transitions + text + effects into one Edit/Style step.

**Future — Transition Preview (post-15e backlog):**
All major commercial editors (Premiere, DaVinci, CapCut, iMovie) show a looping visual preview when a transition is selected — table-stakes UX for an editor product.
- Short looping CSS animation pair (clip A -> clip B) rendered inline per chip, no pipeline needed
- Each chip shows a ~2s looping demo on hover/select
- Prerequisite: 15e route + chips + sessionStorage must be complete first

### 15f — Sound screen (`/sound/:projectId`)

Current Editor music settings extracted: music mood selector, volume preset chips (Subtle/Balanced/Prominent). Music preview (30s loop from selected track).

### 15g — Render screen (`/render/:projectId`)

Merges the current Editor "Start Rendering" flow and Output page into one screen. Shows summary of decisions (clip count, duration, music, transition). One "Render Film" CTA. Progress bar + output playback on completion.

---

## Backlog — Music Loop: Waveform-Matching Loop Point

> **Deprioritised — Batch 15+ or dedicated audio polish batch.**

**Problem:** Pairwise `acrossfade` crossfades wherever the track boundary falls. If the track has a fade-out at the tail and a fade-in at the head, both sides of the crossfade are near-silent — the gap persists.

**Shipped fix (Batch 14-P):** Strip intro/outro silence before tiling (`silencedetect` → `atrim` to active region). Reduces but doesn't eliminate the gap.

**Better fix (this item):** Find a waveform-match loop point — two beat-aligned moments where harmonic/spectral content is nearly identical, crossfade between them. Options: librosa `beat_track` + `chroma_features` similarity; `essentia`; or a purpose-built AI audio model.

Qualifies under AI policy (user-visible, demonstrable) if AI is used. Prioritise only after real-footage testing confirms the gap is still audible post silence-trim fix.

---

## Batch 15 — AI Director Screen (deprioritised)

> **Goal:** Surface the AI's edit proposal explicitly, between Upload and Clip Editor.
> **Prerequisite:** Batch 14 (Clip Review) complete.
> **Estimate:** 2–3 days.

New route: `/director/:projectId` — inserted into flow after scan, before `/editor/:projectId`.

**Left:** AI Proposal summary — style tags, "N of M clips used · X excluded", actions: **Accept & Edit** / **Regenerate** / **Skip → Manual**

**Right:** Proposed clip order list — filename, trim duration, transition label per cut. Excluded clips shown dimmed with reason. Tap excluded clip → option to add back.

### Gate

- [ ] Director screen appears after scan for new projects
- [ ] Accept loads Editor with AI-proposed order pre-populated
- [ ] Regenerate re-runs analysis and refreshes proposal
- [ ] Skip loads Editor with original scan order
- [ ] Excluded clips shown with reason; can be added back

---

## Batch 16 — Auth + 4K + Tier

> **Goal:** Product is shareable with paying users. Pro tier enforced.
> **Estimate:** 3–5 days.
> **Prerequisite:** DEC-020 conditions met (AI layer shipped = Batch 15).

- Supabase Auth (email + Google OAuth)
- 4K pipeline path (`-vf scale=-2:2160`, libx264, profile high)
- Pro tier gating: AI Director screen, 4K output, advanced transitions, timeline volume slider
- Upgrade chips + locked overlays for free-tier users
- Stripe (£4.99/mo Creator)
- Library: resolution badge (1080p / 4K) per project

---

## Phase 3 Preview (not in scope now)

- Google Video Intelligence frame-level scoring — replaces FFmpeg motion heuristic
- Face/subject-aware zoom — GVI + Vision API
- Stabilisation via ffmpeg-vidstab
- 50 clips / 20GB cap for Creator
- Licensed music library (Loudly or Soundraw API)

---

## Changelog

| Version | Date       | Changes                                                                                                                                                                                                                                                                             |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.6     | 2026-04-26 | Batch 15e — Transitions screen (`/transitions/:projectId`): StepNav `active="transitions"`, 3 chips (None/Crossfade/Dip to black), `sessionStorage` persistence (`rc_transition_${projectId}`), inline description per selection. Trimmer CTA updated to navigate to `/transitions/` (was `/editor/`). Back button removed (StepNav handles it). `transitions.spec.ts` 12/12 PASS. `test:e2e:transitions` script added. Future "Edit" screen rename + Transition Preview added to PRD-DEV.md backlog. `DESIGN.md` chip `text-sm` rule added. |
| 1.5     | 2026-04-26 | E2E spec debt cleared: `trimmer.spec.ts` all 3× `getHTML(false)` → `body.textContent`, "In Film" → "Total" assertion, pushState TODO comment. `gap-editor.spec.ts` full rewrite → "Trimmer via real navigation" (5 assertions, real UI nav, no pushState). Editor Back button → `/trimmer/:projectId`. StepNav breadcrumb colours fixed (flat hex, no opacity). `wdio.conf.ts` `/trimmer/` in `waitForAppRoute`. `e2e.md` no-pushState rule. `DESIGN.md` StepNav pattern. 12/12 + 5/5 + 7/7 E2E PASS. |
| 1.4     | 2026-04-26 | Batch 15c remaining (C4+C5) — TrimBar click-to-seek (seek-only, handles don't move); 4px playhead + downward triangle pip above track; hint text updated. E2E: 7/7 fast PASS; 10/12 trimmer (2 pre-existing getHTML timeouts). |
| 1.3     | 2026-04-26 | Batch 16+16b — Native FFmpeg scan/proxy (Rust, no WSL); source-first playback (local_path direct, proxy only on onError); OnceLock GPU encoder detection (nvenc→qsv→amf→libx264); lazy per-clip `generate_proxy_for_clip` cmd; `run_media_batch` (thumbnail+waveform only upfront); 4s poll replaced with `proxy-progress` event listener; C2 overflow fix, C3 "In Film" removed, C6 video resize handle; `generatingProxyRef` double-fire guard. E2E: 7/7 PASS. |
| 1.2     | 2026-04-02 | Batch 14a — Review Screen UI: `/review/:projectId`, Quick + Precise modes, keyboard shortcuts, focal point overlay, IN/OUT sliders, zoom chips, sessionStorage resume, Skip Review escape hatch, `REVIEW_THRESHOLD` constant, asset scope expanded for source clips. E2E: 25/25. |
| 1.1     | 2026-04-02 | Batch 14b — proxy generation: `proxy.py`, `generate_proxies_cmd`, post-render firing (avoids FFmpeg contention), `-c:a copy`, `include`-filter. Hygiene: `/tmp/<job_id>` cleanup in `run.py`, rich `ANALYSIS:` line in `render.py`, wrapup temp cleanup. Next: 14a (Review screen). |
| 1.0     | 2026-04-01 | Batch 14c — per-clip data model: 7 DB columns, Rust/TS types, `update_clip_review` cmd, manifest filtering, `out_ms` clamp, pipeline trim override, focal-aware `zoom.py`. Next: 14b (proxies).                                                                                     |
| 0.9     | 2026-03-31 | Batch 13d deferred (all changes reverted). `aresample=async` worsened DJI sync; `ProcessPoolExecutor` slower (I/O bound); `volumedetect` overcorrects on wind noise. Lessons in LEARNINGS.md.                                                                                       |
| 0.8     | 2026-03-30 | Batch 14-P — A/V sync fixed (pairwise acrossfade + apad); music loop improved (N-copy acrossfade + silencedetect silence-trim); per-clip normalise progress; library routing; persistent pipeline log.                                                                              |
| 0.7     | 2026-03-30 | Batch 13c — music looping (`-stream_loop -1` + `asetpts` ordering), `[sync-check]` logging, hwaccel probed (non-viable).                                                                                                                                                            |
| 0.6     | 2026-03-29 | Batch 13b — motion scoring removed, toggle bug fixed, filename versioning (`slug-01.mp4`), volume chip `#99B3FF`, timing logs. Post-batch hotfixes: fixed-canvas pre-scale (portrait+landscape crash), normalise ultrafast, Output rolling timeout. E2E 25/25.                      |
| 0.5     | 2026-03-29 | Batch 13 — motion.py, beats.py, render.py rewrite, analysis_summary DB column. Subsequently pivoted: motion scoring too slow (>10 min). See `docs/archive/PRD-DEV-batches-11-13.md`.                                                                                                |
| 0.4     | 2026-03-28 | Batch 12b — `music_volume` → `"subtle"\|"balanced"\|"prominent"` union; 3-chip UI; `run.py` float map.                                                                                                                                                                              |
| 0.3     | 2026-03-27 | Batch 12 — `-ar 48000` at all 6 re-encode sites, music volume slider, delete project, stale job cleanup, Output timeout.                                                                                                                                                            |
| 0.2     | 2026-03-26 | Batches 11–11c — UI polish (19 items), E2E infrastructure (WebdriverIO + BiDi fix + rushcut-eval skill), home redesign, transition picker, AppShell, elapsed timer. See `docs/archive/PRD-DEV-batches-11-13.md`.                                                                    |
| 0.1     | 2026-03-22 | Phase 2 build plan created. Batches 8–9 (Tauri scaffold + full UX flow) delivered.                                                                                                                                                                                                  |
