# Batch Q2 — FPS Stutter Fix

## Root cause

Pipeline hardcodes 25fps everywhere. DJI Osmo Pocket 3 shoots at 29.97fps (30000/1001).
Conversion ratio 29.97/25 = 1.1988 — one source frame dropped every ~5 output frames.
On constant-motion pans this is clearly visible as a stutter pulse every ~200ms.

Stutter is baked into the **proxy at generation time** (`-r 25 -fps_mode cfr` in proxy.py).
The render uses the proxy directly, so the final output inherits it.
Same problem applies to the normalise path (also `-r 25 -fps_mode cfr` in normalise.py).

Evidence clip: `C:\clips\DJI_20250620164826_0002_D.MP4`
- Source: 29.97fps, 164 frames, 5.472s
- Proxy: 25fps, 138 frames, 5.520s — 26 frames dropped
- Output clips5-02: 25fps, verified via ffprobe — stutter confirmed on playback

## Fix plan

1. **`render.py`** — detect `target_fps` from source clips before Step 1.
   ffprobe the first included clip, round 29.97 -> 30, 25.0 -> 25, 23.976 -> 24.
   Pass as parameter to normalise and as `-r {target_fps}` in final encode.

2. **`normalise.py`** — replace hardcoded `-r 25` with `target_fps` parameter.

3. **`proxy.py`** — replace hardcoded `-r 25` with source clip's native FPS.
   Already has clip path available at generation time. Probe fps before encode.

4. **`render.py` proxy reuse gate** — add FPS check.
   If proxy FPS != target_fps, reject proxy and fall through to normalise.
   Function `_proxy_height()` can be extended to also return fps.

5. **Existing proxies** — all existing proxies are 25fps (wrong for 29.97 source).
   FPS gate in step 4 will automatically cause rejection and renormalise on next render.
   Background proxy gen will regenerate them at correct fps after that render.

## No schema change required

Probe fps at render time via ffprobe on clip paths already in the manifest.
FPS can optionally be added to the clips table later for display purposes.

## FPS rounding logic

```python
def round_to_standard_fps(r_frame_rate: str) -> int:
    """Round ffprobe r_frame_rate string to nearest standard fps."""
    num, den = map(int, r_frame_rate.split("/"))
    fps = num / den
    for standard in [24, 25, 30, 50, 60]:
        if abs(fps - standard) < 0.5:
            return standard
    return 25  # fallback
```

## Acceptance

- Render a constant-pan DJI clip and compare side-by-side with raw. Zero visible stutter.
- ffprobe output confirms `r_frame_rate=30/1` (or native fps) instead of `25/1`.
- Existing 25fps proxies get rejected and regenerated on next render (check log for "proxy FPS mismatch").
