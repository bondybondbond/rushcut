# RushCut — Post-First-Cut Fix & Dev Plan (Batches U1–U6 + Backlog)

## Context

The founder completed their first real edit — a kids' film, 20 DJI 4K clips, ~2:46 output — in about an hour, then hit **3 failed render attempts** (exit 15, exit 1, exit 15) while navigating in and out of the render screen. Alongside the crashes they logged detailed UX/correctness feedback across every screen. This plan turns that feedback into prioritized batches.

Guiding decisions (confirmed with founder):
- **Batch U1 must fully unblock** the current job: render resume + crash hardening so the 2:46 film can finish and crashes stop recurring.
- **Clip reorder on the film timeline is the top new feature** → Batch U2, ahead of the zoom-tab correctness work (Batch U3).
- **Frontloading = warm the existing per-clip zoom cache** in the background after the zoom screen (lowest-risk, biggest win for this zoom-heavy film).
- **Deferred to backlog:** dual-screen compare, trim film-tab edge drag, drag-region-to-timeline, upload speed.

All progress (proxies, zoom cache) already survives crashes — they live in `%APPDATA%\rushcut` and `%TEMP%\rushcut\zoom-cache`, not in the failed job row. So no edits are lost; the job just needs to be re-run reusing that cached work.

---

## Batch U1 — Render resilience & resume — COMPLETE (all sub-batches U1a–U1g done, 2026-06-07)

Sub-batch status: U1a (stage/timer/single-job guard) ✓ · U1b (render quality/localStorage/mute) ✓ · U1c (startup self-heal / SQLite datetime fix) ✓ · U1d (nav-guard/new render visibility) ✓ · U1e (stall detection) ✓ · U1f (fast bg proxy) ✓ · U1g (segmented xfade / exit-15 fix) ✓. Known remaining gap: `has_open`/`has_close` projects still use monolithic path — backlog item, not U1.

**Original spec:**

**Problem:** Leaving the render screen mid-render (e.g. at 55% zoom) and resuming resets the status to "Starting up the magic..." and the timer to 0s, even though the pipeline is still running. Three renders also died with SIGTERM (15) / generic (1) — most likely concurrent/duplicate pipeline spawns competing for WSL memory on a 4K zoom-heavy render.

**Root causes (verified):**
- `Render.tsx` re-attach ([src/pages/Render.tsx:277](src/pages/Render.tsx:277)) sets `phase="rendering"` + `progress` but never restores the **stage label** (stays at init value [Render.tsx:239](src/pages/Render.tsx:239)/`"Starting up the magic..."`).
- Elapsed-timer effect ([Render.tsx:386](src/pages/Render.tsx:386)) sets `startTimeRef = Date.now()` on every transition into "rendering" → timer restarts on resume.
- `jobs` table ([src-tauri/src/db.rs](src-tauri/src/db.rs)) has `progress_pct`, `created_at`, `updated_at` but **no `current_stage`** column — stage isn't persisted, so on re-attach there's nothing to show until the next `pipeline-stage` event fires.
- Pipeline spawn ([src-tauri/src/lib.rs](src-tauri/src/lib.rs) `run_pipeline` ~1196) does **not** kill on unmount (good) but there is no guard preventing a **second** render job for the same project from being spawned if the user re-enters and an auto-submit path fires — a strong SIGTERM/OOM suspect on 4K.

**Changes:**
1. **Persist live stage + start time.**
   - Add `current_stage TEXT` to the `jobs` table (migration in `db.rs`); update it when each `STAGE:` line is parsed in `lib.rs`. Keep using `created_at` as the canonical render start.
   - `get_render_status_cmd` / `get_active_job` ([db.rs:712](src-tauri/src/db.rs:712)) already return the job; ensure `current_stage` + `created_at` ride along in the returned struct.
2. **Fix resume in `Render.tsx`.**
   - On re-attach ([Render.tsx:277](src/pages/Render.tsx:277)): set stage label from `active_job.current_stage` (via existing `stageLabel()` map [Render.tsx:33](src/pages/Render.tsx:33)) and seed `startTimeRef` from `Date.parse(active_job.created_at)` so the timer continues, not resets.
   - Decouple the timer effect ([Render.tsx:386](src/pages/Render.tsx:386)) from unconditionally resetting `startTimeRef` — only reset for a brand-new render (`startNewVersion`/`submitJob`), never on re-attach.
3. **Single-in-flight-job guard.**
   - In `start_job`/`submitJob` path: before spawning, check `get_active_job(project_id)`; if one exists, re-attach instead of spawning a duplicate. Prevents two concurrent 4K pipelines (the prime exit-15 suspect with two-binaries-share-one-DB).
4. **Resumable retry.**
   - On the error screen ([Render.tsx:649](src/pages/Render.tsx:649)), make "Try Again" call the normal render path so it **reuses existing proxies + zoom cache** (already cache-keyed in `render.py`). Add copy reassuring the user no edits were lost. Confirm a failed job row never deletes cached proxies/zoom segments.
