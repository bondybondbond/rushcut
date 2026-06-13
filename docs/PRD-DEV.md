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

**Transition Preview:** Moved to Batch M1 (CSS-only looping demo per chip on hover/select — no pipeline).

### 15f — Sound screen (`/sound/:projectId`) (**DONE 2026-04-28**)

`/sound/:projectId` route. Music mood chips (No Music / Cinematic / Upbeat / Chill / Electronic) + conditional volume chips (Subtle / Balanced / Prominent). sessionStorage `rc_sound_${projectId}` (JSON). Editor seeded from both sound + transition storage keys. 13/13 E2E PASS.

**Music preview (deferred):** 30s looping audio preview on chip select. Deferred alongside Transition Preview — both will ship together once the full flow (15g Render) is confirmed working end-to-end.

### 15g — Render screen (`/render/:projectId`) (**DONE 2026-04-29**)

`/render/:projectId`. Auto-starts render on mount — no idle phase. `buildConfig()` reads sessionStorage transition + sound settings. Phase machine: starting → rendering → done/error. Progress bar, stage label, elapsed timer, 10-min inactivity timeout. Done: video player + output filename + Open in Explorer + My Projects. Error: Try Again. Editor + Output pages deleted. Library rename added. Review.tsx stale `/editor/` routes fixed. 15/15 E2E PASS. Deferred: sticky filmstrip + format selector + music/transition preview.

---

## Backlog — Sound Screen UX Polish (post-B2 founder feedback, 2026-05-03)

> **Deprioritised — Batch C or dedicated audio polish batch. Do not regress `e2e/sound.spec.ts` (13 assertions).**

**1. "No Music" visual differentiation** — chip looks identical to mood chips (Cinematic, Upbeat etc.). It's a none/off option, not a mood. Consider: muted border (`border-white/20` instead of `border-white/35`), secondary text colour, or explicit section label ("No track" vs mood group). Read DESIGN.md "Configure Panel Chips" before changing.

**2. Custom Track affordance** — clicking the chip doesn't clearly signal it will open a file picker. Add a small upload icon or inline hint text `(pick file)`. Check DESIGN.md for chip patterns — do not invent a new pattern.

**3. Post-pick metadata** — ~~show audio duration~~ **DONE (Batch E):** track durations shown on mood chips ("Cinematic · 2:34"); film duration in header subtitle; comparison line shows "long enough" (green) or "will loop ~Nx".

**4. Volume "Balanced" too loud** — `balanced` maps to `movie_vol = 0.7` (in `pipeline/render.py` `_MOVIE_VOL`). Founder confirms music still competes with clip audio at this level. Test: change `balanced → 0.5`. Verify with `grep "[vol]" pipeline-latest.log` after a test render. Only change after confirming via log — do not guess.

---

## Batch H — App Shell Redesign (UI Relocations)

> **Status: DONE (2026-05-09). Full layout restructure complete. 9/9 fast E2E PASS.**
> **Scope: layout-only. No pipeline changes, no new data, no new routes.**

### Motivation

The current shell puts navigation at the top (StepNav breadcrumb) with a burger menu at the far left. The "New ideal" founder design moves all nav to the bottom, freeing the top for a clean project-info band and giving the main content area maximum height.

### Target layout (all editor screens: Trim / Transitions / Sound / Render)

```
┌──────────────────────────────────────────────────────────────┐
│  project name · N clips · duration            [thin top bar] │
├────────────┬─────────────────────────────────┬───────────────┤
│            │                                 │               │
│   Media    │          Previewer              │  Action bar   │
│   pantry   │                                 │  (per-screen) │
│            ├─────────────────────────────────┤               │
│            │  Clip timeline / controls       ├───────────────┤
│            ├─────────────────────────────────┤  Chosen       │
│            │  Overall timeline (ruler HUD)   │  effects      │
├────────────┴────────────────────────────────┬┴───────────────┤
│  [Home]   Trim · Transitions · Sound · Render   [RC Logo]    │
└─────────────────────────────────────────────────────────────┘
```

### Changes required

**1. Remove the top bar entirely**
- Delete the `<nav>` row that currently holds the burger menu + StepNav + "Next: X →" CTA.
- The StepNav component becomes the bottom tab bar (see below).

**2. Add a thin project info bar at the top**
- Full-width, height ~28px, `bg-[#0a0a0a] border-b border-white/10`.
- Content: `project name · N clips · duration` — `text-sm text-[#e5e5e5]` left-aligned, `pl-4`.
- Read from `project.name`, `inFilm.length`, `fmtMs(totalMs)` (already computed in StickyFilmStrip — pass up or re-derive).
- No buttons, no icons. Pure status read-out.

**3. Replace StepNav with a bottom tab bar**
- Fixed full-width bottom bar, height ~48px, `bg-[#0a0a0a] border-t border-white/10`.
- Left: **Home button** — house icon, navigates to `/library` (project auto-saves on every interaction already — no explicit save CTA needed).
- Center: four step tabs (Trim / Transitions / Sound / Render) as icon + label buttons. Active step uses peach `#FF8A65` underline + peach text. Completed steps: white text, clickable. Future steps: `#a3a3a3`, disabled.
- Right: **RushCut logo/wordmark** (see Batch I).
- "Next: X →" CTA is removed — users navigate via the step tabs directly. The funnel warning (user attempts to Render without setting Transitions/Sound) is handled by a confirmation dialog on the Render tab if those steps are empty.

**4. Move "Chosen effects" chips out of StickyFilmStrip**
- Currently transition + music chips are crammed into the right side of the StickyFilmStrip HUD.
- New location: right column, below the Action bar. A small labelled section: "Effects" header (`text-xs text-[#a3a3a3] uppercase`) followed by the chip buttons stacked vertically.
- StickyFilmStrip right section (duration summary + chips) is removed. Duration summary relocates to the top info bar.
- StickyFilmStrip becomes clip-tiles + ruler only — no right sidebar.

**5. Right column structure per screen**
- `Action bar` (top): per-screen controls that currently live in the right sidebar (e.g. Trimmer: Prev/Next/Add to Film; Transitions: chip picker; Sound: source selector).
- `Chosen effects` (bottom): transition chip + music chip — shown on all screens once set.
- Right column width: ~200px, `flex-shrink-0`.

**6. Home auto-save behaviour**
- Clicking Home navigates to `/library`. No save prompt.
- All state already persists (DB for clip IN/OUT, sessionStorage for transition/mood) — nothing to flush.
- If user is mid-trim (unsaved handle drag), the trim auto-saves on `mouseup` already (existing behaviour). No edge case.

### Files touched (estimate)
- `src/components/StepNav.tsx` — full rewrite as bottom tab bar
- `src/components/StickyFilmStrip.tsx` — remove right-side duration + chips section
- `src/pages/Trimmer.tsx` — restructure layout, add project info bar + right column
- `src/pages/Transitions.tsx` — same layout restructure
- `src/pages/Sound.tsx` — same layout restructure
- `src/pages/Render.tsx` — apply bottom tab bar (simpler — no left pantry or HUD)
- `e2e/fast.spec.ts` — update any assertions that use StepNav top-bar selectors
- `docs/DESIGN.md` — document new shell layout, bottom tab bar pattern

### Acceptance checks
- [x] All screens: project name + clip count + duration visible in top bar
- [x] All screens: bottom tab bar visible with Home / Trim / Arrange / Sound / Render (lucide icons)
- [x] Active tab is peach; configured tabs are white; unconfigured tabs are `#a3a3a3`
- [x] Clicking Home from any screen navigates to Library with no prompt
- [x] Chosen effects (transition + music) visible in effects aside on screens where set
- [x] StickyFilmStrip HUD shows only ruler + clip tiles (no duration sidebar)
- [x] No top burger menu / NavDrawer visible on any screen
- [x] 9/9 fast E2E PASS

### Notes / risks
- `data-testid="btn-nav-open"` (burger menu) is referenced in `e2e/render.spec.ts` — update that spec.
- StepNav currently uses `disabled` prop to block future-step navigation. Bottom tab bar must preserve that guard.
- Render screen has no Media Pantry and no StickyFilmStrip — its layout is simpler (full-width content). Bottom tab bar still shows; right column shows chosen effects (read-only).

---

## Batch J — Arrange Screen: Clips Tab (Per-Clip Volume + Zoom)

> **Status: ✅ COMPLETE (2026-05-16).**
> **Scope: Creates `/arrange/:projectId` (replaces `/transitions/`). Three-tab shell: Clips | Transitions | Cards. This batch ships the Clips tab only — Transitions tab content migrated from current screen, Cards tab placeholder. Per-clip volume DB + pipeline. Zoom UI only (DB + pipeline already exist).**

### Motivation

Users need to adjust individual clip volume and zoom before they can produce a polished film. This batch consolidates the Arrange tab into a single multi-tab screen that Batches L and M will complete.

### Screen architecture

`/arrange/:projectId` replaces `/transitions/:projectId`. The Arrange tab in the bottom bar already navigates to the transitions route — this batch renames the route and adds the tab shell. All existing `navigate("/transitions/")` calls updated. `wdio.conf.ts` + `transitions.spec.ts` URL updated. **Do not regress transitions.spec.ts** (route changes, content unchanged).

**Tab bar within the screen:** `[Clips]  [Transitions]  [Cards]`
- **Clips tab** (this batch): film timeline + per-clip controls
- **Transitions tab** (this batch): migrated from current `/transitions/` content, unchanged
- **Cards tab** (Batch L): placeholder "Coming soon" for now

### Clips tab layout

3-column EditorShell. No Media Pantry. Film timeline (StickyFilmStrip) at bottom. Right panel = per-clip controls when a clip is selected.

**Film timeline:** Click a clip tile → selects it (peach border). Drives the right panel.

**Right panel:**

- **Volume:** Mute toggle (lucide `VolumeX`, peach when muted) + slider 0–200%, default 100%. Saves debounced 300ms via `update_clip_volume_cmd`.
- **Zoom:** Chips `Off` / `1.3×` / `1.5×` / `2×` → `zoom_mode` `none`/`gentle`/`medium`/`tight`. Saves on click via existing `update_clip_review_cmd`.
- **Focal point:** `thumbnail_data` ~160×90px clickable image. Click sets `focal_x`/`focal_y`. Visual dot at position. "Reset to centre" link. Hidden when zoom is Off.
- **Empty state:** `"Select a clip in the timeline to adjust it"` — `text-sm text-[#a3a3a3] italic`.

### DB + pipeline

**DB:** Add `clip_volume REAL DEFAULT 1.0` column (additive migration).

**Rust:** `update_clip_volume_cmd(clip_id: i64, volume: f32)` + `update_clip_volume()` db helper. `clip_volume` in `start_job` manifest alongside `focal_x`, `focal_y`, `zoom_mode`.

**Pipeline (`render.py`):** Apply `[{i}:a]volume={clip_volume}` per clip before crossfade chain. Muted (volume=0): substitute `aevalsrc=0:c=stereo:d={dur}:r=48000` so filter graph stays valid.

**Note:** `focal_x`/`focal_y`/`zoom_mode` already in DB + pipeline since Batch 14c — no pipeline change for zoom.

### Acceptance checks

- [ ] Arrange screen loads at `/arrange/:projectId`; Arrange tab active; Clips / Transitions / Cards tabs visible
- [ ] Transitions tab shows existing content (3 chips + description); transitions.spec.ts passes
- [ ] Cards tab shows "coming soon" placeholder
- [ ] Clicking a clip in the timeline shows volume + zoom controls in right panel
- [ ] Volume slider + mute saves; muted clip silent in rendered output; 50% audibly quieter
- [ ] Zoom chip saves; clip appears zoomed in rendered output
- [ ] Focal point click sets visible dot; zoom centres on that region
- [ ] No regression: Trimmer + Render flow unaffected

