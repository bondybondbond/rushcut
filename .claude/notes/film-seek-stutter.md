# Film mode seek stutter — open issue

## Symptom
When clicking the film timeline to seek to a position in a **different clip** than the one currently playing, playback briefly shows a blank (frame 0) of the target clip before landing at the correct position. Same-clip seeks work correctly.

## Root cause (confirmed)
Multi-layer timing problem across the JavaScript renderer and the WebView2 GPU compositor:

1. The active film slot (e.g. slot A) is playing clip 3 at opacity=1.
2. User clicks clip 1's position in the timeline → `seekFilmTo` → `loadIntoSlot(0, "a", seekMs)`.
3. Slot A is immediately hidden (`v.style.opacity = "0"` before `v.src = src`).
4. `loadedmetadata` fires, `v.currentTime = seekMs / 1000` is set.
5. `seeked` fires (in the renderer process) — but the GPU compositor has NOT yet committed the seeked frame.
6. `activate()` runs: `v.play()` starts, rVFC is registered.
7. rVFC fires when the compositor presents the first rendered frame.
8. `setSlotVisible(slot)` → slot A becomes visible.

**The stutter is at step 7–8**: when `v.play()` is called on a video after a seek and src change, the GPU compositor in WebView2 appears to present frame 0 as the first frame (before the decoded seek-target frame is ready), and rVFC fires for that frame 0 presentation. The slot is then made visible showing frame 0 briefly before the video catches up to `seekMs`.

## What was tried

### Attempt 1 — `setActiveFilmSlot` React state (original implementation)
Set slot visibility via React `useState`. React's async batching caused the slot to be visible at frame 0 before `seeked` fired.  
**Result:** stutter on every cross-clip seek.

### Attempt 2 — Option B: imperative `ref.style.opacity` writes (Batch-I fix)
Replaced `setActiveFilmSlot` with direct `v.style.opacity = "0"/"1"` writes. Added `v.style.opacity = "0"` BEFORE `v.src = src` in `loadIntoSlot`. Visibility updates moved to be synchronous inside the `seeked` callback.  
**Result:** stutter persists — `seeked` fires before the GPU compositor has the frame.

### Attempt 3 — `requestVideoFrameCallback` (rVFC) reveal
After `seeked` fires: call `v.play()` (video hidden, opacity=0), then register rVFC; only call `setSlotVisible(slot)` when rVFC fires (GPU frame committed).  
Added generation counter (`slotGenRef`) to invalidate stale rVFC callbacks from rapid/overlapping seeks.  
WebView2 confirmed to support rVFC: `typeof v.requestVideoFrameCallback === 'function'` → `true` (Edg/148).  
**Result:** slight improvement in stutter duration, but flash of frame 0 still visible. rVFC appears to fire on the first post-play frame, which in WebView2 is frame 0 rather than the seeked frame, at least for the first rVFC cycle after a src change + seek.

### Bugs fixed along the way (shipping)
- **Click-to-seek never worked on first visit (new film):** `didDragRef.current` in `StickyFilmStrip` was stuck `true` after any pan because `handleMouseDown` only reset it when clicking the background element (not clip tiles). Fix: reset `didDragRef.current = false` unconditionally at the top of `handleMouseDown`.
- **Click-to-seek blocked after pan:** same root cause as above, same fix.

## Current code state (as of fix attempt 3)
- `setActiveFilmSlot` React state removed; `activeFilmSlotRef` retained for `onTimeUpdate` guards.
- `setSlotVisible(slot)` helper writes imperatively to both `filmVideoARef` and `filmVideoBRef`.
- Slot hidden before src change: `v.style.opacity = "0"` immediately before `v.src = src`.
- `activate()` uses rVFC (with double-rAF fallback) to reveal slot.
- `slotGenRef` generation counter invalidates stale callbacks from overlapping seek calls.
- No `opacity` or `pointerEvents` in JSX `style` prop of film video elements (imperative only).

## DOM state captured mid-seek (diagnostic snapshot)
```
idx=0 (videoRef, clip video): opacity="0", src=DJI_0001, currentTime=1852ms  — hidden in film mode ✓
idx=1 (filmVideoARef, slot A): opacity="1", src=DJI_0003, currentTime=19653ms — showing OLD clip!
idx=2 (filmVideoBRef, slot B): opacity="0", src=DJI_0002, currentTime=5472ms  — hidden ✓
```
The snapshot was taken during a seek from clip 3 to clip 1. Slot A is visible showing clip 3 while the seek is in-flight — this is the frame-0 stutter window. By the time the rVFC fires, the user briefly sees the old clip or frame 0 of the new clip.

## Potential approaches to try next

