# Batch R Part C — AMF Default for 4K Renders

## Status: DEFERRED

Do not implement until both blockers in the Prerequisites section are resolved.

---

## Why this is needed

From `render-timing-log.jsonl`, 4K render with proxies (cold zoom cache, libx264):

| condition         | t_normalise | t_zoom | t_render | t_total |
|-------------------|-------------|--------|----------|---------|
| 4K, proxy=8/8, cold zoom, libx264 | 5s | 54s | 188s | 256s |
| 4K, proxy=8/8, warm zoom, libx264 | 5s | ~0s  | 188s | ~193s |
| 4K, proxy=8/8, warm zoom, AMF est. | 5s | ~0s  | ~89s | ~94s  |

180s target (from Batch R plan):
- libx264 warm: ~193s — misses by 13s
- libx264 cold: 256s — misses by 76s
- AMF warm: ~94s -- comfortably under

AMF is the only path to <180s on 4K with libx264 as the floor.

---

## Prerequisites (both must be resolved before writing any code)

### 1. Confirm h264_amf works in WSL on this hardware

The machine has an AMD GPU. h264_amf uses the AMD AMF (Advanced Media Framework) SDK,
which requires a driver-level bridge from WSL2 to the Windows AMD driver.

Test command (run in WSL, Tauri binary must NOT be holding AMF):

    wsl -d Ubuntu-24.04 -u root -- ffmpeg -f lavfi -i color=c=black:size=1920x1080:r=30 -t 2 \
      -c:v h264_amf -qp 23 /tmp/amf_test.mp4 2>&1 | tail -20

Expected success: "Output #0, mp4" appears, file written, exit 0.
Expected failure: "Encoder h264_amf not found" or "Cannot load library" -- means Part C
is blocked until WSL2 AMF passthrough is available (may require newer WSL or driver).

NOTE: `pipeline/encoder.py` already has `_detect_amf()` which runs this check.
Call it directly rather than reinventing:

    wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/encoder.py

(Add a `if __name__ == "__main__": print(_detect_amf())` block temporarily.)

If AMF is not available, Part C cannot ship on this machine. Options:
- Deliver via the existing opt-in "Fast render" toggle only (already shipped in Batch Q)
- Revisit when WSL2 AMF passthrough matures

### 2. Add user-facing toast when AMF fallback fires

Currently `_run_with_amf_fallback()` in `pipeline/encoder.py` (line ~79) logs silently:

    [encoder] AMF requested but unavailable -- using libx264 (WSL)

The user sees a "Fast render" toggle is on, but the render actually uses libx264 (slow).
No signal reaches the UI. This is a silent deception.

Required: when AMF was requested but fell back, emit a pipeline stage or ANALYSIS field
that the Render screen can surface as a toast: "Fast render unavailable on this hardware
-- rendered at standard quality."

Implementation sketch:
- Add `amf_fallback=1` to the ANALYSIS line in `render.py` when fallback occurs
- `Render.tsx` reads `analysis_summary` on job-done and shows a toast (existing toast
  infrastructure; see `src/pages/Trimmer.tsx` for the pattern)
- Toast copy: "Fast render unavailable -- rendered at standard quality"
- Toast colour: orange (warning, not error) -- use `#FF8A65` border, dark bg

---

## Implementation plan (once prerequisites clear)

### Step 1 -- Verify AMF availability (prerequisite 1 above)

Run the test. If fail, stop here and note in CONTEXT.md.

### Step 2 -- AMF fallback toast (pipeline/render.py + Render.tsx)

- `render.py`: when `use_amf=True` and `_detect_amf()` returns False, set
  `amf_fallback = True` and include in ANALYSIS line: `amf_fallback=1`
- `src-tauri/src/lib.rs`: parse `amf_fallback` from ANALYSIS, store in
  `jobs.analysis_summary` (already JSON -- add key)
- `Render.tsx`: after job-done, read `analysis_summary`, check `amf_fallback`.
  If truthy, show orange toast "Fast render unavailable -- rendered at standard quality"

### Step 3 -- Default AMF on for 4K (Render.tsx)

- In `Render.tsx`, when `outputResolution === "4k"`, default `useFastRender = true`
- The "Fast render" toggle stays visible and user can override to false
- This is the ONLY change needed -- `buildJobConfig.ts` already threads `use_amf`
  from the toggle state

### Step 4 -- Smoke test

- Run 4K render, confirm `encoder: "amf"` in timing log
- Run again with toggle off, confirm `encoder: "libx264"`
- If AMF silently falls back, confirm toast appears
- 9/9 fast E2E PASS (no spec changes needed -- render.spec.ts clicks "Start anyway"
  and doesn't assert encoder type)

---

## Silent fallback risk (why this was deferred)

`_run_with_amf_fallback()` catches AMF failure and silently uses libx264. Without
prerequisite 2 (toast), a user with AMF=default-on sees a "Fast render" toggle that
does nothing -- render takes the same time as standard. This erodes trust more than
the toggle being off by default. Ship prerequisite 2 atomically with step 3, never
separately.

---

## Timing reference

Pre-Batch R AMF run (DJI 4K, 8 clips, proxies=8/8, warm zoom):
  t_normalise=7s, t_zoom=48s, t_render=89s, t_total=162s
  encoder=amf, zoom_cache_hits=N/A (old log format, no hits field)

Post-Batch R projection (AMF, warm zoom from NTFS cache):
  t_normalise~5s, t_zoom~0s (cache hits), t_render~89s, t_total~94s
  This is 47% faster than the 180s target.
