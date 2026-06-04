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

## Batch U1 — Render resilience & resume (UNBLOCK) — HIGHEST PRIORITY

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

## Batch U2 — Clip reorder on the film timeline (TOP-PRIO FEATURE)

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

## Batch U3 — Arrange zoom-tab correctness

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
