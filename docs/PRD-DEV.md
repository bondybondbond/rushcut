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

---

### 14e — "Build Your Film" — Screen 2 Redesign

> **Scope:** Complete redesign of the Review screen. This is the main editorial screen — clip composition, trim, order, and duration. Nothing advances to render without it.
> **Philosophy:** Every clip is IN by default. Skip is the exception. The user trims to the good bit, not decides whether to include.

**Screen rename:** `/review/:projectId` → title becomes "Build Your Film"

**A. Mental model shift:**
- All clips are IN by default (already true in DB: `include=1`). Don't present Include as a required action.
- "Skip" is a secondary/destructive action (remove this clip entirely from the film). Visually subordinate.
- Remove the binary Include/Skip toggle as the primary UI. The primary action is now trimming.

**B. Clip navigation thumbnail strip:**
- Replace "Clip X of Y, Z remaining" text counter with a horizontal scrollable strip of miniature clip thumbnails
- Each thumbnail: poster frame captured during scan (~80×45px)
- Status badges per thumbnail: included (bright), skipped (dim/greyed out), current (highlighted border + label)
- Clicking a thumbnail jumps to that clip
- Strip supports drag-to-reorder (updates clip sort order via new `reorder_clips_cmd` Rust command)
- Running total duration shown beneath the strip: "~3m 24s included" (sum of trimmed durations of included clips)
- Requires a `sort_order INTEGER` column added to `clips` table (migration); `start_job` uses this order when building the manifest

**C. Interactive filmstrip trim:**
- Replace the current IN/OUT sliders with an interactive filmstrip bar below the video player
- Filmstrip spans the full clip duration, proportionally sized
- **Fallback state (no sprite yet — first session):** Show a clean single-frame poster with a soft grey overlay and a subtle label: "Filmstrip preview available after first render". Visually intentional — not broken-looking.
- **Active state (sprite exists):** Show the sprite image stretched across the filmstrip width (see sprite generation below)
- In/out selection region: bright and full colour
- Trimmed-out regions: dark desaturated overlay
- Draggable handles at in and out points — update `in_ms` / `out_ms` in real-time, save on release via `update_clip_review_cmd`

**D. Sprite generation (pipeline extension):**
- Extend `proxy.py`: after generating the H.264 proxy, run a second FFmpeg pass to extract frames at even intervals (1 frame per 5s, max 12 frames) and stitch into a single sprite JPEG (`clip_sprite_<clip_id>.jpg`) stored in the same proxy directory
- Sprite dimensions: each frame at 160×90, final image = up to 1920×90 (12 frames wide)
- Emit `SPRITE:clip_id=...,win_path=...` on stdout after each sprite (same protocol as `PROXY:`)
- Rust (`lib.rs`): parse `SPRITE:` lines in `run_proxy_gen`; call new `update_clip_sprite()` DB helper; emit `sprite-ready` Tauri event with `{ clipId, spritePath }`
- DB: add `sprite_path TEXT` column to `clips` table (migration, additive)
- `get_project_with_clips`: extend SELECT and index map to include `sprite_path` (column 18)
- TypeScript: add `sprite_path?: string` to `Clip` interface
- Review filmstrip component: listen for `sprite-ready` event; swap from fallback to sprite when received; use `convertFileSrc(sprite_path)` as `<img src>`

**E. Focal point feedback:**
- When user clicks on the video to set a focal point: render a pulsing circle/crosshair at the clicked coordinates (CSS keyframe animation, 2s loop)
- Immediately show a 1.5s zoom preview: CSS `transform: scale(1.2 / 1.3 / 1.5)` centred on the focal point (matches pipeline gentle/medium/tight zoom levels)
- After 1.5s: zoom preview fades out, pulsing dot remains as the persistent focal point indicator
- Remove the static "click to set focal point" instruction text — the interaction should be self-evident from the dot + preview