5. **Progress-bar honesty (the "starts at 50%" complaint).**
   - The 50% jump is correct (proxies skip the normalise arc, [render.py:419](pipeline/render.py:419)) but the label "Trimming clips..." at 52% reads as half-done. Reframe: drive the bar/label from the **current stage** ("Preparing", "Trimming", "Applying zoom", "Rendering", "Adding music", "Finishing") rather than a raw percentage, so a 50% start reads as "early stage, lots left" not "halfway."
6. **Crash diagnosis pass (bundled) — LOG FINDINGS ONLY.** Read `pipeline-{job_id}.log` + `render-timing-log.jsonl` for the 3 failed jobs; confirm whether exit 15 correlates with a duplicate spawn or a WSL memory event (the `%USERPROFILE%\.wslconfig memory=12GB` guard exists). **Write findings to the batch notes only — do NOT implement additional fixes here unless the cause is directly a duplicate spawn (already covered by item 3).** The single-job guard above is the primary mitigation; anything else discovered becomes a separate, scoped backlog item rather than scope creep in U1.

**Verify:** Start a 4K render, navigate Library→back at ~50%; timer and stage continue correctly. Re-enter while running → no second job spawns (`get_active_job` returns the same id). Kill the pipeline (simulate SIGTERM) → error screen offers retry that reuses proxies (confirm `proxy_skip=N/N` in next run's log). Run `render.spec.ts` (fast + render suites) per `.claude/rules/e2e.md`.

---

## Batch U2 — Clip reorder on the film timeline — COMPLETE (2026-06-07)

**Problem:** Clips can only be reordered on the separate `Review.tsx` page, not on the `StickyFilmStrip` shown across Trimmer/Arrange. The founder wants press-hold-drag reordering directly on the film timeline.

**Reuse what exists:**
- `reorder_clips_cmd` ([lib.rs:884](src-tauri/src/lib.rs:884)) already reassigns `clips.sort_order` ([db.rs:53](src-tauri/src/db.rs:53)) by array index.
- `Review.tsx` ([src/components/review/ClipNavStrip.tsx](src/components/review/ClipNavStrip.tsx)) already implements `@dnd-kit` drag-to-reorder — proven pattern to port.

**Changes:**
- Add drag-to-reorder to `StickyFilmStrip.tsx` (currently `draggable={false}` [StickyFilmStrip.tsx:400](src/components/StickyFilmStrip.tsx:400), only swipe-to-delete). Introduce a press-and-hold drag that reorders `inFilm` tiles, distinct from the existing left-drag-to-pan and swipe-left-delete gestures (gesture-disambiguation is the main design care here).
- On drop, call `reorder_clips_cmd` with the new id order, then refresh clips. Since `StickyFilmStrip` is shared, reorder works on every editor screen.
- Keep the existing pan/zoom/delete interactions working — guard by drag distance/direction + a hold threshold.

**Verify:** On Trimmer and Arrange, drag a clip to a new position; confirm `sort_order` persists (re-enter screen, order holds) and the rendered film respects the new order. Extend an E2E spec (gap-editor or a new `reorder.spec.ts`) asserting order after a programmatic reorder.

---

## Batch U3 — Arrange zoom-tab correctness (U3a COMPLETE 2026-06-07; U3b pending)

Several distinct issues on the zoom tab; group as one correctness batch. **This is the heaviest single batch (6 items). Bail-out option if execution loses coherence mid-batch:** split at the natural seam — **U3a = data correctness** (items 1–3: phantom clips, focal-on-fixed-zoom, zoom timing) vs **U3b = playback UX** (items 4–6: seek/pause-play state, click-to-play, focal-indicator visibility). Not required up front; only split if it starts dragging.

1. **"Two phantom clips at the front" bug (investigate + fix).**
   - Symptom: entering the zoom tab the first time shows two extra/duplicate tiles at the front of the queue; removable without side effects.
   - **Start with a `sort_order` integrity check** — this is the ~80%-likely cause: query the project's clips and look for duplicate/`NULL`/`0` `sort_order` values that would sort to the front in `inFilm` ([Arrange.tsx:162](src/pages/Arrange.tsx:162)). If found, that's the bug — fix the write path that leaves collisions and normalize existing rows.
   - Only if `sort_order` is clean, fall back to the secondary hypotheses: (b) React key collision rendering duplicate tiles; (c) a stale `projectCache` seed ([Arrange.tsx:111](src/pages/Arrange.tsx:111), [src/utils/projectCache.ts](src/utils/projectCache.ts)) from a prior project showing briefly before `get_project` resolves. Reproduce live (CDP) to confirm before coding.

2. **Focal point ignored on FIXED zoom.**
   - Both the preview transform ([Arrange.tsx:729](src/pages/Arrange.tsx:729)) and `zoom.py` static crop ([pipeline/zoom.py:190](pipeline/zoom.py:190)) *look* focal-aware, so the bug is most likely in **persistence/read**: confirm `focal_x`/`focal_y` are saved when zoom mode is "fixed" (the save path may only write focal on gradual) and that they reach the manifest → `render.py` → `zoom.py`. Fix the gap; do a real fixed-zoom render and confirm the crop is offset.

3. **Zoom preview timing.**
   - Preview animation is hardcoded `rc-kenburns 4s` ([Arrange.tsx:280](src/pages/Arrange.tsx:280), also `restartZoomAnim` ~490). Backend timing is already correct (`_KB_SPEED_FRAC` slow=1.0/med=0.75/fast=0.5 of trimmed duration, [pipeline/zoom.py:40](pipeline/zoom.py:40)). Drive the preview duration from the **trimmed clip duration × speed fraction** so an 8s slow clip reaches final zoom at 8s, med at 6s, fast at 4s — matching the render.

4. **Zoom preview state on seek / pause-play (stutter + reset).**
   - Today the CSS animation fires on mount regardless of playback and restarts from 1× on each play ([Arrange.tsx:257](src/pages/Arrange.tsx:257), `togglePlay`→`restartZoomAnim`). Sync the zoom transform to the **current playhead**: on seek, compute zoom progress at that time and apply it directly; on pause, hold current scale; on resume, continue from there rather than resetting to 1×. Removes the "runs immediately / sticks on end-state / re-runs each play" loop.

5. **Play-on-click on the preview video** (zoom tab + sound tab).
   - `Sound.tsx` mixer already does this ([Sound.tsx:971](src/pages/Sound.tsx:971)); Arrange zoom/sound videos have no click-to-play ([Arrange.tsx:735](src/pages/Arrange.tsx:735), [Arrange.tsx:1414](src/pages/Arrange.tsx:1414)). Add `onClick → togglePlay` (without breaking focal-point drag — only when not dragging).

6. **Focal-point picker visibility.**
   - Enlarge the orange focal indicator (currently `w-4`/`w-5`, [Arrange.tsx:752](src/pages/Arrange.tsx:752), [Arrange.tsx:947](src/pages/Arrange.tsx:947)) and improve contrast. Per founder: replace the live thumbnail background in the small picker with a **static neutral/contrast background** (the coordinate is what matters, not the frame). Use the existing-but-unused `rc-focal-pulse` keyframe ([src/globals.css:16](src/globals.css:16)).

**Verify:** Reproduce phantom-clip bug pre-fix, confirm gone post-fix. Render one fixed-zoom clip with an off-center focal point; confirm crop offset in output. Preview timing matches render for slow/med/fast. Seek/pause/play no longer resets zoom. Click video to play on both tabs. `pnpm test:e2e:editor` green.

---

## Batch U3c — Post-U3 render regressions — COMPLETE (2026-06-08, zoom fix shipped)

- **U3c-2 (card eats clips) — CLOSED, fixed-by-U1b.** Fresh 1080p cold render: card xfade at offset=1.5030s → clip 1 begins at t≈3s. No swallowed clips. Confirmed `aevalsrc=...:s=48000`, segmented path, `drift=0`.
- **U3c-4 (GPU TDR freeze) — CLOSED, fixed-by-U1b.** Was a consequence of playing the corrupt 06-06 monolithic-fallback file. All 08-06 renders are clean H.264; no playback anomalies.
- **U3c-1 (Ken Burns focal drift) — CLOSED, fixed in `pipeline/zoom.py` + `render.py`.** Root cause: FFmpeg `crop` filter latches `iw`/`ih` at the first frame from `scale=eval=frame` output, never updating it as zoom changes. `dir=in` (zf=1 at t=0) → `iw_latched=src_w=out_w` → x=0 for entire clip (always top-left). `dir=out` (zf=ratio at t=0) → x overflows valid range as zoom shrinks → rightward drift then hard-left snap. Fix: substitute Python-constant source dimensions with the same `zf(t)` expression in the crop origin; bump `_KENBURNS_CACHE_VER = "2"` to invalidate stale cached zoom files. User confirmed fix: zoom-in now holds focal, zoom-out starts at focal and reveals full frame. 9/9 E2E fast PASS.
- **U3c-3 (8-min render) — remains U4 scope.** Owned by Batch U4 (bg zoom pre-cache).
- **Backlog — wipeleft/shuffle transition grain artifact:** xfade blends both clips at the wipe edge; DJI source noise doubles up at the 50/50 blend midpoint, creating a "snowy" appearance. Future batch on transition quality (separate from U3b).

**Next after U3c:** U3b (zoom-tab playback UX, items 4-6), then U4 (bg zoom pre-cache / 8-min render), then U5a/b.

Four issues logged after the first U3a render. They split cleanly: **U3c-1 + U3c-2 are render-correctness bugs** (new, not covered anywhere); **U3c-3 maps to existing U4** (zoom pre-cache); **U3c-4 is a downstream consequence** of U3c-1, not an independent code fix. All four are **LOGS-FIRST** — the pipeline already emits the exact lines needed to confirm root cause before touching code. Do **not** write fixes until the relevant log line from the *corrupt first render* is read.

**Priority order (confirmed 2026-06-07): U3c → U3b → U4.** U3c fixes broken render *output* (correctness); U3b is zoom-preview *UX* polish; U4 is render-time perf. Do not polish the preview interaction (U3b) while the render output is still wrong. U4 absorbs bug U3c-3 and rises in priority now that the 8-min render is a confirmed live pain point.

**Diagnose ≠ fix (process guard):** The diagnostic pass (reading the logs below) must end with **root cause pinned + a one-line fix spec per item** — NOT a code change in the same session. The actual fix is a separate, APPROVED-gated session. This matters most for U3c-1: the Ken Burns math is non-trivial and a rushed fix bundled with the diagnosis is a regression risk.

**Pinned logs (pulled 2026-06-07) — see `## U3c pinned log evidence` at the bottom of this file** so the fix session starts cold-free.

### U3c-1 — Gradual (Ken Burns) zoom drifts to top-left + distorts proportions [render-correctness, HIGH]

**Symptom:** Gradual zoom clips anchor the zoom at the top-left corner and the frame looks stretched/letterboxed — survives a re-render, so it is in the render output, not just the CSS preview.

**Findings (code read):**
- The Ken Burns math in [`_kenburns_vf` (pipeline/zoom.py:105)](pipeline/zoom.py:105) is **algebraically focal-correct**: focal point lands at fractional `fx`/`fy` for every frame (scale-up-by-`zf` then constant-crop telescopes the focal to a fixed screen position). `zf = 1+(z-1)*P` is constructed to stay `>= 1` so the scaled frame is never smaller than the crop window.
- Therefore the two realistic root causes are: **(a)** focal reaches `apply_zoom` as `(0,0)` for the gradual path (would pin top-left exactly), or **(b)** the "scaled smaller than crop window" guard is being violated in practice (FFmpeg clamps the crop origin to 0,0 and stretches — the docstring at [zoom.py:116](pipeline/zoom.py:116) names this exact failure mode).
- Focal persistence in [`saveReview` (Arrange.tsx:399)](src/pages/Arrange.tsx:399) writes `focal_x/focal_y` via `update_clip_review_cmd` independent of zoom mode, and DB columns default NULL → `0.5` (centre) in zoom.py. So a *clean* path should NOT produce `(0,0)`. The leak is most likely a `0.0` default injected in the manifest build (`run.py`) or a focal not saved when only `zoom_mode` is changed (focal stays NULL but some default coerces to 0).

**Logs-first step (mandatory, do before any code):**
- Read `[zoom] kenburns ... focal=(%.2f,%.2f)` from the corrupt render's `pipeline-{job_id}.log`. This line already prints the exact focal value the gradual path received.
  - If it shows `focal=(0.00,0.00)` → it is cause (a): trace `focal_x/focal_y` back through `render.py` `_zoom_worker` ([render.py:521](pipeline/render.py:521)) → manifest → `run.py` and fix the `0.0` default / save gap so NULL → 0.5.
  - If it shows the correct focal (e.g. `0.50,0.50` or the user's value) → it is cause (b): the FFmpeg crop is clamping. Add a one-frame `iw/ih` vs `ow/oh` assert/log inside the gradual encode and confirm `2*trunc(iw*zf/2) >= out_w` holds at `t=0` for both `in` and `out` directions; fix the rounding so the scaled frame is always `>=` the crop window.

**Verify:** One real gradual-zoom render (slow + a zoom-out clip), off-centre focal, at BOTH 1080p and 4K (per `.claude/rules/` 4K rule). Visual frame check at t=0/mid/end shows the focal point held stationary, no top-left snap, no stretch. Confirm `[zoom] kenburns focal=` matches the user's set focal.

### U3c-2 — Intro card "eats" the first 1-2 clips (~10-11s before real film) [render-correctness, HIGH]

**Symptom:** With an intro card enabled, the card frame stays on screen ~10-11s and the first 1-2 clips are swallowed. **Only on the first render** — a re-render of the same project starts normally (slight clip-1→2 stagger aside).

**Findings (code read):**
- The intro card is prepended to `current_paths` at [render.py:620](pipeline/render.py:620) as clip 0 (`make_card`, fixed `duration_s=3.0`, [render.py:611](pipeline/render.py:611)) **before** the segmented-xfade decision. So with an xfade transition the card enters the U1g segmented path as clip index 0.
- The segmented path [`_render_segmented` (render.py:766)](pipeline/render.py:766) plans batches and frame counts from `durations = [get_duration(p) for p in current_paths]` over the **global frame grid**. If `durations[0]` (card) or the early clip durations are misread on the first render, the batch plan / `-frames:v` counts shift and early clips get overrun by the card segment.
- **First-vs-re-render differentiator = the proxy/zoom cache.** First render: clips with no warm proxy go through normalise and clips with zoom are encoded fresh; re-render: everything is cached. The plausible mechanisms are (i) the segmented planner raised and **fell back to monolithic** on the first render (the monolithic prepended-card + xfade path is the older, less-tested one), or (ii) a duration probe on a freshly-encoded (not yet flushed/cached) early clip returned a wrong value feeding `plan_video_batches`.

**Logs-first step (mandatory, do before any code):**
- Read the first render's `pipeline-{job_id}.log` and check for:
  - `[U1g] segmented render failed (...) -- falling back to monolithic` ([render.py:907](pipeline/render.py:907)) → confirms mechanism (i); fix the monolithic prepended-card path or make the card exempt from the planner.
  - The `[U1g] batch i/N clips [...] start=.. frames=.. (global [..,..])` lines ([render.py:848](pipeline/render.py:848)) and the per-clip `durations` → compare card duration and clip-0/1 frame counts against the re-render's log (which works). The drift is in whichever value differs.
- Do not assume — the two logs (broken first render vs clean re-render) side-by-side will name the exact stage.

**Verify:** Enable an intro card on a fresh project (cold proxies), render; card shows ~3s then clip 1 begins on time, no swallowed clips. Re-render confirms parity. Check both the segmented (>4 clips, xfade) and monolithic (<=4 clips or `none`) paths.

### U3c-3 — 8+ min render triggers the stall warning despite warm proxies [perf → already U4]

**Symptom:** Render runs 8+ min — long enough to trip the U1e stall warning (120s no-progress) — even though proxy generation already ran. Waiting it out completes successfully.

**Findings:** This is the **zoom stage computed at render time** on a zoom-heavy film. Proxies skip normalise, but per-clip zoom is still encoded during the render unless the zoom cache is warm. **This is exactly what [Batch U4 — Background zoom pre-cache](#batch-u4--background-zoom-pre-cache-frontload-the-long-render) targets** — no new batch needed; U4 is the fix. Bump U4 priority given this is now a confirmed live pain point.
- **Bundled U1e tuning (small):** the 120s stall threshold is too aggressive for a legitimately long zoom-stage render. Consider raising the threshold or suppressing the warning while `STAGE:zoom`/`STAGE:Rendering` is actively advancing (progress moved within the window) so a slow-but-healthy render doesn't false-alarm. Scope this into U4 or a tiny U1e patch.

**Verify:** (Covered by U4) After warming the zoom cache in the background, a re-render shows `zoom_cache_hits=N/N` in `ANALYSIS:` and zoom-stage time drops to near-zero; no stall warning fires.

### U3c-4 — Playback freezes the PC / black screen / nightlight resets [downstream of U3c-1/2]

**Symptom:** Playing the specific corrupt first-render file freezes the machine for several seconds, the whole screen goes black (twice), and Windows night-light resets to daylight.

**Findings:** Black-screen + night-light reset is a **GPU driver TDR (Timeout Detection & Recovery) event** — the display driver restarting — triggered by WebView2/Media Foundation trying to decode a malformed/odd-dimensioned render. It is a **consequence of the corrupt output from U3c-1/U3c-2**, not an independent RushCut code bug. Fixing U3c-1 and U3c-2 should make it disappear.
- **Optional hardening (defensive, low priority):** validate the final render with `ffprobe` (reuse the `is_valid_proxy` pattern) before the Render screen presents it, so a future malformed output surfaces as an error toast instead of a driver crash. Park as backlog unless it recurs after U3c-1/2 land.

**Action:** No standalone fix. Discard the corrupt render file. Re-verify after U3c-1 + U3c-2 ship.

---

## Batch U4 — Background zoom pre-cache (frontload the long render)

**Problem:** The 4K render was slow largely because zoom was applied to most clips and computed at render time. Zoom is the natural next frontloading target after proxies.

**Reuse:** `render.py` already writes a per-clip zoom cache at `%TEMP%\rushcut\zoom-cache` keyed by sha1 of `(src, size, in_ms, out_ms, zoom_mode, focal_x, focal_y, output_resolution)` ([pipeline/render.py:171](pipeline/render.py:171), [render.py:497](pipeline/render.py:497)). Proxy frontloading already has the full pattern: `generate_proxies_cmd` → `run_bg_proxy_batch` → `claim_clip_for_encoding` atomic claim ([lib.rs:1378](src-tauri/src/lib.rs:1378)), low-priority worker, concurrency guard.

**Pre-flight (do this first):** read `run_bg_proxy_batch` + `claim_clip_for_encoding` ([lib.rs:1378](src-tauri/src/lib.rs:1378) onward) and confirm the atomic-claim discipline is clean *before* cloning it. We're about to inherit this pattern wholesale — if the proxy frontload cut any corners (claim/release races, missing time-guard, non-atomic status writes), fix or note them so U4 doesn't propagate the debt. Only proceed to the changes below once the pattern is confirmed sound.

**Changes:**
- Add a background "warm zoom cache" job, mirroring the proxy frontload architecture: a Rust command + low-priority batch that, for each `include=1` clip with a zoom set, runs the same FFmpeg zoom step `render.py` would, writing into the existing cache dir with the existing key.
- Trigger fire-and-forget when the user leaves the zoom tab / Arrange screen (mirrors Trimmer-unmount proxy trigger). Priority order: proxies > zoom (founder's ranking: proxy → trims → transitions → zoom → sound).
- Because the cache key includes `in_ms`/`out_ms`/focal/zoom params, stale entries are naturally bypassed if the user changes trims/zoom — at worst the warm work is wasted, never wrong (0s downside, as the founder noted).
- Respect the two-binaries-share-one-DB safety: reuse the same atomic-claim discipline so a WDIO run or the other instance can't double-encode.

**Verify:** Set zoom on several clips, leave the zoom tab, watch `proxy-bg.log`/a new zoom-bg log fill. Then render → confirm `zoom_cache_hits` in `ANALYSIS:`/`render-timing-log.jsonl` and a markedly lower zoom-stage time. Check BOTH 1080p and 4K (per `.claude/rules/` 4K rule).

---

## Batch U5 — Trim screen playback & responsiveness

The founder's largest UX friction cluster, on the screen they spend the most time in. **Split into U5a and U5b** to shrink the regression surface — five interrelated changes to seek/playback at once would make any regression hard to bisect. Ship and verify U5a fully before starting U5b.

### Batch U5a — Seek responsiveness + handle-drag behavior (the interrelated core)

1. **Seek/playback responsiveness.**
   - Clicking to seek should start playback immediately with the playhead moving at once. The frame-reveal gate (`gateFrameRevealThen`, up to 30 rVFC frames, [Trimmer.tsx:375](src/pages/Trimmer.tsx:375)) adds deliberate latency to avoid frame-0 flash. Tune: lower `MAX_WAITS`/tolerance or skip the gate for same-clip seeks (only needed on cross-clip src swaps) so in-clip seeks are instant.

2. **Stutter on next-clip / play / click.**
   - `advanceFilmClip` blocks on a fresh `loadIntoSlot` when the next slot wasn't preloaded ([Trimmer.tsx:517](src/pages/Trimmer.tsx:517)). Preload the next clip earlier / widen the preload window to eliminate the hitch.

3. **Handle drag should not reset playback; clicking a handle should seek.**
   - Today both in/out handle drags immediately set `currentTime` ([TrimBar.tsx:81](src/components/trimmer/TrimBar.tsx:81)→[Trimmer.tsx:291](src/pages/Trimmer.tsx:291)). Change: dragging a handle updates the marker only (no seek/reset); a **click** on the left handle seeks playback there (preserve current click-to-play-from-here behavior).

**Verify U5a:** Click-seek starts playback instantly; switching clips is smooth; dragging handles doesn't jump the playhead but clicking the left handle does. Run trimmer + fast E2E suites; confirm no regression before U5b.

### Batch U5b — Playback range + film nav (independent additions)

4. **Play outside the trimmed region.**
   - The `onTimeUpdate` clamp loops playback back to `inMs` at `outMs` ([Trimmer.tsx:812](src/pages/Trimmer.tsx:812)). Allow free playback across the whole clip; keep the in/out markers purely as the cut boundary, not a playback cage.

5. **Prev/next film-nav buttons on the trim screen.**
   - Trimmer's top-right nav iterates **source** clips ([Trimmer.tsx:684](src/pages/Trimmer.tsx:684), `handleNav` 232). Add Arrange-style prev/next over **film** clips (pattern at [Arrange.tsx:689](src/pages/Arrange.tsx:689)/`prevClip`/`nextClip`), positioned like the zoom tab's controls.

**Verify U5b:** Playback runs past the out-marker; film prev/next works. Run trimmer + fast E2E suites.

---

## Batch U6 — Music master-tab preview (seek + loop)

1. **Music drops out on backward seek / past track end.**
   - In `Sound.tsx` master tab, `ma.loop=false` is hardcoded ([Sound.tsx:470](src/pages/Sound.tsx:470), [Sound.tsx:553](src/pages/Sound.tsx:553)); seeking past the (shorter) track end or backward leaves the `<audio>` in `ended`/stopped state, requiring pause+play. Fix the seek-sync ([Sound.tsx:542](src/pages/Sound.tsx:542)) to recompute the correct music position (modulo track duration when looping) and resume cleanly without a manual pause+play.

2. **Loop on/off control + audible loop in preview.**
   - Add a loop toggle in the music tab UI and persist it (it must thread to the pipeline — the render already loops via `_compute_copies` + `acrossfade` in `music.py`; today it always loops). Make the master-tab preview honor the toggle: when looping, set `ma.loop=true` (or re-seek to 0 on `ended`) so the founder can actually hear the loop behavior they'll get in the render.

**Verify:** With a track shorter than the film, seek backward mid-playback → music continues. Toggle loop off → music stops at track end in preview and render. Toggle on → audible seamless loop. Run sound E2E suite.

---

## Backlog (deferred — discuss before scheduling)

- **Dual-screen compare previewer** (trim screen): toggleable 50/50 side-by-side clip comparison (DaVinci-style) for matching adjacent angles. Largest new feature.
- **Trim film-tab clip edge drag**: drag clip edges to lengthen/shorten with green (extension available) / red (at source bounds) feedback; inward shorten always allowed. (`StickyFilmStrip` tiles currently have no resize handles.)
- **Drag-region-to-timeline**: drag a trimmed in/out region down onto the film timeline as an alternative to the "+ Add to Film" button ([Trimmer.tsx:699](src/pages/Trimmer.tsx:699), backed by `add_clip_cut_cmd` [lib.rs:921](src-tauri/src/lib.rs:921)).
- **Upload speed (20 clips ~30s)**: parallelize per-file `ffprobe` (currently sequential, [lib.rs:976](src-tauri/src/lib.rs:976)) and batch the per-clip DB inserts (`create_project` loop, [lib.rs:1007](src-tauri/src/lib.rs:1007)).
- **Speculative full-segment pre-render** (beyond zoom cache): pre-build normalised+trimmed+zoomed per-clip segments so final render is mostly concat+music. Higher payoff, higher invalidation complexity — revisit after U4 proves the frontload pattern.

---

## Cross-cutting notes
- Follow `.claude/rules/e2e.md`: run WDIO from PowerShell, never mix `preview_*`/chrome-devtools MCP in a session that runs E2E (port 9222 conflict).
- Per `.claude/rules/`: any pipeline change must be checked at **both** 1080p and 4K, and any displayed value (stage labels, zoom names, loop state) checked across all cross-screen display sites.
- DB migrations (U1 `current_stage`) are additive; the running app holds the DB in WAL mode — verify via `invoke` commands, not an external sqlite3 process.

---

## U3c pinned log evidence (pulled 2026-06-07)

Logs read from `%TEMP%\rushcut\pipeline-{job_id}.log`. Project in all of them: **Stagecoach 2025** (21 clips, 4K, intro card "Stagecoach 2025" + outro "The End", music=cinematic).

| job_id | when | result | aevalsrc | path |
|--------|------|--------|----------|------|
| `75ec577a` | 06-06 19:40 | **FAILED → monolithic fallback** | `r=48000` (broken) | segmented errored, fell back |
| `7fcf4862` | 06-06 18:32 | fallback | `r=` (broken) | same |
| `e54ef29d` | 07-06 11:52 | clean, completed | `s=48000` (fixed) | segmented, drift=0 |
| `b31c27c5` | 07-06 22:25 | clean, completed | `s=48000` | segmented, drift=0 |
| `578af14d` | 07-06 23:20 | clean, completed | `s=48000` | segmented, drift=0 |

### U3c-2 / U3c-1 / U3c-4 — REASSESSED: bugs 1, 2 (and possibly 4) trace to the now-FIXED `aevalsrc r=` bug

- **Smoking gun (job `75ec577a`, line 239):** `Error applying option 'r' to filter 'aevalsrc': Option not found` → `Error parsing global options` → `) -- falling back to monolithic`. The segmented audio builder (`build_audio_only_fc` in `transitions.py`) emitted `aevalsrc=...:r=48000`; FFmpeg 6.1.1 only accepts `s=` (this is a documented rule in CLAUDE.md/pipeline.md).
- **The fix already landed (U1b "aevalsrc r=→s="):** every 07-06 log shows `aevalsrc=...:s=48000` and a clean segmented render (`drift=0`, `Pipeline complete`). The `r=` occurrences in `build_audio_only_fc` were the segmented path's copy that U1b's earlier pass missed; they are now `s=`.
- **This explains "first render corrupt, re-render clean" exactly:** the corrupt render was a **06-06 monolithic fallback** (triggered by the `r=` failure); the clean re-render was a **07-06 segmented** render after the `s=` fix. The card "eating clips for 10-11s" + the **GPU-TDR freeze on playback (bug 2)** are most consistent with playing that one malformed monolithic-fallback file — the decoder choked at the start and the player froze on the card frame during driver recovery, not a 10s card.
- **Action:** Before any code, the founder should **re-test on a fresh 07-06+ render** of a card+zoom project. Strong prior: bugs 1, 2 no longer reproduce. If they DON'T reproduce → close U3c-2 and U3c-4 as fixed-by-U1b; keep only the optional `ffprobe`-validate-output hardening as backlog. If they DO still reproduce on a fresh segmented render → real residual bug, capture that new job_id's log and diagnose the monolithic prepended-card path (still used for ≤4-clip / `none` / open-close projects).

### U3c-1 — gradual zoom focal LEAK ELIMINATED; render filter proven correct; suspect shifts to PREVIEW

- **Focal reaches the gradual path correctly (job `e54ef29d`, lines 213–216):** `kenburns dir=in ratio=1.5x ... focal=(0.23,0.65)` → generated filter `crop=3840:2160:'(iw-ow)*0.2251':'(ih-oh)*0.6515'`. Focal values are the user's off-centre coords, **not (0,0)**. Cause (a) (focal defaulting to 0,0 → top-left) is **eliminated**.
- **Filter math is correct for `dir=in`:** at t=0 `zf=1` → `scale=3840x2160`, `crop` offset `(3840-3840)*fx = 0` (whole frame, no zoom); as `zf` grows the focal telescopes to a fixed fractional position. No top-left snap in the render for zoom-in. All kenburns clips in the logs are `dir=in`.
- **Preview is the prime remaining suspect:** `@keyframes rc-kenburns` ([globals.css:107](src/globals.css:107)) animates **only** `transform: scale()` and sets **no `transform-origin`** — it relies on the inline `wrap.style.transformOrigin = "fx% fy%"` from [Arrange.tsx:297](src/pages/Arrange.tsx:297). If that inline origin isn't reliably applied to the gradual wrapper (U3a item 2a fixed this for the *non-gradual* branch only), CSS falls back to `50% 50%` — and any object-fit / wrapper-size mismatch under `scale()` can read as "drifts off + distorts." This is a **preview-only** defect; the render is fine.
- **Decisive fix-session test (not now):** one fresh single-clip gradual render — `dir=in` AND a `dir=out` clip — with an off-centre focal, at 1080p and 4K. Visual frame check at t=0/mid/end: render should hold focal stationary. Then inspect the Arrange preview transform-origin live. Fix whichever (almost certainly the preview). Do NOT touch the comma-free Ken Burns math unless a `dir=out` render visibly fails.

### Fix-spec summary (one line each, for the APPROVED-gated fix session)
- **U3c-1:** Set `transform-origin: var(--kb-fx) var(--kb-fy)` on the gradual preview wrapper reliably (or in the keyframe); verify render with a `dir=out` clip. (Render likely already correct.)
- **U3c-2:** Likely already fixed by U1b `aevalsrc s=`; confirm via fresh render, else fix monolithic prepended-card offsets.
- **U3c-3:** Build U4 (background zoom pre-cache) + soften U1e 120s stall threshold while a stage is actively progressing.
- **U3c-4:** No code; discard the corrupt 06-06 file. Optional: `ffprobe`-validate render output before the Render screen presents it.

### U3c fix-session structure — MANDATORY: verify-first, code-second (the next session starts here)

**Step 1 is a render, not code.** Do not write a line until the fresh render is inspected.

1. **Run one fresh render** of a card + gradual-zoom project. **Must include at least one `dir=out` (zoom-out) gradual clip** — the pinned logs only exercised `dir=in`, so zoom-out is untested in the render path. Card (intro) on, music on, 4K. Pre-flight per CLAUDE.md (memory ≥4 GB, proxies warm). After it completes, read the new `pipeline-{job_id}.log`.
2. **Check bugs 1 + 2** on that fresh segmented render: card shows ~3s then clip 1 on time (no swallowed clips); the file plays without freezing the desktop. If both are clean → **close U3c-2 and U3c-4, no code.** (Expected outcome — the `aevalsrc s=` fix is already in.)
3. **Check bug 4 — render output vs preview, separately:**
   - If the **render output** holds the focal point stationary for BOTH `dir=in` and `dir=out` (visual frame check at t=0 / mid / end) → render is correct, do NOT touch the Ken Burns math.
   - If the **Arrange preview** still drifts top-left while the render is correct → apply the one-line U3c-1 fix: give the gradual wrapper a reliable `transform-origin` at the focal point (the `rc-kenburns` keyframe sets only `scale()`).
   - If the **render output itself** drifts on `dir=out` → real residual; capture that job_id's `[zoom] kenburns` line + generated `crop` filter and diagnose the `dir=out` branch before coding.
4. **APPROVED gate → commit.** Run fast E2E (`pnpm test:e2e`) + `pnpm test:e2e:editor` per `.claude/rules/e2e.md`. Expected total scope: 0–1 small frontend changes. Should be a sub-hour session.

**If U3c closes with no/one change:** next priority is **U3b** (zoom-preview playback UX: click-to-play, playhead-synced zoom, larger focal indicator), then **U4** (background zoom pre-cache — absorbs the 8-min render pain, U3c-3).
