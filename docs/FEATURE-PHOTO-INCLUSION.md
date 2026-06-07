# 📸 Feature Spec: Photo Inclusion

**Status:** Draft  
**Date:** 2026-06-07  
**Delivery Model:** Sequential batches — complete and test each before starting the next

---

## Overview

Allow users to insert a photo montage sequence as a video clip into the RushCut timeline. Photos are selected from a local folder, styled with an animation effect, then dropped into the universal film timeline like any other clip.

---

## Entry Point

- New optional button in the **bottom nav bar** (📷 icon, labeled "Photos")
- Tapping opens the Photo Inclusion flow (separate from main video import)

---

## Batch Delivery Plan

Each batch is independently shippable and testable. Do not start the next batch until the current one passes all success criteria.

---

## Batch A — Ken Burns Photo Sequence (Core)

**Goal:** User can select photos, apply Ken Burns animation, preview it, and add it to the timeline as a draggable clip.

### Scope

**Step 1 — Folder / Photo Selection**
- Bottom nav "Photos" button opens native file picker (folder or multi-file)
- Thumbnails shown in a grid; tap to select/deselect (multi-select)
- Confirm button proceeds to Step 2

**Step 2 — Ken Burns Style Applied (auto, no style picker yet)**
- Each photo fills full screen canvas
- Alternating zoom direction: photo 1 = zoom in, photo 2 = zoom out, photo 3 = pan left→right, photo 4 = pan right→left, repeat
- Ease in/out on all keyframes (no linear zoom)
- Default: 3 sec per photo, adjustable total duration slider (5–30 sec range)
- Minimum enforced: 2 sec per photo — warn user if they add too many photos for the duration set

**Step 3 — Portrait Photo Handling**
- Landscape canvas (16:9): portrait photos render with **blurred background fill** (same photo, blurred + scaled to fill, sharp photo centred on top)
- This is the default — no option needed in v1

**Step 4 — Preview**
- Inline preview plays before confirming
- Preview rendered at reduced resolution for speed (not export quality)

**Step 5 — Timeline Integration**
- Sequence added as a single `TimelineClip` block, `type: 'photo-sequence'`
- Clip is draggable, re-orderable, deletable — same as any video clip
- Thumbnail strip on the clip shows first photo + 🎞️ label
- Music continues uninterrupted through the clip

**Transitions at clip boundaries:**
- Default: cross-dissolve 0.4 sec on both ends
- No user-configurable transition type in Batch A

### Data Model

```
PhotoSequenceClip {
  type: 'photo-sequence',
  photos: File[],
  style: 'ken-burns',
  durationTotal: number,        // seconds
  durationPerPhoto: number,     // auto-calculated
  portraitMode: 'blur-fill',    // locked in v1
}
```

### Resolution Warning
- If any photo is below 1280×720px, show a warning: "One or more photos may appear blurry when zoomed. Tap to continue anyway."

### Success Criteria — Batch A

| # | Test | Pass Condition |
|---|------|----------------|
| A1 | Tap Photos nav button | File picker opens |
| A2 | Select 4 photos, tap Confirm | Thumbnail grid shows all 4 selected |
| A3 | Preview plays | Ken Burns animates; zoom direction alternates per photo; no linear/jarring motion |
| A4 | Portrait photo in selection | Renders with blurred background fill, sharp photo centred |
| A5 | Set duration to 8 sec with 4 photos | Each photo runs exactly 2 sec |
| A6 | Set duration to 5 sec with 6 photos | Warning shown: "too many photos for this duration" |
| A7 | Confirm and add to timeline | Clip block appears on timeline, draggable |
| A8 | Drag clip to different timeline position | Clip moves, other clips shift correctly |
| A9 | Play through clip in editor | Music continues uninterrupted |
| A10 | Cross-dissolve at clip boundary | Smooth dissolve in and out of photo sequence |
| A11 | Low-res photo (<1280×720) in selection | Warning shown before confirming |
| A12 | Delete clip from timeline | Clip removed, timeline reflows correctly |

---

## Batch B — Frame Styles (Visual Borders on Photos)

**Goal:** User can apply a decorative frame to their photo sequence, choosing from 3 frame types.

> **Dependency:** Batch A complete and passing.

### Scope

Frame is applied to each photo **within** the Ken Burns animation — i.e. the frame sits on top of the photo as an overlay layer.

**3 Frame Types:**