**Gate:**
- [ ] Screen title is "Build Your Film"
- [ ] Clip nav thumbnail strip replaces text counter; clicking jumps to clip; drag-to-reorder works
- [ ] Total included duration shown beneath the strip, updates in real-time
- [ ] Filmstrip bar replaces IN/OUT sliders; draggable handles; in/out selection visually highlighted
- [ ] Fallback state (no sprite) is a clean poster with intentional grey overlay + label, not a broken stretched image
- [ ] Sprite generation runs after proxy gen; sprite stored in DB; filmstrip swaps to sprite when `sprite-ready` fires
- [ ] Focal point click shows pulsing crosshair + 1.5s zoom preview at correct zoom scale
- [ ] "Skip" is visually subordinate; Include is no longer a required explicit action
- [ ] `sort_order` column in `clips`; `start_job` uses clip order from DB; drag-to-reorder persists

---

### 14f — "Polish" — Screen 3 Cleanup

> **Scope:** Rename and clarify the Editor screen. It is the cosmetic layer — music, transitions, text cards. The film composition is decided in Screen 2. This screen is skippable.

**Screen rename:** Editor → **"Polish"** (title in AppShell header)
- Subtitle or description line: "Add music, transitions, and text to your film"

**Skippable escape hatch:**
- Add a prominent "Skip → Render" button at the top of the screen (next to "Start Rendering")
- This goes straight to the Output screen with current default settings applied
- Tooltip: "Render your film as-is — you can always add effects later"

**Scope enforcement:**
- Remove any per-clip trim or focal point controls that may have drifted into the Editor — those belong in Screen 2
- Confirm the SettingsPanel contains only: music mood, music volume preset, transition style, intro/outro cards
- ClipList (the reorderable clip list) moves to Screen 2 thumbnail strip — remove from Screen 3 if it would be duplicated

**Gate:**
- [ ] Screen title is "Polish"
- [ ] "Skip → Render" button present at top of screen with tooltip
- [ ] No per-clip trim or focal point controls in this screen
- [ ] SettingsPanel scope: music, transitions, cards only

---

### 14g — Tabbed Settings UI (was 14d)

Reorganise SettingsPanel into tabs: **Music/Sound · Effects · Text** (intro/outro cards).

---

### 14h — Benchmarking + Project Cleanup (was 14f)

> **Scope:** Pipeline telemetry surfaced in UI + proper resource cleanup on project delete.

1. `delete_project_cmd` (Rust) — delete `%APPDATA%\rushcut\proxies\<clip_id>.mp4` and `<clip_id>_sprite.jpg` for each clip before removing DB rows
2. `src/pages/Library.tsx` — surface `analysis_summary` per project card (render time, clip count, resolution badge)

**Gate:**
- [ ] Deleting a project removes its proxy and sprite files from disk
- [ ] Library card shows: clips used, total duration, max resolution, render time (from `analysis_summary`)

---

### Batch 14 Gate

- [x] Quick mode is default; Include/Skip keyboard-accessible; Precise expands per clip (14a)
- [x] Proxy generation runs after render completes; proxies used in review screen scrubbing (14b)
- [x] Per-clip in_ms, out_ms, focal_x/y, zoom_mode passed through manifest to pipeline (14c)
- [x] Pipeline applies user IN/OUT over silence trim when set (14c)
- [x] Skipped clips excluded from render (14c)
- [ ] Upload shows progressive animated cards (14d)
- [ ] "Build Your Film" screen with filmstrip trim + sprite + focal feedback + clip nav strip (14e)
- [ ] "Polish" screen with Skip to Render + cosmetics-only scope (14f)

---

## Batch 14f — Benchmarking + Project Cleanup

> **Scope:** Pipeline telemetry surfaced in UI + proper resource cleanup on project delete.

1. `delete_project_cmd` (Rust) — delete `%APPDATA%\rushcut\proxies\<clip_id>.mp4` for each clip before removing DB rows
2. `src/pages/Library.tsx` — surface `analysis_summary` per project card (render time, clip count, resolution badge)

### Gate

- [ ] Deleting a project removes its proxy files from disk
- [ ] Library card shows: clips used, total duration, max resolution, render time (from `analysis_summary`)

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