---

## Batch K1 — Arrange Screen: Full Redesign

> **Status: PLANNED — pre-launch must-have.**
> **Prereq: Batch J (Arrange screen shell exists).**
> **Scope: Complete redesign of the Arrange screen layout + zoom UX. Volume per clip moves to Sound screen (Batch K2). Ken Burns zoom modes added. Bin button replaced by gesture/keyboard delete.**

### Motivation

The Batch J Clips tab is functional but the layout doesn't match the intended design (centred large preview with Prev/Next clip navigation). Zoom also needs Ken Burns modes (slow, but sellable) alongside the fast static crop already shipped. Per-clip volume logically belongs on the Sound screen alongside music — separating them from zoom gives each screen a cleaner single purpose.

### Layout redesign

Replace the current EditorShell left-panel + right-panel layout with a **centred preview** layout:

- **Left clip rail** — vertical strip of all project clips (thumbnails), scrollable; active clip highlighted peach. Click to jump to clip.
- **Centre** — large clip preview (video player, dominant, fills available height). Clip name + duration below.
- **Prev / Next** — arrow buttons on left/right sides of the preview, stepping through clips in order.
- **Tab bar** — "Zoom" tab only (single tab, or "Zoom | Transitions | Cards" shell kept but Clips renamed Zoom).
- **Controls** — zoom chips + focal point picker below/beside the preview (same controls as Batch J, restyled to new layout).

### Tab rename

"Clips" tab → **"Zoom"**. The tab controls zoom + focal point only — volume is gone (moved to K2).

### Three zoom modes

Replace the current On/Off + preset chips with three explicit mode chips:

| Chip | Mode | Pipeline | Speed label |
|---|---|---|---|
| **Crop** | Static crop to focal point | `crop+scale` (current zoom.py) | — |
| **Zoom In** | Ken Burns 1× → target zoom, panning toward focal | `zoompan` expression | "Slower render" |
| **Zoom Out** | Ken Burns target zoom → 1×, panning away from focal | `zoompan` expression | "Slower render" |

- Default: **none** (no zoom). Crop is fast; KB modes add render time (warn in chip label or tooltip).
- `zoom_mode` DB values: `null` (off) / `"crop"` / `"zoom_in"` / `"zoom_out"`.
- `zoom.py` already handles static crop. Ken Burns paths: new `zoompan` branches keyed by mode.
- Focal point picker shown for all three modes (determines crop centre / KB pan target).

### Timeline clip badges

On `StickyFilmStrip` clip tiles, show small indicator dots:
- **Green dot** — `zoom_mode IS NOT NULL` for this clip
- **Purple dot** — `clip_volume != 1.0` for this clip (need `clip_volume` in StickyFilmStrip props)

Dots overlay the bottom-right corner of the tile at z-10.

### Delete clip via gesture / keyboard

Remove the hover bin button from clip tiles in the film timeline. Replace with:
- **Drag left** — drag a tile leftward past a threshold (~40px) → delete with a red flash
- **DEL key** — when a clip tile is focused/active, DEL removes it

`onDeleteClip` prop retained on StickyFilmStrip; just the trigger changes.

### Acceptance checks

- [ ] Arrange screen loads with centred preview, left clip rail, Prev/Next nav
- [ ] Clicking clip in rail selects it; Prev/Next step through clips in order
- [ ] "Zoom" tab visible; no "Clips" tab
- [ ] Crop / Zoom In / Zoom Out chips; selecting KB mode shows "Slower render" label
- [ ] Focal picker shown for all zoom modes; hidden when no zoom
- [ ] Timeline tiles show green dot when zoom set, purple dot when volume ≠ 100%
- [ ] Drag-left past threshold on a tile removes it; DEL key on focused tile removes it
- [ ] Volume controls absent from Arrange screen
- [ ] Rendered output: Ken Burns pan/zoom visible on zoomed clips; static crop unchanged

---

## Batch K2 — Sound Screen: Per-Clip Volume + Music Polish

> **Status: PLANNED — pre-launch must-have.**
> **Prereq: Batch K1 (volume removed from Arrange).**
> **Scope: Add per-clip volume tab to Sound screen. Music crossfade-out chips. Quick Preview render.**

### Motivation

Per-clip volume belongs with music — both affect the audio mix and users want to balance clip audio against the music track in one place. Moving it here lets the Sound screen own the full audio experience.

### K2a — Sound screen tab structure

Add a two-tab shell to Sound screen:

- **Tab 1: Music** — existing source chips (No Music / Library / Upload Own Track), volume chips, fade-out chips (new). Default tab.
- **Tab 2: Clips** — per-clip volume controls (lifted from Batch J Arrange screen, same chip UX: Mute / 50% / 100% / 150% / 200% + Custom). Clip selector = same left rail or compact list as K1 Arrange layout.

`rc_sound_${projectId}` sessionStorage: extend to persist clip volume state or keep in DB (already there via `clip_volume` col — just remove from Arrange and surface here).

### K2b — Music crossfade out

**UI:** "Fade out" row on Music tab, below volume chips. Chips: `None` / `2s` / `5s` (default `2s`). Persist in `rc_sound_${projectId}` as `musicFadeOut`. Visible when music source is not "none".

**Pipeline (`music.py`):** Append `afade=t=out:st={max(0, film_dur - fade_s)}:d={fade_s}` to music filter chain before amix. `run.py` passes `music_fade_out_s` from config.

### K2c / K3 Revised — Live Rough Mix (**DONE 2026-05-17**)

**Decision:** Replaced planned Rust/WSL/480p render pipeline with instant front-end-only rough mix. Render wait (~15-20s) was wrong UX for "does this music sit right?" — users need directional confidence, not render accuracy.

**Implementation:** `Sound.tsx` only — no Rust changes, no pipeline. Hidden `<video>` element (`filmVideoRef`) cycles through `inFilm` clips sequentially; `<audio>` element (`musicAudioRef`) plays music simultaneously. Full play/pause/seek, `out_ms` respected via `onTimeUpdate` guard, music synced to seek position with volume reset, fade-out marker on progress bar.

**Deferred to future batch:**
- Live playhead tracking on StickyFilmStrip during Master playback

**Rust:** `run_preview_cmd(project_id)` Tauri command. Emits `preview-progress` + `preview-done:{path}`. Cancel = kill WSL process.

**UI (Music tab):** "Preview film" button below source chips. Progress overlay → inline 480p player. Re-click cancels previous job.

### Acceptance checks

- [ ] Sound screen has Music + Clips tabs; Music is default
- [ ] Clips tab shows per-clip volume chips; saves to DB; survives reload
- [ ] Fade-out chips on Music tab; fade audible in preview and full render
- [ ] "Preview film" button on Music tab; completes in <30s for 10-clip film
- [ ] Per-clip volumes reflected in preview audio mix
- [ ] Purple dot badges on StickyFilmStrip tiles still accurate (read from DB)

---

## Batch K4 — Dual-Buffer Clip Advance on Master Tab (Black Flash Fix)

> **Status: DONE — 2026-05-17. 9/9 fast E2E PASS.**
> **Scope: `src/pages/Sound.tsx` only. No pipeline changes.**

### Problem

The Master tab rough-mix player loads each clip directly into `filmVideoRef` on advance. Between clips there is a brief black frame as the browser unloads the previous source and begins decoding the next one. On fast cuts this is visually jarring.

### Fix

Port the dual-buffer ping-pong pattern already proven in `Trimmer.tsx` (`filmVideoARef` / `filmVideoBRef`):

- Two `<video>` refs: `filmVideoARef` + `filmVideoBRef` (both `w-0 h-0 opacity-0 absolute` — only the active one is sized and visible)
- `activeSlotRef` (`"a" | "b"`) tracks which slot is currently playing
- **During current clip playback**, preload the next clip into the inactive slot (`preloadNextClip()`) once the current clip has been playing for > 500ms (enough time for the next clip to buffer)
- **On advance**, swap `activeSlotRef`, show the now-ready slot, hide the old one, call `.play()` — the new clip's first frame is already decoded, so no black gap
- `loadedClipIdxRef` tracks which clip is loaded in each slot

### Acceptance check

- [ ] No black frame visible between clips during Master tab rough-mix playback
- [ ] Preload starts silently during current clip (no audio bleed from inactive slot — `inactive.muted = true` or `inactive.volume = 0`)
- [ ] Seek still works correctly (seeked clip loaded into the active slot directly, inactive slot reset)
- [ ] 9/9 fast E2E PASS

---

## Batch L — Arrange Screen: Cards Tab (Text Cards)

> **Status: ✅ COMPLETE (2026-05-17).**
> **Prerequisite: Batch J (Arrange screen + tab shell must exist).**
> **Scope: Activate the Cards tab on the Arrange screen. Start/end text cards UI + pipeline wiring.**

### Motivation

A film that starts with raw footage and ends abruptly feels unfinished. Start and end cards give it structure and identity.

### Changes

**Cards tab** (replaces the Batch J placeholder):

- **Start card:** toggle (default on) + main text input (max 60 chars, default = project name) + subtitle input (optional, max 80 chars). CSS preview: `160×90px` dark rect, peach title + white subtitle.
- **End card:** toggle (default off) + single text input. CSS preview: same rect, centred white text.

**sessionStorage:** `rc_cards_${projectId}` → `{ startCard: { enabled, text, subtitle }, endCard: { enabled, text } }`. Consumed by `buildConfig()` at render time.

**Pipeline (`cards.py` + `render.py`):** `cards.py` already generates H.264 card clips via Pillow. `render.py` prepends start card and appends end card to the clip sequence. Duration: 2s each. Canvas = output resolution.

### Acceptance checks

- [ ] Cards tab active on Arrange screen; no longer shows "coming soon"
- [ ] Start card appears at beginning of rendered film; title defaults to project name
- [ ] Start card subtitle optional; renders when set
- [ ] End card toggled on appears at end; toggled off = no end card
- [ ] CSS preview matches final design tokens (peach title, white body, dark bg)
- [ ] No regression: Clips and Transitions tabs unaffected

### Deferred

- **Card in-film preview:** User should be able to preview start/end cards in context of the actual film (not just the static CSS rect) before committing to render. Likely implemented as a playable film preview that includes the 3s card segments at the correct position. Deferred post-launch.

---

## Batch M — Arrange Screen: Transitions Tab Expansion

> Two sub-batches. M1 ships transition previews (no pipeline). M2 ships new types + shuffle + first/last cut (pipeline). Can ship independently.

### Batch M1 — Transition Preview (CSS only)

> **Status: DONE (2026-05-17).**
> **Scope: `src/pages/Arrange.tsx` + `src/globals.css`. No pipeline.**

Every major editor (Premiere, DaVinci, CapCut, iMovie) shows a looping visual demo when a transition is selected — table-stakes UX.

**Per-chip CSS animation:** 3s looping card-chip (vertical card: animated thumbnail on top + label below). Animation plays when selected; static otherwise. Thumbnails derived from first/last in-film clip (`thumbnail_data` base64 JPEG); colour-block fallback when no clips.

| Chip | Animation |
|---|---|
| None | Hard cut via `steps(1, end)` timing function |
| Crossfade | `opacity` dissolve A→B→A |
| Dip to Black | A fades out → black gap → B fades in → A |
| Wipe (M2) | Horizontal wipe left |
| Zoom (M2) | Scale-up fade |