### Option E — Canvas snapshot cover
Before hiding slot A and initiating the src change:
1. `ctx.drawImage(v, 0, 0, canvas.width, canvas.height)` — capture the current last frame of the outgoing clip.
2. Overlay the canvas as `position: absolute, inset: 0` over the video container at `z-index: 15`.
3. Proceed with hide → src change → seek → play → rVFC normally.
4. After rVFC fires (correct frame composited), remove the canvas overlay.
The user sees the outgoing frame frozen (not a flash of frame 0) during the seek transition.  
**Risk:** canvas drawImage on a paused cross-origin video may fail. Since clips are local via `convertFileSrc`, this should be fine.  
**Complexity:** moderate — need a `canvasRef` per slot or a single shared overlay canvas.

### Option F — Play→pause repaint before reveal
After `seeked` fires:
1. Call `v.play().then(() => v.pause())` — this forces WebView2 to commit the decoded frame to the compositor (same trick used for the clip-mode video to repaint after `currentTime` assignment).
2. After the `.then()` resolves (video is paused at seekMs, frame committed): call `setSlotVisible(slot)`, then `v.play()` for real.  
**Risk:** adds ~1 play-pause cycle of latency (~16ms); audio may blip on the pause. Separate the audio from the hidden reveal if needed (`v.muted = true` during the play→pause).  
**This is likely the most reliable fix** — the clip-mode video already uses this pattern successfully (`v.play().then(() => { v.pause(); ... })`).

### Option G — Dedicate a hidden "seek canvas" for frame rendering
Use `OffscreenCanvas` + `requestAnimationFrame` to composite the incoming slot off-screen while hidden. Show only when the OffscreenCanvas matches the target frame. Requires `transferControlToOffscreen()` — unsupported in some WebView2 builds.

## Option H — cross-slot load with rVFC mediaTime gate — PASS (2026-05-13)

**The fix.** Two reinforcing mechanisms in `Trimmer.tsx`:

1. **`gateFrameRevealThen(v, slot, thisGen, targetSec, onReady)`** helper — calls `v.play()`, then uses `requestVideoFrameCallback` to inspect each composited frame's `metadata.mediaTime`. Only invokes `onReady()` once a frame is at/near `targetSec` (`TOLERANCE_SEC = 0.05`, `MAX_WAITS = 30` safety cap). Frame-0 leaks fail the gate and are skipped silently.
2. **`crossSeekToClip(idx, seekMs)`** — for user-initiated cross-clip seeks via `seekFilmTo`, loads the new clip into the **opposite** slot (not the active one) and uses the gate to delay the visibility swap until the new slot has rendered the seek-target frame. The outgoing slot remains visible the whole time, so the user sees a clean cut: outgoing-frame → seek-target frame of new clip. No hidden gap, no frame 0.

**Why Option F failed.** `v.play().then(() => v.pause())` resolves when audio playback starts, not when the seek-target video frame is composited. The compositor often presents frame 0 first; `v.pause()` then froze at frame 0; reveal pinned to frame 0; user saw the flash. The plan-mode verification used screenshots taken after `v.pause()` and missed this entirely. Option F has been removed.

**Verification (2026-05-13).** Instrumented both film `<video>` elements with rVFC `mediaTime` logging via chrome-devtools MCP. Dispatched cross-clip clicks during continuous playback and rapid-fire scrubbing (5 seeks in ~800ms).
- Single seek: opposite slot stayed at opacity=0 while presenting frames at mediaTime=35.2 → 35.3 (hidden), revealed at mediaTime=35.4. No frame at opacity=1 with mediaTime < target.
- Rapid-fire (clip1→clip3→clip1→clip2→clip3 in <1s): zero opacity=1 frames with mediaTime < 1.0. Gate held under stress. No console errors. No safety-cap warnings.

**Why this works.** The opposite-slot routing mirrors the proven `advanceFilmClip` pattern for end-of-clip transitions — same architecture, applied to user-clicked seeks. The rVFC `metadata.mediaTime` gate gives us a per-frame ground truth on what the compositor is actually presenting, which `seeked` and `play().then()` do not.

---

## Previous attempt (Option F — superseded, did not fix the playing-state case)
**Option F** — play→pause repaint before reveal, with temporary mute to suppress audio blip:
```tsx
function activate() {
  if (!filmModeRef.current || !v || slotGenRef.current[slot] !== thisGen) return;
  activeFilmSlotRef.current = slot;
  v.muted = true;
  v.play()
    .then(() => {
      v.pause();
      v.muted = false;
      if (filmModeRef.current && slotGenRef.current[slot] === thisGen) {
        setSlotVisible(slot);
        v.play().catch(() => {});
      }
    })
    .catch(() => {
      v.muted = false;
      if (filmModeRef.current && slotGenRef.current[slot] === thisGen) {
        setSlotVisible(slot);
        v.play().catch(() => {});
      }
    });
  // Preload next clip
  const nextIdx = idx + 1;
  if (nextIdx < inFilmRef.current.length) {
    preloadIntoSlot(nextIdx, slot === "a" ? "b" : "a");
  }
}
```
The temporary mute prevents the audio blip from the play→pause cycle. WebView2 should paint the paused frame to the compositor before the second `play()` starts — matching the proven clip-mode repaint pattern.
