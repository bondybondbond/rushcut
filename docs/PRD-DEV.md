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

> **Status: PLANNED.**
> **Prerequisite: Batch J + M1.**
> **Scope: `pipeline/transitions.py` + `Arrange.tsx` Transitions tab.**

#### UI redesign — left-rail layout

The current chip-row layout doesn't scale past 5 transitions. M2 replaces it with a **media-pantry-style left rail** + **centre video preview**:

```
┌─────────────────────────────────────────────────────┐
│  [left rail — scrollable]  │  [centre — video preview] │
│                             │                           │
│  ○ None                     │   ┌─────────────────┐    │
│  ● Crossfade  ◀ selected    │   │  proxy clip A   │    │
│  ○ Dip to Black             │   │  ─── fade ───   │    │
│  ○ Wipe                     │   │  proxy clip B   │    │
│  ○ Zoom                     │   └─────────────────┘    │
│                             │   "Crossfade"             │
│  [✦ Surprise me]            │                           │
└─────────────────────────────────────────────────────┘
```

- **Left rail:** vertical list of transition options (icon + label). Selected = `border-[#99B3FF]` highlight. Clicking a row selects it and starts the centre preview.
- **Centre video preview:** plays the actual proxy video of the first/last in-film clip with the selected transition applied — CSS animation (same keyframes from M1) overlaid on the proxy thumbnails, OR a short pre-rendered proxy-quality clip if feasible. Start simple: reuse M1 CSS animation scaled up into a larger preview area using real thumbnails.
- **"Surprise me" button:** below the list (lucide `Shuffle`, secondary outlined style). Sets `transition: "shuffle"` in sessionStorage. `transitions.py` random pick per cut from `[fade, fadeblack, wipeleft, zoom]`. Log `[M] cut N: {type}`.
- **Animation trigger:** click to select → preview plays once then loops. No hover trigger (confirmed in M1).

#### 5 transition types

| Option | FFmpeg xfade | Status |
|---|---|---|
| None | — | Existing |
| Crossfade | `fade` | Existing |
| Dip to Black | `fadeblack` | Existing |
| Wipe | `wipeleft` | New |
| Zoom | `zoom` | New (FFmpeg xfade `zoom` — confirm availability; fallback `fade`) |

#### Pipeline changes

- `transitions.py`: add `wipeleft` + `zoom` to xfade dispatch. Shuffle random draw per cut. All use existing `xfade_dur` + clamp.
- No first/last cut pickers in M2 — deferred (adds scope; not essential for launch).

#### Acceptance checks

- [ ] Transitions tab: left rail with 5 options + "Surprise me" button; centre shows enlarged preview
- [ ] Selecting a transition updates centre preview immediately
- [ ] Wipe and Zoom functional in rendered output
- [ ] Shuffle produces varied transitions (pipeline log confirms per-cut type)
- [ ] No regression: None/Crossfade/Dip to Black unchanged
- [ ] No console errors on Transitions tab

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
| Music API / digital library | Loudly or Soundraw API; replaces bundled tracks |
| Transition library | More xfade types; per-clip transition picker |
| Quick Preview render | In Batch J (Sound screen, pre-export preview). Post-launch: secondary "Quick Preview" button on Render screen as well. |
| Improved music loop | Waveform-matching loop point (librosa); see existing backlog item |
| Smart music track ending | Spectral-optimal fade-out point (librosa); see existing backlog item |
| Timeline zoom/pan tooltips | Ctrl+scroll / drag pan discoverability hint |
| Badge tooltips | Hover tooltips on all clip badges: Z badge → "Zoom applied"; purple dot → "Volume override"; blue number badge → "Clip N of M"; duration label → "Trimmed duration". Apply consistently across StickyFilmStrip tiles and the Arrange clip rail. Native HTML `title` attr is sufficient — no custom tooltip component needed. |
| Filmstrip clip delete — drag to bin | Current drag-left swipe to delete feels accidental and undiscoverable. Replace with an explicit bin zone: a trash icon area visible at the far left (or right) of the filmstrip that clips must be dragged onto to delete. Drag-left swipe should be removed entirely. |
| Filmstrip tile swipe fires on middle mouse button | `handleTileMouseDown` in `StickyFilmStrip.tsx` does not check `e.button` — middle-click (button 1, used for pan) starts a swipe gesture on the tile, fighting the pan handler. Fix: guard with `if (e.button !== 0) return;` at the top of `handleTileMouseDown`. |
| Sporadic video reset mid-session (Trimmer + Arrange) | Affects both screens. **Trimmer:** while playing mid-clip, video briefly goes blank + spinner, then resumes from `in_ms` (trim start) — clip selection preserved. **Arrange zoom tab:** blank + spinner, then `selectedClipId` resets to null — user must re-pick a clip. The Trimmer symptom (seek to `in_ms`) points to `handleLoadedMetadata` firing spuriously, meaning `video.load()` was called mid-playback. The Arrange symptom (clip deselected) suggests either a component remount (React key change, route re-render) or `selectedClipId` state being wiped — possibly the same `clips` state refresh that triggers the Trimmer reload also causes Arrange to remount or lose selection. Likely common root cause: a background Tauri event (`proxy-progress`, `thumbnail-progress`, or `waveform-progress`) arriving late and updating `clips` state, which cascades into a video-load `useEffect` re-run. The `loadedSrcRef` same-src guard may be bypassed because `convertFileSrc()` reconstructs a new string reference each render. Investigate: add `console.log('[video] load triggered')` before `video.load()` in both screens; also log when `selectedClipId` becomes null in Arrange to distinguish remount from state wipe. |
| Sound screen UX polish | "No Music" differentiation, Custom Track affordance |
| Add/remove clips from Trimmer without returning to Upload | Once past the Upload screen there is no way to add new clips to the media pantry or remove unwanted ones. Add an "Add clips" button (folder + files picker, same as Upload) in the Trimmer's Media Pantry header; invoking it appends the new clips to the project via `scan_folder`/`scan_files` + `create_project` or a new `add_clips_to_project` Rust command. Also allow removing a clip from the pantry entirely (not just from the film) — long-press or right-click context menu on a pantry tile with a "Remove from project" option that calls `delete_clip_cmd`. |
| More card optionality | Font choice, card duration control, animated cards |

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