Wipe + Zoom previews added when those chips ship in M2.

**Acceptance checks:**
- [x] Each chip shows a looping CSS animation when selected (static when not selected)
- [x] Thumbnails show real clip images (first/last in-film clip); colour-block fallback
- [x] None = instant hard cut (no dissolve); Crossfade = smooth dissolve; Dip = black gap visible
- [x] No pipeline invoked; no performance impact during preview
- [x] 9/9 fast E2E PASS (testids preserved)

---

### Batch M2 — Expanded Transition Types + Left-Rail Layout + Shuffle

> **Status: DONE (2026-05-18).**
> **Scope: `pipeline/transitions.py` + `Arrange.tsx` Transitions tab + `src/globals.css` + `src/types/project.ts` + `src/utils/buildJobConfig.ts`.**

Shipped: 9 transition types (None / Crossfade / Dip to Black / Wipe / Wipe Down / Zoom / Dissolve / Barn Door / Band Wipe) + Shuffle (random per-cut from all 8 non-none types, seeded by job_id for determinism). Left-rail layout (10 cards: 9 types + Shuffle) + enlarged centre preview (h-56). Opening / closing cut UI dropped (pipeline plumbing retained, always defaults to "none"). Animation bug fixed: unselected cards now use `animation: "none"` in JSX instead of CSS play-state (inline style beats class specificity). `TransitionConfig = { between, opening, closing, shuffleBetween }` JSON storage with compat reader. Pipeline: `_TRANSITION_MAP` extended (wipe_down→wipedown, dissolve→dissolve, barn_door→squeezev, band_wipe→hrslice); `_SHUFFLE_POOL` extended to all 8 FFmpeg names. 23/23 arrange E2E PASS.

#### Deferred / known issues

- **CSS animation accuracy:** The card-chip and centre preview CSS animations are functional approximations — they convey the transition concept but don't perfectly match the FFmpeg xfade output (e.g. barn door uses `scaleY` rather than true dual-inset clip-path; band wipe doesn't replicate `hrslice` slice bands). Acceptable for launch; polish in a future batch (see Post-Launch Backlog).
- **Card-chip mini-preview thumbnails:** Rail cards show actual clip thumbnails (same image top + bottom until selected) — visually redundant. Better approach: replace with a simple 2-colour geometric visualisation (e.g. coloured rectangles/shapes) that shows the transition mechanic at a glance without needing real clip images. Centre preview (uses real thumbnails) is the primary demo surface; the mini-cards are just a selection mechanism. See Post-Launch Backlog.

---
## Batch N — Background Proxy Pre-Generation (First-Render Speed)

> **Status: DONE (2026-05-19).**
> **Scope: `src-tauri/src/db.rs`, `src-tauri/src/lib.rs`, `src/pages/Trimmer.tsx`, `pipeline/render.py`.**

Silent background proxy pre-generation. Trigger: `Trimmer.tsx` unmount `useEffect` cleanup calls `invoke("generate_proxies_cmd", { projectId, lowPriority: true })` fire-and-forget. Rust `run_bg_proxy_batch`: serial HEVC encode at Windows `BELOW_NORMAL_PRIORITY_CLASS` + `-threads 1`; encodes at `scale=-2:2160` (qualifies for both 1080p and 4K renders); `is_valid_proxy_file()` + height check on success → `update_clip_proxy` + `set_clip_proxy_status('done')`. Native-codec (H.264/VP8/VP9) clips skip encode instantly. Existing `Arc<Mutex<HashSet>>` concurrency guard prevents duplicate spawns. `proxy_path` written to DB → `start_job` manifest already includes it → `render.py` Batch C proxy-reuse logic skips normalise automatically.

**4K fix (shipped same session):** Background gen upgraded from `scale=-2:1080` to `scale=-2:2160`. `render.py` `required_proxy_h = 2160 if output_resolution == "4k" else 1080` — rejects 1080p proxies for 4K renders. `get_clips_needing_bg_proxy` returns ALL `include=1` clips; `proxy_height_native()` in Rust detects and upgrades legacy 1080p proxies. Logs to `%TEMP%\rushcut\proxy-bg.log`.

### Acceptance checks

- [x] Leaving Trimmer tab fires background proxy gen for all `include=1` clips — confirmed in `proxy-bg.log` (5 clips, 6–18s each)
- [x] Background gen uses Windows `BELOW_NORMAL_PRIORITY_CLASS` — low-priority, UI stays responsive
- [x] Re-triggering (Trimmer → Arrange × N) does NOT spawn duplicate FFmpeg processes — `skip reason=no-clips-need-proxy` fires on second trigger
- [x] First render after background gen completes: normalise stage ~2s (proxy_skip=N/N)
- [x] If render starts before proxies done: graceful fallback to full normalise (existing Batch C path)
- [x] `proxy_status` column persists correctly across app restarts
- [x] No regression: 9/9 fast PASS · 23/23 arrange PASS · 15/15 render PASS (2026-05-19)
- [x] 4K render uses 2160p proxy, not 1080p — quality confirmed by founder ("good 4K quality")

---

---

## Backlog — Thumbnails show frame 0 of trimmed section (not raw clip start)

> **PRD item — reported 2026-05-19. Adds visual clarity to per-clip editing.**

Currently, clip thumbnails are extracted from the raw source clip at `~1s` seek (or wherever `scan.py` / native Rust extracts them). When a user has set `in_ms=15000ms` on a clip, the thumbnail still shows the clip's opening frame — not the frame they chose as their cut-in point. This makes it harder to identify which section of a long clip is being used.

**Design:** On thumbnail generation, if `in_ms` is set, extract the frame at `in_ms` (or `in_ms + 500ms` to avoid a potential cut boundary). Update lazily: when the user saves an IN point change in the Trimmer, queue a thumbnail re-extract for that clip.

**Scope:** `src-tauri/src/lib.rs` thumbnail extraction logic; `db::update_clip_thumbnail()`; potentially `Trimmer.tsx` to trigger re-extract on IN-point commit. May be too invasive for current batch — defer to a dedicated batch if so.

---

## Backlog — Click trimmed clip in film timeline to jump to editing it (Trim screen)

> **PRD item — reported 2026-05-19.**

On the Clip tab of the Trim screen, clicking a trimmed clip in the bottom film timeline (StickyFilmStrip) should:
1. Select the corresponding raw clip in the media pantry (updating the pantry highlight)
2. Load that raw clip into the video player with the saved IN/OUT handles restored
3. Scroll the pantry to make the selected clip visible if needed

Currently the only way to jump to editing a specific trimmed cut is to manually find and click its source clip in the media pantry.

**Scope:** `StickyFilmStrip.tsx` (add `onSelectClip?: (clipId: string) => void` prop, emit on click); `src/pages/Trimmer.tsx` (handle `onSelectClip`, find matching pantry clip, set `selectedClipId`).

---

## Backlog — Adjust trim handles from Film tab (inline trim editing like DaVinci)

> **PRD item — reported 2026-05-19. More advanced; DaVinci Resolve-style.**

In the Film tab of the Trim screen, clicking a trimmed clip should show orange IN/OUT handles on its timeline tile. Dragging the left handle adjusts `in_ms` (earlier = expand clip start, later = trim clip start); dragging the right handle adjusts `out_ms`. Constrained to the raw clip's `[0, duration_ms]` range. Saves on drag-end via `update_clip_review_cmd`.

**Design consideration:** This overlaps significantly with the Clip tab's TrimBar. Before building, decide if the two tabs should merge or stay distinct (see founder note: "having the two tabs / screens too similar might eliminate the need for clip and film tabs — so maybe it's ok to keep them distinct"). Document decision before implementation.

**Scope:** `StickyFilmStrip.tsx` (drag handles on active tile), `src/pages/Trimmer.tsx` (save on release). Non-trivial — full own batch.

---

## Backlog — Media pantry highlight tracks current playing film clip

> **PRD item — reported 2026-05-19.**

When watching clips in the Film tab of the Trim screen (or Arrange screen), the media pantry highlight should update as the film advances — showing which raw source clip is currently playing. Currently the pantry highlight only updates on explicit user selection, not during film playback.

**Scope:** `src/pages/Trimmer.tsx` (or Arrange) — on `advanceFilmClip`, emit which pantry clip (by `local_path`) is now active, update `selectedClipId` (or a separate `activeFilmPantryId` ref if we want to avoid disturbing the edit-selection state).

---

## Backlog — Cancel in-progress render (with confirmation)

> **PRD item — reported 2026-06-11 (founder, during U4 diagnostics).**

A render job that has started cannot currently be cancelled — the user must wait for it to finish (or stall out). Add the ability to cancel a running render from the Render screen, gated behind a confirmation prompt. Pairs naturally with the U1e stall-warning work: a stalled render is the prime case where the user wants out.

**Scope:**
- `src/pages/Render.tsx` — "Cancel render" control visible only while `phase === "rendering"` (and likely `"preparing"`). On click, `confirm()` from `@tauri-apps/plugin-dialog` (NOT `window.confirm` — broken in WebView2; see `.claude/rules/rust-tauri.md`).
- `src-tauri/src/lib.rs` — new command to terminate the WSL `python3 run.py --job-id <uuid>` process for the job; clean up `/tmp/<job_id>` in WSL; set the job row status to cancelled/failed. May need to track child PID or kill-by-job-id in WSL.
- Design per `docs/DESIGN.md`: secondary/destructive styling, peach headings, no grey text.

---

## ~~Backlog — Zoom preview auto-plays on clip switch while paused~~ **DONE (U4b, 2026-06-12)**

> **Bug — reported 2026-06-11 (founder, during U4 diagnostics). Fixed U4b.**

`prevZoomClipIdRef` added to `Arrange.tsx` — clip-switch branch calls `syncZoomToPlayhead(0, false)` unconditionally, bypassing stale `isPlayingRef.current`. Param edits on the same clip still preserve live play state.

---

## Backlog — U1g segmented render falls back to monolithic under memory pressure (BUG)

> **Bug — diagnosed 2026-06-12 (founder, during U4b diagnostics). Assigned Batch U4c.**

`_render_segmented()` in `pipeline/render.py` writes `u1g_seg_N.mp4` and `u1g_concat.txt` to WSL `/tmp/<job_id>/`. Under memory pressure from two sequential 4K encodes, WSL tmpfs can silently clear that directory between batch-2 encode completing and the concat-manifest write. `write_text()` raises `[Errno 2] No such file or directory`; the outer `except Exception` catches it and falls back to the monolithic path — exactly the OOM scenario U1g was designed to prevent. Confirmed on job `db8f3aa6`: both batches reported `drift=0 frame(s)` then fell back → SIGTERM.

**Fix:** Move U1g working dir from `Path("/tmp") / job_id` to `Path(os.environ["TEMP"]) / "rushcut" / job_id` (NTFS). Same pattern already used by zoom-cache and `warm_zoom.py`. Segment paths in the concat file need the `/mnt/c/...` prefix (existing `win_to_wsl()` helper). No other files change.

**Scope:** `pipeline/render.py` `_render_segmented()` only — `TMP_BASE` constant + concat-path construction.

---

## Backlog — Zoom cache cold when user skips Zoom tab (PERF)

> **Observed 2026-06-12 (founder, U4c verification render). Future sub-batch TBD.**

The U4 three-tier warm trigger fires on (a) zoom-tab-leave, (b) 500ms debounce on param edit, (c) Arrange unmount. All three require the user to have visited the zoom tab during the current session. If the user never opens the Zoom tab (e.g. re-rendering with same zoom settings), the warm_zoom job is never triggered → zoom stage runs cold on render → ~7-8 mins for a 7-clip 4K project, long enough to fire the U1e stall alert and crash the render.

