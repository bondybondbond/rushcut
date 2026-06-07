# 📸 Feature Spec: Photo Inclusion

**Status:** Draft  
**Date:** 2026-06-07

---

## Overview

Allow users to insert a photo montage sequence as a video clip into the RushCut timeline. Photos are selected from a local folder, styled with an animation effect, then dropped into the universal film timeline like any other clip.

---

## Entry Point

- New optional button in the **bottom nav bar** (e.g. 📷 icon, labeled "Photos")
- Tapping opens the Photo Inclusion flow (separate from the main video import)

---

## Flow

### Step 1 — Folder Selection
- User selects a **local folder** of photos (use native file picker, folder-level selection)
- Thumbnails of all images shown in a grid
- User **taps to select** which photos to include (multi-select)
- Confirm selection → proceeds to style picker

### Step 2 — Style Picker
User chooses how the photos will be animated/arranged. Start with 3 styles:

| Style | Description | Notes |
|---|---|---|
| **Ken Burns** | Each photo fills full screen, slow zoom-in or zoom-out with subtle pan | Industry standard for still-to-video. Vary zoom direction per photo for flow. Ease in/out on keyframes. |
| **Fan Stack** | Photos appear stacked, fanning out one by one like playing cards | Overlapping reveal, rotate ~5–15° per card. Good for 3–6 photos. |
| **Collage Grid** | All selected photos arranged in a grid layout that appears as a single frame | Static or with staggered fade-in per photo. |

> **Later additions could include:** filmstrip scroll, polaroid drop, mosaic build-up.

### Step 3 — Duration & Timing
- User sets **total sequence duration** (default: 5–10 sec, adjustable)
- Per-photo time is calculated automatically: `total_duration / num_photos`
- For Ken Burns: minimum ~2 sec per photo recommended (keep it slow and steady)
- Preview of the sequence plays inline before confirming

### Step 4 — Timeline Integration
- Confirmed sequence is **added as a single clip block** to the universal film timeline
- Behaves like any video clip: draggable, re-orderable, deletable
- User can **drag it left/right** to position when in the edit it appears
- Clip block shows a thumbnail preview strip (first photo + style icon label)

---

## Music Continuity

- Background music **continues uninterrupted** through the photo sequence
- No ducking or fade needed — photo sequence is a visual-only overlay on the audio track
- The audio layer is separate and unaffected by inserting photo clips

---

## Transitions

This is the trickiest part. Two scenarios:

### Scenario A: Photo sequence between two video clips
- The **outgoing video clip's transition** plays normally into the photo sequence
- Outgoing: use existing video transition (e.g. fade, cut, wipe) — transition from video → first photo
- Incoming: transition from last photo → next video clip
- Recommendation: **cross-dissolve** as the safest default for photo boundaries, since there's no natural "action" to match-cut on
- Allow user to set the transition type at each boundary independently

### Scenario B: Photo sequence at start or end
- At start: sequence fades in from black (or from splash screen)
- At end: sequence fades out to black (or to outro)

### Known UX Gap ⚠️
- There is **no "photo side" of a video transition** — the photo has no motion vector or scene context to anchor a directional transition
- Mitigation: Ken Burns effect gives the photo movement, so a dissolve/fade feels natural as a blend
- Do NOT attempt to apply a motion-match or J-cut to photos — treat them like a static clip with internal animation

---

## Best Practices (from Premiere Pro / Lightworks / Ken Burns research)

1. **Ken Burns: vary zoom direction per photo** — if photo 1 zooms in, photo 2 should zoom out or pan. Prevents monotony. [Adobe Premiere best practice]
2. **Ease keyframes** — use Ease In / Ease Out on zoom keyframes. Hard linear zoom looks cheap.
3. **High-res photos only** — zooming into a low-res image exposes compression. Consider warning user if image resolution is too low for the chosen style.
4. **Minimum 2 sec per photo** — faster than 2 sec feels jerky. If user adds 10 photos into a 5-sec clip, warn them.
5. **Cross-dissolve at photo boundaries** — 0.3–0.5 sec overlap. Shorter = cut, longer = dreamy.
6. **Fan style: cap at 6 photos** — more than 6 fans become visually cluttered. Enforce or warn.
7. **Collage: aspect ratio consistency** — if photos have mixed orientations (portrait vs landscape), the collage grid should handle cropping gracefully (object-fit: cover, not stretch).

---

## What's NOT in Scope (v1)

- Per-photo duration manual override (auto-divide only in v1)
- Custom pan/zoom keyframe editing (preset styles only)
- Text overlays on photos
- Video clips mixed into the photo sequence
- Photo reordering within the sequence after creation (delete and re-create)

---

## Open Questions

1. Should the photo sequence be **editable after placement** (tap to re-open style picker) or is it immutable once dropped?
2. How do we handle **portrait photos in Ken Burns** full-screen mode — letterbox, blur background fill (like Instagram), or crop to fill?
3. Do we expose **per-photo duration** as an advanced option in v1, or keep it auto-only?
4. What is the minimum viable **resolution threshold** before we warn the user a photo may look blurry when zoomed?

---

## Implementation Notes for Claude Code

- Photo sequence renders as a **virtual video clip** (array of images + animation metadata)
- At export time, each photo + its style gets rendered frame-by-frame into the output video
- Reuse the existing `TimelineClip` model — photo sequence is just another clip type with `type: 'photo-sequence'`
- Store: `{ photos: File[], style: 'ken-burns'|'fan'|'collage', duration: number }`
- Do NOT build a separate renderer — hook into the existing canvas/frame renderer and add a `renderPhotoFrame(photo, style, t)` function
- Ken Burns: CSS `transform: scale() translate()` with keyframe interpolation at render time
- Fan: CSS `transform: rotate() translateX()` stacked with z-index per photo