| Frame | Description | Visual Style |
|---|---|---|
| **Classic White** | Clean white border, ~2–3% of canvas width, slight drop shadow on inner edge | Timeless, wedding/print feel |
| **Polaroid** | White border, thicker at bottom (~6%), very slight rotation (~1–2°) per photo, subtle drop shadow | Nostalgic, casual |
| **Filmstrip** | Thin black border with sprocket holes on top and bottom edges | Cinematic, retro |

**UX addition in Batch B:**
- After photo selection, show a **Style row** with 3 frame thumbnails (tap to select, none selected = no frame)
- Frame selection is optional — default is no frame
- Frame preview updates in the existing inline preview

### Success Criteria — Batch B

| # | Test | Pass Condition |
|---|------|----------------|
| B1 | Style row shows 3 frame options | All 3 visible with thumbnail preview |
| B2 | Select Classic White, play preview | Clean white border visible on all photos |
| B3 | Select Polaroid, play preview | Thick bottom border + subtle tilt visible; tilt varies slightly per photo |
| B4 | Select Filmstrip, play preview | Black border with sprocket holes visible |
| B5 | Select no frame (default) | Photos render without any frame |
| B6 | Frame renders on portrait (blur-fill) photo | Frame sits on sharp photo, not on the blurred background layer |
| B7 | Frame persists in timeline clip thumbnail | Clip thumbnail strip reflects frame choice |
| B8 | All Batch A criteria still pass | No regression |

---

## Batch C — Fan Stack Style

**Goal:** Add a second animation style — photos reveal as a fan/card stack.

> **Dependency:** Batches A + B complete and passing.

### Scope

**Style Picker added to flow:**
- After photo selection, user now sees a **Style Picker** row with 2 options: Ken Burns | Fan Stack
- Frame selection row still appears below (Batch B)

**Fan Stack behaviour:**
- Photos stack on top of each other, centred on canvas
- Each photo fans out in sequence: rotates ~5–15° (alternating left/right) and slides slightly off-centre
- Reveal: one card fans out per beat, previous cards remain visible beneath
- Cap: **maximum 6 photos** — if user selects more, show message "Fan Stack works best with up to 6 photos. Only the first 6 will be used."
- Timing: each fan-out animation ~0.5 sec, then holds for remaining per-photo duration

### Success Criteria — Batch C

| # | Test | Pass Condition |
|---|------|----------------|
| C1 | Style Picker row shows Ken Burns + Fan Stack | Both options tappable |
| C2 | Select Fan Stack with 4 photos, preview | Cards fan out sequentially; rotation alternates left/right |
| C3 | Select Fan Stack with 8 photos | Warning shown; only 6 used |
| C4 | Fan + Classic White frame | Frame visible on each card in the fan |
| C5 | Fan + Polaroid frame | Polaroid tilt stacks naturally with fan rotation |
| C6 | Timeline clip from Fan Stack | Clip draggable and plays correctly |
| C7 | All Batch A + B criteria still pass | No regression |

---

## What's NOT in Scope (any batch)

- Per-photo duration manual override (auto-divide only)
- Custom pan/zoom keyframe editing
- Text overlays on photos
- Video clips mixed into the photo sequence
- Photo reordering within the sequence after creation (delete and re-create)
- Collage Grid style (post-Batch C consideration)
- Configurable transition type at clip boundaries

---

## Open Questions (resolve before Batch A build starts)

1. **Portrait photo default confirmed?** → Blur-fill (spec'd above). Confirm or override.
2. **Tap-to-edit after placement?** — Should tapping the photo clip on the timeline re-open the style/selection flow, or is it immutable until deleted?
3. **Resolution threshold** — 1280×720 as the warning floor: too strict, or right?

---

## Implementation Notes for Claude Code

- Photo sequence renders as a **virtual video clip** (array of images + animation metadata)
- Export: each photo + style rendered frame-by-frame into output video
- Reuse existing `TimelineClip` model — `type: 'photo-sequence'`
- Do NOT build a separate renderer — add `renderPhotoFrame(photo, style, frameOpts, t)` into existing canvas/frame renderer
- Ken Burns: CSS `transform: scale() translate()` with keyframe interpolation at render time; alternate zoom params per photo index
- Blur fill: render photo scaled to fill canvas, apply CSS blur filter, then render sharp photo centred on top at natural aspect ratio
- Fan: CSS `transform: rotate() translateX()` stacked with z-index per photo; animate on a per-card timeline
- Frames: rendered as a canvas overlay layer (not baked into the photo); keeps frames crisp at any resolution