**Observed symptom (2026-06-12):** 2m42s film, 7 clips, 4K, xfade; zoom tab skipped; zoom stage ran cold; stall alert fired; render crashed ("Pipeline timed out"). Total elapsed >20 min.

**Root cause:** warm_zoom is *reactive* (triggered by UI events) rather than *proactive* (triggered by any change that makes the cache stale). The cache should also be validated and warmed:
- On project open (Arrange mount): if any included clip has a non-null `zoom_mode` and no warm cache entry, fire `warm_zoom_cache_cmd` immediately at BELOW_NORMAL priority.
- On Render screen entry (before `submitJob`): gate check — if zoom clips exist and warm entries are absent, surface a soft warning or auto-trigger a warm pass before committing.

**Ideal direction:** a lightweight "background job oracle" that, at well-defined entry points (project open, render screen entry), asserts which background jobs (proxy gen, zoom warming) need to be done and fires them if they haven't run. Frontloads the work regardless of which UI path the user took to get there.

**Scope:** `src/pages/Arrange.tsx` (mount effect) + `src/pages/Render.tsx` (pre-submitJob check). `warm_zoom_cache_cmd` already exists in Rust and accepts any manifest; the trigger gap is purely in the React layer. May want a new lightweight Rust query: `get_zoom_clip_count_cmd(project_id)` returning how many included clips have a non-null zoom_mode — cheap signal to decide whether to fire the warmer.

---

## Backlog — WebView2 crashes playing high-bitrate 4K renders (BUG)

> **Observed 2026-06-12 (founder, during U4c verification). Future sub-batch TBD.**

Playing `stagecoach-2025-01.mp4` (795 MB, 4K H.264 40Mbps, 140s) in the Render screen's `<video>` element caused the WebView2 renderer to crash. The app restarted and routed to the initial state ("back to start"). The file itself is healthy — ffprobe confirms matching duration on both streams, 4214 frames, no corruption. The crash is WebView2 failing under 40Mbps 4K decode pressure, not a code bug in `Render.tsx` (confirmed: `onError` only sets `videoMissing=true`, no navigation).

**Options (mutually exclusive, pick one per batch):**
- **A (preferred): Lower encode bitrate for the player-facing output.** The 40Mbps target (`-b:v 40M` in `encoder.py`) is mastering quality — far above what WebView2 needs for in-app preview. Drop to `-b:v 20M` (still visually excellent at 4K) and re-evaluate. This fixes the player without adding pipeline steps.
- **B: Dual-output render.** Keep the 40Mbps master for export, write a 8-12Mbps 1080p "preview" alongside it for the in-app player. More pipeline work, better user story (fast in-app preview + archival master). Scoped to pipeline + Render.tsx.
- **C: Bypass in-app player entirely for large files.** Auto-open in Explorer/system player when the file exceeds a size or bitrate threshold. Simplest but degrades the done-state UX.

**Scope:** `pipeline/encoder.py` (Option A) or `pipeline/render.py` + `src/pages/Render.tsx` (Option B). No Rust changes needed.

---

## Backlog — Temp folder accumulation cleanup (HOUSEKEEPING)

> **Requested 2026-06-12 (founder). Future sub-batch TBD.**

`%TEMP%\rushcut\` accumulates per-job working directories (`<job_id>/` with segment `.mp4` files, concat manifests, audio intermediates) indefinitely. With U4c moving U1g artifacts to NTFS, these are now persistent across WSL restarts — which is correct for durability, but also means every render leaves ~300-500 MB of segment files on disk forever.

**Policy (founder-defined):**
- Delete a job's working dir when the project is deleted from the Library.
- Prune any remaining dirs older than 7 days (safety net for orphans).

**Scope:**
- `src-tauri/src/lib.rs` `delete_project_cmd` (or a new `cleanup_project_artifacts_cmd`) — on project delete, enumerate `%TEMP%\rushcut\<job_id>\` dirs for all jobs belonging to the project, delete them via `std::fs::remove_dir_all`. Rust already has the job→project association in the `jobs` table.
- `pipeline/run.py` or a new standalone `cleanup.py` — 7-day prune of `%TEMP%\rushcut\` dirs whose name is a UUID and whose mtime is >7 days. Can run fire-and-forget from Rust on app startup or post-render, mirroring the `vacuum_proxies_cmd` pattern.
- Scope does NOT include the zoom-cache dir (it has its own 2-day `_prune_zoom_cache` logic) or `pipeline-*.log` files (small, useful for debugging).

---

## Backlog — Unexpected clips appear at front of film (BUG)

> **Bug — reported 2026-06-11 (founder, during U4 verification).**

After a session involving drag-to-reorder (U2), the user observed 2 extra clips appearing at the front of the film in the StickyFilmStrip. The clips were not intentionally added. Most likely cause: `sort_order` values assigned during `reorder_clips_cmd` left some pre-existing clips with a very low (0 or near-0) sort_order, causing them to sort before intended clips. Alternative: a clip inadvertently got `include=1` set.

**Scope:** `src-tauri/src/lib.rs` `reorder_clips_cmd` + DB sort_order assignment logic. Diagnostic first: run `invoke("get_project", {projectId})` and inspect all `sort_order` + `include` values to identify the out-of-place clips.

---

## Backlog — MediaPantry shows fewer source files than Library count (BUG)

> **Bug — reported 2026-06-11 (founder, during U4 verification). Source files confirmed on disk; clips from all sources are accessible and editable in the film.**

Library shows "3 files" for a project but MediaPantry (Trimmer, ALL CLIPS section) shows only 1 source file group. Files are confirmed on disk; clips from the missing sources are actively in the film and editable. Likely causes to investigate: (a) pantry only shows sources with `include=0` clips — files whose cuts are all already in the film disappear from the pantry (by-design-but-wrong UX), (b) grouping bug where clips are grouped by something other than `local_path` causing collisions, (c) distinct-path deduplication bug in the component's source-group builder.

**Scope:** `src/components/MediaPantry.tsx` — read how it builds the source group list and what filter/grouping it applies. The ALL CLIPS section should show all source files regardless of their clips' `include` status.

---

## Backlog — Render progress bar doesn't use full scale when stages are skipped (UX)

> **Observed 2026-06-13 (founder, zoom-test render with no music or cards).**

When a render has no music and no cards, the pipeline skips those stages entirely. The progress bar, which maps PROGRESS: stdout values (0-100) from the pipeline, still hits its max at the same point as a full render — but the "full render" reference includes music + cards. Without those stages the bar jumps from ~60% directly to done, wasting the upper 40% of the scale.

**Fix:** The pipeline should weight `PROGRESS` values against the number of active stages, not total possible stages. Alternatively, `run.py` could remap the per-stage progress contributions at job start based on which stages are actually active (music=None → skip its progress band; cards=off → skip its band). This keeps the bar stretching smoothly from 0→100% regardless of the active stage count.

**Scope:** `pipeline/run.py` or the per-stage progress emission in `render.py` — remap progress percentages to fill the full 0–100 range based on which stages are active. No UI change needed; `Render.tsx` already renders a linear 0–100% bar.

---

## Backlog — Background GPU workload (proxy/zoom-warm) can cause display driver reset during video playback (BUG)

> **Observed 2026-06-13 (founder, zoom-test project, proxy + zoom-warm running in background).**

User reported machine freeze while playing clips in the Arrange zoom tab, followed by Windows nightlight/dark mode setting being reset (symptom of a GPU driver timeout or display driver restart). Both proxy AMF encoding and zoom-warm run BELOW_NORMAL priority in WSL, but they still consume GPU/CPU. If the WebView2 renderer is also decoding video simultaneously, the combined load can cause a GPU driver timeout — Windows resets the driver to recover, which appears to the user as a brief freeze and display settings being wiped.

**Immediate mitigation:** The Rust proxy batch already caps to 2 concurrent AMF workers. The zoom-warm runs serially (no ThreadPoolExecutor). No immediate code fix needed — the BELOW_NORMAL priority guard should limit impact. If this recurs consistently, investigate whether AMF can be further throttled or whether warm jobs should pause while a WebView2 video is actively playing.

**Scope:** Monitor for recurrence. If reproducible: check `proxy-bg.log` + `zoom-bg.log` timestamps vs the freeze moment. If AMF is the cause, add a concurrency gate that pauses background AMF when `proxy_status='encoding'` for more than N simultaneous clips.

---

## Backlog — Reorder clips in Trim screen via drag left/right on film timeline

> **PRD item — reported 2026-05-19.**

Once clips are added to the film (Film tab of Trim screen, StickyFilmStrip), there is no way to reorder them. Drag-left currently deletes rather than repositions. Users should be able to click-and-hold a clip tile in the film timeline and drag it left or right to change its position in the film order.

**Design:** Use the existing HTML5 DnD or pointer-event drag model already in StickyFilmStrip. On drag-start, lift the tile visually (slight opacity + scale); on drag-over another tile, show an insertion indicator; on drop, call `reorder_clips_cmd` with the new sort order. Drag-to-delete (drag left off the strip edge) should be preserved as a secondary gesture — differentiate by whether the drop target lands on another clip tile (reorder) vs. off the strip entirely (delete).

**Scope:** `src/components/StickyFilmStrip.tsx` (drag reorder logic), `src-tauri/src/lib.rs` `reorder_clips_cmd` (already exists from Batch 14e — just needs to be called). No DB schema changes.

---

## Backlog — Shuffle: allow excluding specific transition types from pool

> **PRD item — reported 2026-05-19.**

When Shuffle mode is active, all 8 non-None transitions are eligible. Users should be able to exclude specific transitions they dislike (e.g. "I never want Barn Door"). UI: checkboxes or toggles per transition type, shown only when Shuffle is selected. Excluded types removed from `_SHUFFLE_POOL` for that render.

**Scope:** `src/pages/Arrange.tsx` Transitions tab (conditional exclusion UI under Shuffle card); `src/utils/buildJobConfig.ts` (serialize excluded list); `pipeline/transitions.py` `_SHUFFLE_POOL` filtered at render time. Deferred — nice-to-have, not blocking launch.

---

## Batch I — Branding & Visual Identity

> **Status: DEFERRED — pending founder decision on logo option (A/B/C). Not blocking launch.**
> **Scope: logo, app icon, and colour accent refinements. No layout changes (those are Batch H).**

### Motivation

The bottom-right corner of the new shell (from Batch H) reserves space for a RushCut wordmark/logo. The Tauri window and taskbar icon are currently the default Tauri placeholder. Batch I ships the brand identity across all surfaces.

### Changes required

**1. RushCut wordmark / logotype**
- Design a wordmark for RushCut. Options to evaluate (founder decides before implementation):
  - **A — Wordmark only:** "RushCut" in a bold condensed font, peach `#FF8A65`.
  - **B — Icon + wordmark:** A simple icon (e.g. film-cut scissors motif) left of "RushCut" text.
  - **C — Monogram:** "RC" lettermark in a rounded rectangle, peach on dark.
- Deliverable: SVG file at `src/assets/logo.svg` (inline-importable in React).
- Placement: bottom-right of the bottom tab bar (from Batch H). Width ~80px, height auto.

**2. App window icon (Tauri)**
- Replace the Tauri placeholder icon set in `src-tauri/icons/` with the RushCut logo.
- Required sizes: `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico` (Windows taskbar), `icon.icns` (macOS, if applicable).
- Tool: generate from the final SVG using `tauri icon` CLI (`pnpm tauri icon src/assets/logo.svg`).

**3. Taskbar / window title**
- `tauri.conf.json` `windows[0].title` is currently `"RushCut"` — keep as-is.
- Confirm the window title bar shows "RushCut" correctly after icon update.

**4. Colour accent review (optional, founder-guided)**
- The current palette is functional but the founder may want to adjust any of: peach `#FF8A65`, blue `#99B3FF`, sand `#C9A96E`, or the dark `#0a0a0a` background.
- Any changes must update `docs/DESIGN.md` canonical table first, then find-replace all hardcoded hex values in `src/`.
- **Do not change colours without explicit founder sign-off on the new hex values.** The design system is the source of truth.

**5. Loading splash (optional)**
- The native Win32 splash (Batch A4) currently shows a plain dark rectangle.
- Could show the RushCut logo centred. Low priority — visible for only ~200ms.

### Acceptance checks
- [ ] RushCut wordmark/logo visible in bottom-right of bottom tab bar (all screens)
- [ ] Windows taskbar icon shows RushCut branding (not Tauri placeholder)
- [ ] Alt-Tab shows RushCut branded icon
- [ ] No console errors introduced by SVG import
- [ ] DESIGN.md updated with final logo usage rules (placement, min size, clear space)

### Notes / risks
- SVG must be kept simple (flat fills, no filters) for correct rendering as a Windows `.ico` file.
- `pnpm tauri icon` requires the final SVG at build time — Batch I must ship before the next `pnpm build` release cut.
- Colour changes (point 4) are high-risk — every Tailwind arbitrary value in `src/` uses hardcoded hex. A find-replace across all files is required. Only do this with founder approval and a full E2E run after.

---

## ~~Backlog — TrimBar: Highlight Already-Included Regions~~ DONE (2026-05-14)

> **Shipped.** `alreadyCutRegions` prop on `TrimBar`; `#99B3FF` bracket gradient (26% fill, 52% edges) at z-2; self-exclusion + malformed row + micro-cut guards. DESIGN.md extended. 9/9 fast E2E PASS.

**Data available:** `clips.filter(c => c.include === 1 && c.local_path === selectedClip.local_path)` gives all film cuts from the same source. Each has `in_ms` / `out_ms`. Compute pixel positions the same way as the active trim handles.

**Scope:** TrimBar.tsx only. No DB or pipeline changes.

---

## Backlog — Film Seek: Cross-Clip Stutter Fix

> **Open bug — 3 fix attempts, partially improved. See `.claude/notes/film-seek-stutter.md` for full diagnosis.**

Clicking the film timeline to seek to a position in a **different** clip from the one currently playing causes a brief flash of frame 0 before landing on the correct position. Same-clip seeks and clip-advance transitions work correctly.

**Root cause (confirmed):** WebView2 GPU compositor lag. `seeked` fires in the JS renderer process before the decoded frame is committed to the compositor. `requestVideoFrameCallback` (rVFC) fires when the compositor presents a frame — but after a `src` change + `load()` + `seek`, the first frame rVFC fires for appears to be frame 0, not the seeked position.

**Fixes shipped so far:**
- Option B: imperative `ref.style.opacity` writes (bypasses React async batching) — partial improvement
- Generation counter on `slotGenRef` (invalidates stale rVFC callbacks from overlapping seeks) — defensive fix
- `didDragRef` reset fix in StickyFilmStrip (separate bug — click-to-seek was blocked after panning — **fixed**)

**Recommended next fix (Option F in notes):** play→pause repaint before reveal. After `seeked` fires, call `v.muted=true; v.play().then(() => { v.pause(); v.muted=false; setSlotVisible(slot); v.play(); })`. Temporarily mutes to suppress the audio blip. This is the same proven repaint pattern the clip-mode video already uses successfully.

---

## ~~Backlog — Timeline HUD: Auto-Fit Scale When Clip Added~~ ✅ SHIPPED 2026-05-14

`StickyFilmStrip.tsx` — auto-fit on clip add (fit-to-width + scroll-to-0); manual zoom breaks auto-fit mode; "fit view" pill button restores it. Stale `totalMs` closure bug also fixed (added to dep array).

---

## Backlog — Timeline HUD: Zoom/Pan Discoverability Tooltips

> **Future — UX polish pass. Not blocking any current batch.**

The proportional timeline supports Ctrl+scroll zoom and middle/left-drag pan. These interactions are invisible without a hint — users will not discover them by accident.

Options to evaluate:
- Static hint text below the HUD: `"Ctrl+scroll to zoom · drag to pan"` in `text-[11px] text-[#e5e5e5]/30` — always visible, zero friction.
- Tooltip on first load (once per session, dismissed after 3s) — more prominent but adds state.
- Keyboard shortcut overlay (press `?` to reveal all shortcuts) — standard power-user pattern.

Defer until timeline interactions are finalised (zoom sensitivity, reset shortcut, etc.).

---

## Backlog — Smart Music Track Ending (crossfade-out optimisation)

> **Future — audio polish batch or AI tier.**

**Problem:** The pipeline currently fades out wherever the film ends, regardless of what's happening in the track at that point. A track ending mid-phrase, on a high note, or during a crescendo sounds abrupt even with a fade. The ideal end point is a moment of low energy / near-silence / phrase resolution — a "natural stop" in the track.

**Near-term option (manual):** Add a "Music fade-out" setting on the Sound screen (duration: None / Short 2s / Long 5s). Gives user control but doesn't solve the "wrong moment" problem.

**Longer-term option (AI / automated):** Analyse the track to find optimal end points — moments where loudness is below a threshold, spectral flux is low, and/or a beat boundary occurs. Use `librosa` RMS energy + `beat_track` to score candidate end points within the last N seconds of the film duration. Pick the lowest-energy boundary. This is the same class of problem as the waveform-matching loop point below.

Qualifies under AI policy (demonstrably audible improvement). Prioritise once the loop-point fix ships — the two features share the same librosa infrastructure.

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

## Post-Launch Backlog (nice-to-haves, prioritised by founder)

| Item | Notes |
|---|---|
| U1g extension — segmented path for open/close-to-black renders | `_render_segmented()` currently falls back to the monolithic path when `has_open` or `has_close` is True (title cards at start/end). The monolithic path for a 20+ clip 4K xfade render with cards is an exit-15 candidate under 12 GB WSL. Fix: extend `_render_segmented()` to handle intro/outro cards — fold `silent_0.mp4` into batch 1 and `silent_N.mp4` into the last batch (they are already silent so the xfade from/to them is a dip-to-black, not a cross-clip transition). The audio pass already handles them correctly (index 0 and N). Boundary cuts between clips 0-1 and (N-1)-N must be placed in the solo region of those edges. Acceptance: 21-clip 4K Stagecoach render with cards enabled — no exit 15, drift=0, cards visible at start and end. |
| Long-clip proxy gate UX (>2min source clips) | **Root cause confirmed (2026-05-25):** 4K HEVC software decode is ~1x realtime — a 5-min source clip takes ~300s to proxy regardless of encoder (GPU handles the H.264 encode; the HEVC decode is the bottleneck). Sessions with clips longer than ~2min will exceed the 120s gate target. Three mitigation options: (1) **Partial-ready gate** — advance from `awaiting-proxies` once all short clips are done + add a "Still encoding 1 clip..." sub-label so user knows. Renders while the last long clip finishes in the background. (2) **Proxy-while-render** — if a long clip's proxy isn't ready by render start, normalise it in parallel with the render encode step rather than waiting. (3) **Segment proxy** — proxy only the trimmed segment (the user's `[in_ms, out_ms]` window) rather than the full source file. For a 5-min clip with a 30s trim, this cuts proxy time from ~300s to ~30s. Option 3 is the cleanest fix but requires storing per-clip trimmed proxy paths. Prioritise if users report long waits after launch. |
| Music API / digital library | Loudly or Soundraw API; replaces bundled tracks |
| Transition library | More xfade types; per-clip transition picker |
| Transition CSS animation polish | Card-chip and centre preview animations are functional approximations; barn door (`scaleY`) and band wipe (two-step clip-path) don't match the FFmpeg xfade visual exactly. Revisit with more accurate CSS or canvas-based demos. |
| Zoom transition — proper pipeline implementation | FFmpeg `zoomin` xfade zooms aggressively into a narrow pixel band — unusable. Currently falls back to `fade` (crossfade) in renders; CSS preview still shows zoom animation. Proper fix: implement a gentle zoom via a `zoompan` filter chain (scale up + crop + fade overlay) rather than FFmpeg xfade. Until fixed, Zoom renders identically to Crossfade. |
| Transition card-chip mini-preview redesign | Replace the clip-thumbnail-backed mini-cards with a simple geometric 2-colour visualisation (coloured rectangles) that shows the transition mechanic at a glance — no real clip images needed. The centre panel handles real-thumbnail preview; mini-cards just need to communicate the shape of the cut. |
| Quick Preview render | In Batch J (Sound screen, pre-export preview). Post-launch: secondary "Quick Preview" button on Render screen as well. |
| Improved music loop | Waveform-matching loop point (librosa); see existing backlog item |
| Smart music track ending | Spectral-optimal fade-out point (librosa); see existing backlog item |
| Timeline zoom/pan tooltips | Ctrl+scroll / drag pan discoverability hint |
| Badge tooltips | Hover tooltips on all clip badges: Z badge → "Zoom applied"; purple dot → "Volume override"; blue number badge → "Clip N of M"; duration label → "Trimmed duration". Apply consistently across StickyFilmStrip tiles and the Arrange clip rail. Native HTML `title` attr is sufficient — no custom tooltip component needed. |
| Filmstrip clip delete — drag to bin | Current drag-left swipe to delete feels accidental and undiscoverable. Replace with an explicit bin zone: a trash icon area visible at the far left (or right) of the filmstrip that clips must be dragged onto to delete. Drag-left swipe should be removed entirely. |
| Filmstrip tile swipe fires on middle mouse button | `handleTileMouseDown` in `StickyFilmStrip.tsx` does not check `e.button` — middle-click (button 1, used for pan) starts a swipe gesture on the tile, fighting the pan handler. Fix: guard with `if (e.button !== 0) return;` at the top of `handleTileMouseDown`. |
| Multiple instances allowed — should be single-instance | Nothing prevents the user launching `rushcut.exe` a second time. Both instances share the same DB (`rushcut.db`) and write to the same proxy/output dirs — a concurrent render from two instances can corrupt job state. Fix: on startup, check for an existing mutex/lock (Win32 `CreateMutexW` with a named mutex, e.g. `"Global\\RushCutSingleInstance"`) and if already held, bring the existing window to the foreground (`AllowSetForegroundWindow` + a named pipe or event to signal the first instance) and exit. Rust side only — no UI change needed. |
| Sporadic video reset mid-session (Trimmer + Arrange) | Affects both screens. **Trimmer:** while playing mid-clip, video briefly goes blank + spinner, then resumes from `in_ms` (trim start) — clip selection preserved. **Arrange zoom tab:** blank + spinner, then `selectedClipId` resets to null — user must re-pick a clip. The Trimmer symptom (seek to `in_ms`) points to `handleLoadedMetadata` firing spuriously, meaning `video.load()` was called mid-playback. The Arrange symptom (clip deselected) suggests either a component remount (React key change, route re-render) or `selectedClipId` state being wiped — possibly the same `clips` state refresh that triggers the Trimmer reload also causes Arrange to remount or lose selection. Likely common root cause: a background Tauri event (`proxy-progress`, `thumbnail-progress`, or `waveform-progress`) arriving late and updating `clips` state, which cascades into a video-load `useEffect` re-run. The `loadedSrcRef` same-src guard may be bypassed because `convertFileSrc()` reconstructs a new string reference each render. Investigate: add `console.log('[video] load triggered')` before `video.load()` in both screens; also log when `selectedClipId` becomes null in Arrange to distinguish remount from state wipe. |
| Sound screen UX polish | "No Music" differentiation, Custom Track affordance |
| Add/remove clips from Trimmer without returning to Upload | Once past the Upload screen there is no way to add new clips to the media pantry or remove unwanted ones. Add an "Add clips" button (folder + files picker, same as Upload) in the Trimmer's Media Pantry header; invoking it appends the new clips to the project via `scan_folder`/`scan_files` + `create_project` or a new `add_clips_to_project` Rust command. Also allow removing a clip from the pantry entirely (not just from the film) — long-press or right-click context menu on a pantry tile with a "Remove from project" option that calls `delete_clip_cmd`. |
| More card optionality | Font choice, card duration control, animated cards |
| GPU-accelerated rendering | DaVinci Resolve, Premiere et al. auto-detect available GPU encoder at launch (NVENC → AMF → QSV → libx264 CPU fallback). RushCut should do the same for the final render step and the zoom encode step. Spike: detect available hardware encoder via `ffmpeg -encoders` at app start, store result, inject correct `-c:v` flag at render time. Three code paths to validate (quality + speed). Expected gain: 5–10x faster encode on GPU-equipped machines (~214s render step → ~25–40s with NVENC). Swap: `-c:v libx264 -preset fast -crf 22` → `-c:v h264_nvenc -preset p4 -cq 22` with graceful x264 fallback. Deferred: multi-platform quality validation + 3 encoder paths. Revisit when render speed is a top post-launch complaint. |
| Render screen multi-version pantry | **Deferred from Batch T5.** T5 shows only the *latest* completed render on the Render screen. Each render is a separate `jobs` row with its own `<slug>-NN.mp4` output, so a project can accumulate multiple versions (`clips-01.mp4`, `clips-02.mp4`, ...). Add a left "render pantry" rail (mirroring the Trimmer `MediaPantry` pattern + `EditorShell` left-panel slot) listing every kept version newest-first with filename + absolute timestamp + resolution; click one to play it in the main area. Mark versions whose file was deleted from disk as greyed/struck (a Rust `render_files_exist` check, or extend `get_render_status_cmd` to list all done jobs with an `exists` flag). Needs a new DESIGN.md "render version pantry" pattern. Prioritise if users ask to compare/keep multiple cuts. |

## Vision Notes — Future Directions (inspiration, not scheduled)

> Not a roadmap. Ideas worth keeping in mind when looking for what to build next.

### Codebase score: 6/10 (as of 2026-05-21)

Well-built for its scope. Proxy system, pipeline architecture, E2E test suite, two-instance safety, atomic writes, timing logs — these are senior engineer decisions. But the feature surface is narrow.

### What would move the needle to 8+

For the target niche (serious recreational, handheld footage, social output) — not DaVinci, but genuinely better than CapCut for this use case:

**Product gaps (user-facing)**

- **Multi-track / B-roll** — single clip-per-slot model. Real directorial editing means cutting away to a second angle or overlay. The biggest structural gap.
- **Cut-to-music** — beat detection + auto-sync is the #1 feature serious social editors want. Nothing else signals "this is for creators" more clearly.
- **Text / titles** — even basic lower thirds. Without this, can't compete with CapCut for socials.
- **Export presets** — Instagram Reels, TikTok, YouTube Shorts ratios and specs as one-click targets.

**Technical gaps (pipeline)**

- GPU encode — Batch Q DONE. `h264_amf` opt-in via "Fast render" toggle (4K only). Batch Q2 DONE: native fps detection eliminates 25fps hardcode; DJI 29.97fps proxies + normalise now encode at source fps; proxy reuse gate checks both height and fps.
- No scrubbing / preview without full render — biggest UX gap vs pro tools.
- No undo history beyond arrangement changes.

### Score ceiling

Fill the four product gaps above → 8/10 for this niche. Genuinely better than CapCut for serious recreational users, and differentiated enough to matter.

---

## AI Enablement (large, pre-GTM)

> **Biggest remaining piece of work. Target: before go-to-market.**

**Goal:** A user who doesn't bother with settings gets a good result immediately. Most decisions pre-configured, including auto-trimmed sections pulled from DJI metadata (Osmo Pocket 3 marks highlights in the DJI app).

- **DJI in-app highlights**: Parse `_DJI_...` XMP/EXIF metadata written by the DJI app to identify user-flagged moments → auto-populate `in_ms`/`out_ms` for those clips. User sees pre-trimmed clips in the Trimmer, can adjust or accept.
- **Smart defaults per clip count**: Short session (1–10 clips) → include all, moderate zoom, crossfade. Long session (60+ clips) → AI-score and pre-select best N clips, apply gentle zoom, trim silence.
- **One-tap render**: After scan, show a "Render now" CTA alongside "Customise" — renders with smart defaults without any editing required.
- Qualifies under AI policy (user-visible, demonstrable, clearly labelled as AI).

## Phase 3 Preview (not in scope now)

- Google Video Intelligence frame-level scoring — replaces FFmpeg motion heuristic
- Face/subject-aware zoom — GVI + Vision API
- Stabilisation via ffmpeg-vidstab
- 50 clips / 20GB cap for Creator
- Auth + Stripe (Creator £4.99/mo) + Pro tier (4K, AI Director, advanced transitions)

---

## Changelog

| Version | Date       | Changes                                                                                                                                                                                                                                                                             |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.5     | 2026-06-13 | Batch U4g DONE: Cancel in-progress render + V3 done-state redesign + open-in-player. `pipeline/run.py`: `os.setpgrp()` + write Linux PID to `%TEMP%\rushcut\<job_id>.pid` (process-group leader pattern). `src-tauri/src/lib.rs`: `cancel_render_cmd` (PID-file read → `wsl kill -15 -<pgid>`, pkill fallback, `update_job_error`/`emit_error`, best-effort NTFS + WSL /tmp cleanup); `open_in_player_cmd` (`cmd /c start "" path` via separate OS args — path-with-spaces safe). `src/pages/Render.tsx`: cancel button (rendering phase, outlined white/30); V3 done-state split card (`1fr 1px 220px` grid, green pill, 2x2 stats grid, Saved-to dir row, right-column actions); `open_in_player_cmd` for both 4K + 1080p "Open film"; 1080p preview panel below main card; 4K: no in-app `<video>` (entirely absent from JSX — avoids spurious onError); error block cancel-specific copy ("No changes were made..."); `pathDirname()` + `shortDateTime()` helpers. `src/utils/buildJobConfig.ts`: always emit `output_resolution` (default "1080p" when no pref stored). `src/utils/jobMeta.ts`: `resLabel()` checks analysis `output_resolution` before `has_4k` (source clips != output resolution). `e2e/render.spec.ts`: "Render another version" assertion updated. 9/9 fast + 14/14 render E2E PASS. |
| 5.4     | 2026-06-13 | Batch U4d + U4f DONE: Proactive zoom warm on project entry + stage-aware stall threshold. `Trimmer.tsx`: `warmFiredRef` session guard; `get_project.then()` fires `warm_zoom_cache_cmd` once on entry when any included clip has `zoom_mode != null` (covers re-render without visiting Zoom tab). `Render.tsx`: backstop warm fire-and-forget at top of `submitJob` (covers direct done-project opens skipping Trimmer); `inFilmCountRef` synced from state (`useEffect([inFilmCount])`) as stale-closure guard for once-registered `pipeline-stage` listener; `maxStallMsRef` (default 360s) extended to `min(600s, max(360s, count*60s))` on `STAGE:zoom`; resets to 360s in effect cleanup + `startRenderNow`. Bundled routing fix: `Upload.tsx` "Resume a Project" cards hardcoded to `/trimmer/:id` for all projects; replaced with `renderStateFromStatus(p.last_job_status)` — done projects now route to `/render/:id` (same Library Smart Open logic; `renderStateFromStatus` imported from `@/utils/jobMeta`). No Rust/pipeline changes. Verified: 4 warm fires in `zoom-bg.log` (all 10/10 cache hits); 9/9 fast E2E PASS. Backlog: progress bar scale when no music/cards stages (jump from 60%→done). |
| 5.3     | 2026-06-12 | Batch U4c DONE: U1g segmented render `/tmp` volatility fix. `_resolve_render_work_dir(job_id)` helper added to `render.py` (mirrors zoom-cache NTFS resolution: env override → USERPROFILE → /tmp fallback). `_render_segmented()` allocates `seg_tmp` at function entry; four artifact paths (`u1g_seg_{bi}.mp4`, `u1g_concat.txt`, `u1g_video_full.mp4`, `u1g_audio_full.m4a`) repointed from `/tmp` tmpfs to NTFS `/mnt/c/.../Temp/rushcut/<job_id>/`. `TMP_BASE` / line 357 untouched (pre-trim/normalise stay on tmpfs for RAM speed). Verified: `[U1g] segment work dir: /mnt/c/...` in pipeline log for 21-clip 4K Stagecoach job; 7 batches; `drift=0 frame(s) (0.0ms)`; no fallback. Side findings: cold-zoom (skip-tab) caused false stall alert (429s > 360s threshold) + WebView2 crash playing 795MB 4K output — both filed as PRD backlog. New subbatch plan: `docs/batch-plan-u4d-subbatches.md` (U4d proactive warm → U4e AMF+15M → U4f stall threshold → U4g cancel → U4h cleanup). |
| 5.2     | 2026-06-12 | Batch U4b DONE: Zoom preview auto-plays on clip switch. Root cause: zoom-sync effect read stale `isPlayingRef.current` (the `[isPlaying]` sync effect runs on the NEXT render, so on a clip-switch tick the ref still holds the old `true`). Fix: `prevZoomClipIdRef` in `Arrange.tsx` — clip-switch branch calls `syncZoomToPlayhead(0, false)` unconditionally (always land paused at t=0); same-clip param-edit branch reads `isPlayingRef` as before (no regression). `null` → first clipId counts as a switch (intentional — first load is paused). `src/pages/Arrange.tsx` only. 9/9 fast PASS. |
| 5.1     | 2026-06-11 | Batch U4 DONE: Background zoom pre-cache. `pipeline/warm_zoom.py` — CLI warmer, serial (no ThreadPoolExecutor), warms BOTH `WARM_RESOLUTIONS=["1080p","4k"]`, proxy-substitute path skips HEVC decode, atomic `tmp->os.replace`, absolute imports throughout (direct-script invocation requires no relative imports). `warm_zoom_cache_cmd` Rust command — `{project_id}:zoom` concurrency guard, BELOW_NORMAL WSL spawn, `zoom-bg.log`. `pipeline/render.py` refactor: `pretrim_one_clip()` + `decide_clip_source()` extracted as module-level helpers (reused by warmer; parity-verified). `Arrange.tsx` three-tier trigger: (a) immediate on zoom-tab leave (cancels debounce), (b) 500ms debounced after zoom/focal param edit, (c) unmount backstop with debounce cleanup. `Render.tsx` stall threshold 120s->360s (cold zoom silent up to 8 min). Verified: `zoom_cache_hits=4/4 t_zoom=0` both 1080p + 4K (was 26-108s cold). 9/9 fast + 5/5 editor PASS. |
| 5.0     | 2026-06-10 | Batch U3d DONE: Choppy zoom preview fix (WAAPI). `rc-kenburns` CSS @keyframes (read var(), blocked compositor) replaced with WAAPI (`kbAnimRef`). Root cause confirmed via direct CDP trace: residual judder is 30fps source content, not jank. Two follow-on bug fixes: WAAPI play() resets finished anim to 0 (guard `elapsedMs < durMs`); Fixed->Gradual flash (write `transition:"none"` before `transform` in JSX). 9/9 fast + 5/5 editor PASS. |
| 4.9     | 2026-06-09 | Batch U3b + U3e DONE: Zoom playback UX + destination crop box. U3b: `syncZoomToPlayhead(elapsedSec, playing)` replaces `restartZoomAnim` — negative CSS animation-delay for clock positioning; gesture split click=play / drag=focal (4px threshold); Sound tab click-to-play. U3e: projected destination crop box using `approxKenBurnsProgress(t_raw)` smoothstep. U3a (prior): transformOrigin wipe fix, kbPreviewDurationSec helper, SAR mismatch fix in transitions.py. U3c: Ken Burns focal drift fixed in zoom.py. 9/9 fast + 5/5 editor PASS. |
| 4.8     | 2026-06-07 | Batch U2 DONE: Drag-to-reorder on StickyFilmStrip. `StickyFilmStrip.tsx` rewritten with dnd-kit (`DndContext` + `SortableContext` + `SortableFilmTile`, `PointerSensor { distance: 5 }`, `CSS.Translate.toString` for variable-width tiles). Swipe-delete replaced with hover-reveal bin icon. `onReorder` prop wired in Trimmer + Arrange: merge reordered film IDs back into full clip list (pantry sort_order safe), optimistic update + rollback. Bundled bugfix: `handleReorder` in `Trimmer.tsx` corrects `filmPlayIdx` by ID after reorder (integer index stayed fixed, causing playhead to show wrong clip after drag). Pre-existing E2E fixes: `arrange.spec.ts` + `sound.spec.ts` rc_* keys migrated from sessionStorage to localStorage (U1b debt). 9/9 fast PASS, 26/26 arrange PASS. |
| 4.7     | 2026-06-07 | Batch U1g DONE (verified): Segmented xfade render (memory-bounded). Already shipped in U1b commit. `_render_segmented()` in `render.py` activates for >4-clip xfade renders without open/close-to-black transitions. Overlap-by-one batching (BATCH_SIZE=4): shared clip at boundary appears in both adjacent batches; boundary cut placed inside the solo region. Frame-count telescoping (`round(g_end*fps) - round(g_start*fps)`) prevents drift. Single audio acrossfade pass over all clips. `-c copy` concat + mux. In-filter trim (not `-c copy` segment trim). Verified: 21-clip 4K Stagecoach project — exit code 0, `drift=0 frame(s) (0.0ms)`, 7 batches, music + cards correct, peak WSL ~9.7 GB (12 GB safe). Gap: `has_open`/`has_close` still monolithic. 9/9 fast PASS, 14/14 render PASS. |
| 4.6     | 2026-06-07 | Batch U1e DONE: Stalled render detection. `Render.tsx` `lastProgressAtRef` seeded from `active_job.updated_at` inside load useEffect (not `Date.now()` — prevents fresh remount masking pre-existing stall). 30s interval checks 120s inactivity threshold; both `pipeline-progress` AND `pipeline-stage` reset the ref. Warning panel: `border-l-2 border-l-[#FF8A65]`, "Try Again" -> `startNewVersion()`. Verified via SIGSTOP/SIGCONT + remount test (2.48s re-appearance, 54s stale job). DESIGN.md + LEARNINGS.md extended. 9/9 fast + 14/14 render PASS. |
| 4.5     | 2026-06-07 | Batch U1d DONE: New render visibility + nav-guard. Persist-intent via `rc_render_pending_<pid>` in localStorage; mount-effect resumes `submitJob()` when flag set + no active job; double-submit guard clears flag BEFORE `await start_job`. `get_latest_render` already ordered `DESC` — newest done render always shown. `window.confirm` replaced with async `confirm()` from `@tauri-apps/plugin-dialog` + `dialog:allow-confirm` capability + binary rebuild. 9/9 fast + 14/14 render PASS. |
| 4.4     | 2026-06-02 | Batch T7 DONE: WDIO proxy claim cleanup. `proxy_claimed_at INTEGER` additive column on `clips` (epoch seconds, stamped by `claim_clip_for_encoding`). `reset_all_encoding_claims(stale_secs)` time-guarded all-project reset — called at binary startup (`setup()`, 900s threshold) to self-heal stuck rows from prior crashes/kills. `reset_proxy_encoding_cmd(project_id)` scoped Tauri command used by E2E `after()` hook. `e2e/helpers/testProjects.ts` registry; `trackTestProject(id)` added to all 7 specs (one-line + import only); `wdio.conf.ts` `after()` hook resets tracked projects via `__TAURI_INTERNALS__.invoke` before `afterSession` SIGTERMs the binary. Verification: startup reset confirmed (1 stale row cleared, 1 fresh row preserved by time-guard); 0 stuck encoding rows after full WDIO fast run; 9/9 fast PASS. Check 4 (live claim path) verified indirectly — WDIO run itself exercised claim→encode→done with new column present, 0 stuck rows result. |
| 4.3     | 2026-06-02 | Batch T6 DONE: Library jobsMap staleness fix + preparing-phase UX. Rust `start_job` emits `job-started` (`{ jobId, projectId }`) after `insert_job`; `Library.tsx` mount-once listener fetches new job via `get_job_cmd` and inserts into state — live green bar works even when Library was already mounted before the render fired (verified via screenshots). Preparing-phase UX: spinner now shows `Optimising clips... X/Y ready` + peach progress bar + elapsed timer when `preparing && proxyTotal > 0` — `proxyElapsedLabel` wired in the `preparing` effect (was dead code). `render.spec.ts` stale `waitUntil` fixed (`"Your film is ready"` → `"Your film"`). New `e2e/library.spec.ts` (4 assertions: heading, card, idle status, routing); `test:e2e:library` script. `launch-cdp.bat` helper. 9/9 fast PASS, 4/4 library PASS. |
| 4.2     | 2026-06-02 | Batch T5 DONE: Render screen done-state fixes. `get_render_status_cmd` Rust command (`get_active_job` + `get_latest_render` DB helpers). Render screen self-detects existing renders on every mount — no auto re-render; "Render new version" is the explicit action. Filename from real path basename. Duration from `<video>` element. Absolute timestamp. "My Projects" + "Render again" removed; "Open in Explorer" + "Render new version" remain. 404 fallback: player hidden, metadata preserved. `setPhase("starting")` immediately in `submitJob` (stuck-button fix). Library `handleOpen` simplified (T4 resume state dropped). `absoluteDateTime()` in `src/utils/timeAgo.ts`. `render.spec.ts`: `btn-render-new` assertion, library-badge test replaced, heading copy updated. `e2e.md`: `browser.navigate()` does-not-exist rule. PRD: multi-version pantry added to backlog. 9/9 fast PASS. |
| 4.1     | 2026-06-02 | Batch T4 DONE: Library live render progress + smart Open routing. `get_job_cmd` prefetch per project on mount; `Record<projectId, Job>` jobs map; four-state meta row (idle/rendering/done/error) with green `#22c55e` mini bar; `pipeline-progress/done/error` live subscriptions (update from payload, no re-fetch); relative-time "Last render: Xh ago · 1080p" for done; smart Open routing (done/processing/failed → Render; idle → Trimmer). `timeAgo()` util. 9/9 fast PASS. |
| 4.0     | 2026-05-31 | Batch T1 DONE: Library clip count fix. `list_projects()` SQL replaced `COUNT(*)` with `COUNT(DISTINCT local_path) AS file_count` + `COUNT(*) WHERE include=1 AS cut_count`. `ProjectSummary` Rust struct + TS interface updated (two fields replace one; row.get() indices shifted 3-7). `Library.tsx` + `Upload.tsx` (home recent-projects list) both updated to display "N files · M cuts". DB cross-check confirmed: clips5 project shows files=5, cuts=8, old_total=11. 9/9 fast PASS. |
| 3.9     | 2026-05-25 | Batch S4 (Earlier Proxy Trigger) DONE: `generate_proxies_cmd` adds `all_clips: Option<bool>` param. `db.rs` `get_all_clips_for_bg_proxy()` — same as `get_clips_needing_bg_proxy` but without `include=1` filter. `run_bg_proxy_batch` switches query on `all_clips` flag and logs `all_clips=true/false` in batch-start. `Upload.tsx` line 166 updated from bare `invoke("generate_proxies_cmd", { projectId })` to `invoke("generate_proxies_cmd", { projectId, lowPriority: true, allClips: true })` — starts encoding all scanned clips at Upload time giving the full session as warm-up buffer. Bug fix: `generate_proxy_file_low_priority` was using libx264 args (`-preset ultrafast -crf 23`) with AMF encoder — all low-priority encodes on AMF hardware failed silently at elapsed=0.1s. Fixed by mirroring AMF/libx264 arg branching from the normal-priority function. Confirmed: `batch-start all_clips=true encoder=h264_amf` in proxy-bg.log; clips encode correctly. 9/9 fast PASS. |
| 3.8     | 2026-05-25 | Batch S (Proxy Throughput) DONE: `detect_best_encoder()` probe fixed (128×72 → 320×240/30frames/yuv420p — AMD AMF rejected undersized input silently); `generate_proxy_file_normal_priority()` AMF args branched (`-rc cqp -qp_i 30 -qp_p 30 -quality speed` vs libx264 `-preset ultrafast -crf 23`); `encode_one_clip()` extracted as sync helper (claim → encode → status update); `run_bg_proxy_batch()` refactored to parallel worker queue (`Arc<Mutex<Vec<...>>>` + `tokio::task::spawn_blocking`); GPU: 2 workers max (AMD concurrent AMF limit); libx264: `min(4, cpu_count/4)`; batch-start log includes `encoder=`, `n_workers=`, `threads_per_clip=`, `cpu_count=`. Benchmarked: cold 8-clip (≤31s) AMF parallel — gate 121s (≈120s target), t_total=133s, proxy_used=8, t_normalise_s=2s. LEARNINGS.md: 4K HEVC decode floor (~1x realtime). 9/9 fast PASS. |
| 3.7     | 2026-05-24 | Batch S DONE (S1+S2+S3): S1 — per-clip animated pulse tiles in `awaiting-proxies` phase; green check badge on done clips; `includedClips` state set before `submitJob` to prevent empty-tile flash; `rc-proxy-pulse` CSS keyframe in globals.css. S2 — cold 4K gate bypass fix: `ready === 0 && !has4K` condition prevents bypassing gate for cold 4K renders; concurrency boost fix: `HashSet` guard only blocks when `low_priority=true`, allowing normal-priority batch to run alongside; `claim_clip_for_encoding` atomic DB claim (UPDATE WHERE proxy_status NOT IN ('encoding','done')) prevents two FFmpeg procs writing same file; `reset_stale_encoding_claims` clears orphaned 'encoding' rows on next batch start. S3 — elapsed count-up timer replaces inaccurate ETA; `Xs`/`Xm Ys` format; 1s interval from gate entry. Result: cold 4K `proxy_used=3, t_normalise_s=1s, t_total_s=17s` vs baseline `404s` (-96%). LEARNINGS.md + DESIGN.md extended. 9/9 fast PASS. |
| 3.6     | 2026-05-24 | Batch R Part C DONE: AMF fallback toast + silent-fallback detection. `amf_fallback_flag` list-closure in `render.py`; `_run_with_amf_fallback()` retries with libx264 on RuntimeError; `amf_fallback=0/1` in ANALYSIS line. `pipeline-done` Tauri event now carries `"analysis"` field (`last_analysis: Option<String>` captured per job in Rust). `Render.tsx` toast: "Fast render unavailable -- rendered at standard quality" (6s) when `amf_fallback=1`. `fastRender` toggle reverted to opt-in OFF (auto-ON for 4K removed per user feedback). Confirmed ceiling: AMF + 8/8 proxies warm = ~124s (well under 180s target). 9/9 fast PASS. |
| 3.5     | 2026-05-24 | Batch R (Part A + B) DONE: Part A — zoom cache moved to NTFS `%TEMP%\rushcut\zoom-cache\` (survives WSL restart). Part B — `get_proxy_readiness_cmd` Rust command; `run_bg_proxy_batch` boost path; Render screen `"awaiting-proxies"` phase (ETA hint, auto-advance, "Start anyway" CTA). Verified: 1080p warm `t_total=173s`, 4K warm libx264 `t_total=256s`. 9/9 fast PASS. |
| 3.4     | 2026-05-23 | Batch Q2 DONE: Native fps detection eliminates `-r 25` hardcode. `_probe_fps()` + `round_to_standard_fps()` in `render.py` probe `r_frame_rate` from first clip (e.g. `30000/1001`). `target_fps_raw` threaded to `normalise()` + `make_card()`. Proxy reuse gate extended: `_proxy_meta()` returns `(height, fps_int)`; proxies rejected on fps mismatch + reason logged. `probe_clip_fps()` in Rust wired into both `generate_proxy_file_low_priority` + `generate_proxy_file` (fallback to "25"). Legacy 25fps proxies auto-rejected on 29.97fps projects. Naming convention: `target_fps_raw` → FFmpeg only; `target_fps_int` → comparison/logs only. 9/9 fast + 15/15 render E2E PASS. |
| 3.3     | 2026-05-23 | Batch P2 DONE: Fused single-pass loudnorm into render/music encode — eliminates separate two-pass Step 7 (~17–32s saved on 4K renders). Music-off single-clip: loudnorm in `-af` chain. Music-off multi-clip: `[aloud]` label in filter_complex, `music_on` gate prevents double-apply. Music-on: fused into music.py amix tail via `apply_loudnorm=True`. `loudnorm.py` rewritten: two-pass fn + Lambda dead code deleted; `loudnorm_filter()` helper. LUFS: music-on -13.5/-14.2 PASS; single-clip -14.4 PASS; multi-clip -15.7 accepted (single-pass ±2.0 bar). A/B listen clean. LEARNINGS.md updated. |
| 3.2     | 2026-05-21 | Batch P DONE: Render performance. Zoom step parallelised (`ThreadPoolExecutor(min(4,cpu))`, per-worker `-threads N -filter_threads N`). Persistent zoom cache at `/tmp/rushcut-zoom-cache/` (sha1 key on clip identity + params + resolution, atomic `os.replace`, `is_valid_proxy` INVALID guard). Render preset `medium → fast` (CRF 22). `zoom_cache_hits` in ANALYSIS + timing log. `run.py` per-job log + symlink for concurrent-safe pipeline logging. 6-clip 4K re-render: ~3 min (was ~6.5 min). 9/9 + 5/5 + 26/26 + 15/15 PASS. |
| 3.1     | 2026-05-20 | Bug fixes: (1) Shuffle label showing raw JSON or `"shuffle"` on Sound + Render screens — `Sound.tsx` + `Render.tsx` migrated from raw `sessionStorage.getItem()` to `readTransitionConfig()` (compat reader in `buildJobConfig.ts`). ChosenEffects chip now shows "Shuffle" correctly on all screens. (2) Shared video state for two cuts from same raw clip in Arrange — `loadedSrcRef`/`soundLoadedSrcRef` (URL-based guards) renamed to `loadedClipIdRef`/`soundLoadedClipIdRef` (clip-ID guards); switching Cut A → Cut B of same source file now correctly seeks to Cut B's `in_ms`. 9/9 fast + 23/23 arrange PASS. |
| 3.0     | 2026-05-19 | Batch N DONE: Silent background proxy pre-generation when user leaves Trimmer. `Trimmer.tsx` unmount cleanup calls `invoke("generate_proxies_cmd", { projectId, lowPriority: true })`. Rust: `BELOW_NORMAL_PRIORITY_CLASS` + `-threads 1`, encodes at `scale=-2:2160` (qualifies for 1080p + 4K), concurrency guard via `Arc<Mutex<HashSet>>`. `render.py` `required_proxy_h = 2160 if 4k else 1080`. `get_clips_needing_bg_proxy` returns ALL `include=1` clips; `proxy_height_native()` detects + upgrades legacy 1080p proxies. First render after background gen: normalise ~2s (was ~45s). 9/9 fast + 23/23 arrange + 15/15 render PASS. |
| 2.9     | 2026-05-18 | Batch M2 DONE: 9 transition types (added Wipe Down, Dissolve, Barn Door, Band Wipe); Shuffle button (random per-cut, job-id seeded); left-rail 10-card layout; centre preview h-56; animation-only-on-selected bug fixed (inline `animation:"none"` on unselected cards); opening/closing cut UI removed (pipeline defaults "none"); `TransitionConfig` JSON storage; pipeline `_TRANSITION_MAP` + `_SHUFFLE_POOL` extended; 23/23 arrange E2E PASS. Two backlog items added: CSS animation accuracy polish + geometric mini-preview redesign. |
| 2.8     | 2026-05-17 | Batch M1 DONE: transition chips on Arrange screen converted to card-chips with CSS-animated preview thumbnails. 3s looping `@keyframes` for None (`steps(1,end)` hard cut), Crossfade (opacity dissolve), Dip to Black (fade-to-black gap). Thumbnails from first/last in-film `thumbnail_data` with colour-block fallback. Animation plays on selected chip only; others static. 9/9 fast E2E PASS. |
| 2.7     | 2026-05-17 | PRD restructure: added Batch K4 (dual-buffer black flash fix, next batch); split Batch M into M1 (transition preview CSS) + M2 (expanded types + shuffle + first/last cut); moved transition preview from 15e backlog into M1. |
| 2.6     | 2026-05-17 | K3 Revised — Live Rough Mix: Master tab is full-screen film preview. Sequential clip playback via hidden `<video>` + `<audio>` music. Pause/resume, seekable progress bar (imperative DOM updates), `out_ms` boundary via `onTimeUpdate`, music sync + volume reset on seek, fade-out marker with label, idle overlay gated by `hasPlayedRef`. 9/9 fast E2E PASS. |
| 2.5     | 2026-05-16 | Arrange clip playback polish (post-K1): video seeks to `in_ms` on loadedmetadata; stops at `out_ms` in handleTimeUpdate; scrubber clamped to `[in_ms, out_ms]`; elapsed/total shows trimmed duration; filmstrip playhead wired from per-clip currentMs; replay after clip-end fixed (seeks back to in_ms in togglePlay). filmPlayheadMs only shown on zoom tab. 9/9 fast PASS. LEARNINGS.md: per-clip video trim pattern. |
| 2.4     | 2026-05-16 | Batch K split into K1 (Arrange full redesign: centred layout, Zoom tab, Ken Burns modes, clip badges, drag/DEL delete) and K2 (Sound screen: per-clip volume tab + music fade-out + Quick Preview). Old single Batch K spec replaced. |
| 2.3     | 2026-05-16 | Batch J COMPLETE — Arrange screen (`/arrange/:projectId`); 3-tab shell (Clips|Transitions|Cards); per-clip volume (`clip_volume` DB col, `update_clip_volume_cmd`, volume filter in transitions.py + render.py, Mute/50%/100%/150%/200%+Custom chips); Clips tab zoom+focal reuse; StickyFilmStrip `onSelectClip`. zoom.py static crop fix (ffprobe integer coords, replaces broken zoompan expression). Render timing JSONL log (per-render phases, instance detection wdio/direct). render.spec.ts `waitForExist` race fix. 15/15 render E2E PASS. LEARNINGS.md + e2e.md updated. CLAUDE.md two-instance + UX flow fixes. |
| 2.2     | 2026-05-14 | PRD update — Batch J (per-clip audio + music fade-out) and Batch K (text cards + 5 transitions + shuffle + transition in/out) added as pre-launch must-haves. Post-Launch Backlog and AI Enablement sections added. Phase 3 consolidated. msedgedriver v148 confirmed (E2E blocker cleared). |
| 2.1     | 2026-05-14 | TrimBar already-included region overlay — `alreadyCutRegions` prop, `#99B3FF` bracket gradient at z-2, self-exclusion + malformed row + micro-cut guards. Timeline HUD auto-fit — clip add triggers fit-to-width + scroll-to-0; "fit view" pill button; TrimBar text polish. DESIGN.md updated. 9/9 fast E2E PASS. |
| 2.0     | 2026-05-08 | Batch E — Track duration vs. film duration on Sound screen: film duration in header subtitle; mood chips show track duration badge ("Cinematic · 2:34"); comparison line ("Film: 1:23 · Track: 3:45 — long enough" / "will loop ~Nx"); custom track duration probed via `audioRef` `loadedmetadata`; `probedRef` guard on mount probe. PRD: "Post-pick metadata" marked DONE; new backlog item — Smart Music Track Ending. DESIGN.md: duration badge + comparison line patterns. e2e.md + LEARNINGS.md: `preview_*` MCP added to port-9222 conflict warning. 14/14 sound + 7/7 fast PASS. |
| 1.9     | 2026-05-03 | Batch B Run 3 — Custom music (B2): "Custom Track" chip on Sound screen; `open()` from `@tauri-apps/plugin-dialog` (no new Rust cmd — plugin already wired); `custom_music_path` through `buildConfig()` → `start_job` settings JSON → `run.py` (`win_to_wsl` conversion) → `render.py` (guards `"custom"` mood) → `music.py` (`custom_track_path` param). Filename badge below chips. `readStorage()` restores `customPath`; `handleMood()` clears it on switch. `JobConfig` + `SoundState` TS types updated. `sound.spec.ts` updated to 6 chips (OS dialog skip noted). 13/13 sound PASS, 7/7 fast PASS. `DESIGN.md`: chip-triggers-dialog pattern + filename badge. PRD-DEV backlog: Sound screen UX polish (4 items, founder feedback). |
| 1.8     | 2026-05-03 | Batch B Run 2 — 4K export chip + render resize: `has_4k_clips_cmd` Rust command; Render screen `"ready"` phase gate (resolution chips + peach CTA, only for 4K projects); `output_resolution` threaded through `run.py`→`render.py`→`normalise.py`+`transitions.py`; 4K normalise `scale=-2:2160`, transitions canvas `3840×2160`; C6 resize handle on done-state player; `[B1]` grep markers. `render.spec.ts` conditional 4K click. 7/7 fast E2E PASS. |
| 1.7     | 2026-04-28 | Batch 15f — Sound screen (`/sound/:projectId`): StepNav `active="sound"`, 5 mood chips (No Music/Cinematic/Upbeat/Chill/Electronic), conditional volume chips (Subtle/Balanced/Prominent), `sessionStorage` `rc_sound_${projectId}` (JSON). Transitions CTA updated to `/sound/`. Editor seeds config from both `rc_transition_` + `rc_sound_` sessionStorage keys with explicit `VALID_*` guards. `wdio.conf.ts` `/transitions/` + `/sound/` in `waitForAppRoute`. `sound.spec.ts` 13/13 PASS. `DESIGN.md` conditional chip row pattern. Music preview deferred. |
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
