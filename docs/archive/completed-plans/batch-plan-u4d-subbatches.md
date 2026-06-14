# RushCut — Batch U4d+ Sub-batches

## Context

U4c shipped (2026-06-12): U1g NTFS volatility fix verified. The real-world Stagecoach 2025
render produced the first hard timing data for a 21-clip 4K film:

| Stage | Time |
|---|---|
| Zoom (18/19 clips cold) | **429s (7.15 min)** |
| Render (7 U1g batches, libx264 medium, 40Mbps) | **615s (10.25 min)** |
| Normalise (19 proxies) | 23s |
| Pre-trim + music + concat | 47s |
| **Total** | **1114s (18.6 min)** |

Two structural bottlenecks — zoom cold cache and render bitrate/encoder — dominate.
These batches attack them in order of impact.

U1f (bg proxy `-threads 0`) was already shipped and verified live — do not re-include.

---

## Priority order

1. **U4d** — Proactive zoom warm (7-min saving, React-only, fastest to ship)
2. **U4e** — AMF auto-enable + bitrate 40M→15M (10-min saving, pipeline-only)
3. **U4f** — Dynamic stall threshold (stops false-positive crash screens)
4. **U4g** — Cancel in-progress render (UX, pairs with stall warning)
5. **U4h** — Temp folder cleanup (housekeeping, prevents disk fill)
6. **U5a** — TrimBar click-to-seek (existing plan, no change)
7. **U5b** — Waveform overlay improvements (existing plan, no change)

---

## Batch U4d — Proactive zoom warm trigger

**Problem:** U4's three-tier warm trigger (zoom-tab-leave, param-edit debounce, Arrange unmount)
is entirely reactive — it only fires if the user visits the Zoom tab in that session.
On the Stagecoach render, the zoom tab was skipped → 18/19 clips missed the cache → 429s cold
zoom → stall alert → user saw crash screen even though the pipeline completed.

**Fix:** Add two proactive trigger sites that fire warm_zoom regardless of navigation path:
1. **Arrange mount** — on entry to `/arrange/:projectId`, check if any included clip has a
   non-null `zoom_mode`. If yes, call `warm_zoom_cache_cmd` immediately (BELOW_NORMAL priority
   via Rust). This covers "user returns to Arrange for a re-render" without opening Zoom tab.
2. **Render screen pre-submit** — in `submitJob()`, before `invoke("start_job", ...)`, check
   if any clip has `zoom_mode` and the zoom cache is likely cold (use a lightweight proxy: check
   if `warm_zoom_cache_cmd` has been fired for this project in this session via a React ref).
   If cold, fire `warm_zoom_cache_cmd` and proceed immediately — don't gate the render on it
   (render can still start; zoom cache warms in parallel via BELOW_NORMAL WSL process).

**Scope:** `src/pages/Arrange.tsx` (new mount effect) + `src/pages/Render.tsx` (pre-submit warm).
No Rust changes — `warm_zoom_cache_cmd` already exists and accepts the same manifest.

**Implementation:**
1. In `Arrange.tsx`, add a `useEffect([projectId])` that runs on mount. Read `clips` state (or
   wait for `get_project` to resolve). If any clip has `zoom_mode != null`, call
   `invoke("warm_zoom_cache_cmd", { projectId })`. Guard with a session-level ref
   (`warmFiredRef`) so it only fires once per Arrange session (not on every tab-switch re-mount).
2. In `Render.tsx`, inside `submitJob()` just before `await invoke("start_job", ...)`, if
   `inFilmCount > 0` call `invoke("warm_zoom_cache_cmd", { projectId })` fire-and-forget.
   No await — the render proceeds in parallel; zoom will be warm on the NEXT render, and on
   this render anything that was already warm (prior session) hits the cache.
3. Both sites are fire-and-forget — no spinner, no UI state. The Rust concurrency guard
   (`{project_id}:zoom` key) deduplicates if both fire within milliseconds of each other.

**Verify:** Open Stagecoach project, navigate directly to Render (skip Arrange entirely), click
Render. Check `zoom-bg.log` — warm job should fire immediately with all clips. On the *next*
render, `zoom_cache_hits` should equal the number of zoom clips.

---

## Batch U4e — Render bitrate 40M→15M + AMF auto-enable for 4K

**Problem:** The render step (615s for 19 clips 4K libx264 medium at 40Mbps) is the
dominant bottleneck even with warm zoom. Two levers exist already in `encoder.py` but are
under-utilised:

- **Bitrate:** 40Mbps is mastering-grade. Netflix 4K is 15-25Mbps; YouTube 4K is 15-35Mbps.
  15Mbps with libx264 medium is visually indistinguishable for drone footage. Lower bitrate
  means less data to write per frame → faster encode + smaller file → also fixes WebView2
  playback crash (795MB → ~280MB for the same film).
- **AMF (GPU encode):** Already built (Batch Q/R). Benchmarked ~51% faster than libx264 on
  this hardware. Currently opt-in only (UI toggle, user reverted auto-ON after feedback).
  The quality concern was B-frames (AMD ignores `-bf`) — acceptable trade-off for 15-20%
  quality loss vs 51% speed gain, especially at lower bitrate where visual quality is still high.

**Fix — two changes to `pipeline/encoder.py` only:**
1. Change `"-b:v", "40M"` → `"-b:v", "15M"` in the final-mode encode args for both the
   libx264 and AMF paths. Draft mode stays unchanged.
2. Make AMF the default for 4K renders: in `video_encoder_args()`, change the AMF detection
   logic so that when `output_resolution == "4k"` and AMF is detected, `use_amf=True`
   automatically (unless explicitly overridden). Keep the UI toggle to opt OUT (flip the
   toggle from "Fast render — ON/OFF" to "Standard quality" override).

**Expected outcome (combined):**
- libx264 + 15M: 615s → ~450s (~25% saving from bitrate alone)
- AMF + 15M: 615s → ~200-250s (~60% saving)
- With warm zoom: 450/250s + 50s other = **8 min (libx264) or 5 min (AMF)**

**Scope:** `pipeline/encoder.py` only for the bitrate change. `src/pages/Render.tsx` for the
toggle flip (opt-out of AMF instead of opt-in). `run.py` if `use_amf` default changes
need threading through (check — it may already pass through from `video_encoder_args`).

**Verify:**
1. Render Stagecoach (4K, zoom warm) and read `render-timing-log.jsonl`. Confirm:
   - `t_render_s` drops to <300s (AMF) or <500s (libx264)
   - `output_mb` drops to ~280MB or below
   - Output plays in WebView2 without crashing
2. Watch 30s of the output — verify visual quality acceptable (motion, sharpness).

---

## Batch U4f — Stage-aware stall threshold

**Problem:** The U1e stall detector uses a fixed 360s threshold across all pipeline stages.
The zoom stage on a cold 21-clip project takes ~430s — longer than the threshold. Even after
U4d (proactive warm) eliminates most cold-zoom cases, future cold scenarios (new project, fresh
install, cache cleared) will still trigger false stall alerts. The user saw a fake "Pipeline
timed out" screen while the pipeline was running fine.

**Fix:** Make the stall threshold stage-aware. When `STAGE: Applying zoom effects` is received
(via `pipeline-stage` event), extend `lastProgressAtRef.current` by the estimated maximum zoom
duration rather than just refreshing it. Estimate: `max_zoom_wait = clip_count * 60_000` (1 min
per clip at cold, conservative). Cap at 10 min.

**Changes (Render.tsx only):**
1. Track `currentStage` from `pipeline-stage` events (already partially available — `stageLabel`
   function exists). Add a ref `maxStallMs` (default: 360_000).
2. When `pipeline-stage` event fires with `stage === "zoom"` (or whatever string the pipeline
   emits for the zoom stage), set `maxStallMs = Math.max(360_000, inFilmCount * 60_000)`.
3. In the stall-check interval, use `maxStallMs` instead of the hardcoded `360_000`.
4. Reset `maxStallMs` back to `360_000` when phase leaves "rendering".

**Confirm the STAGE: string first:** grep `pipeline/run.py` for what zoom stage label is
emitted — likely `"Applying zoom effects"` — and match exactly in the React handler.

**Scope:** `src/pages/Render.tsx` only. No pipeline/Rust changes.

**Verify:** Start a render on a project with zoom and cold cache (clear zoom-cache dir first).
Confirm the stall warning does NOT appear during the zoom stage even if it takes >6 min. Confirm
it DOES appear if the pipeline actually dies (kill `run.py` manually after zoom).

---

## Batch U4g — Cancel in-progress render

**Problem:** Once a render starts, the user cannot stop it. The prime use case is a stalled or
wrong-settings render — user wants out but must wait (or force-quit the app). Pairs directly
with the U1e stall warning: the warning surfaces the problem but gives no escape beyond "Try Again"
which starts a NEW render while the old WSL process is still running.

**Fix:**
1. **UI:** In `Render.tsx`, add a "Cancel" button visible only while `phase === "rendering"`.
   Use `@tauri-apps/plugin-dialog` `confirm()` ("Cancel this render? Your clips are safe.").
   On confirm, call a new Rust command `cancel_render_cmd({ jobId })`.
2. **Rust:** `cancel_render_cmd` looks up the job's `wsl_pid` (a new nullable column on `jobs`
   stamped when `spawn()` fires). Sends `SIGTERM` to the WSL Python process via
   `wsl -d Ubuntu-24.04 kill -15 <pid>`. Then calls `update_job_error("Cancelled by user")`.
   Emits `pipeline-error` event so Render.tsx transitions to the error phase (with "Try Again").
3. **DB:** Add nullable `wsl_pid INTEGER` column to `jobs` (additive migration, same pattern
   as `current_stage`). Stamp it in `start_job` after `spawn()` via `child.id()`.
4. **Partial-output cleanup (EXPLICITLY IN SCOPE — do not assume).** SIGTERM on the pipeline can
   leave a half-written MP4 in `C:\clips\processed\<slug>-NN.mp4` (FFmpeg killed mid-mux → no moov
   atom, same corruption class as the proxy trap). `cancel_render_cmd` MUST delete the job's
   in-flight output file after the kill so no orphaned/corrupt render sits in `processed/` to
   confuse the next session. The output path is known at `start_job` time — record it (or derive
   it from the slug counter) so cancel can remove it. Also remove the job's `%TEMP%\rushcut\<job_id>\`
   working dir (overlaps U4h, but cancel should clean its own mess immediately, not wait for the prune).

**Open-in-player for 4K output (bundled — natural fit, touches the same Render screen + Rust layer):**
5. On render complete, for **4K** output replace/supplement the WebView2 `<video>` element with an
   "Open in player" button that opens the file in the system default player via
   `std::process::Command::new("explorer").arg(<output_path>)` (a new `open_in_player_cmd`, or reuse
   the existing `open_output_path` pattern — note that one does `/select,` to reveal in Explorer; this
   one should open the file itself, no `/select`). Keep the in-app `<video>` element for **1080p**
   output, where WebView2 decodes fine. Gate on `outputRes === "4k"`.
   - **Why:** permanently removes the WebView2 4K-decode ceiling (the crash U4e's VBR cap mitigated
     but did not eliminate). This completes the "system player" half of **V-series V1.5** — when this
     ships, cross that part off the roadmap, leaving only "raise bitrate to 25–35M" in V1.5 (which
     still depends on V1 clean-intermediate landing first).

**Scope:** `src/pages/Render.tsx`, `src-tauri/src/lib.rs`, `src-tauri/src/db.rs`.

**Design:** Per `docs/DESIGN.md` — secondary/destructive button style: `border border-white/30`
outlined, `text-[#e5e5e5]`. NOT peach (that's positive CTA). Label: "Cancel render".

**Verify:** Start a render, click "Cancel render", confirm dialog → pipeline log shows
SIGTERM, job row shows `status='error'`, Render screen shows error state with "Try Again".
Confirm a new render can be started immediately after cancel. **Confirm no partial/corrupt MP4 is
left in `C:\clips\processed\` after cancel** (the killed-mid-mux file must be deleted), and the
job's `%TEMP%\rushcut\<job_id>\` working dir is gone. For open-in-player: a 4K render shows the
"Open in player" button (not the `<video>`) and clicking it opens the file in the system default
player; a 1080p render still shows the in-app `<video>`.

---

## Batch U4h — Temp folder cleanup

**Problem:** `%TEMP%\rushcut\<job_id>\` accumulates per-render artifacts permanently. U4c moved
U1g segments to NTFS (correct for durability) but now each 21-clip 4K render leaves ~500MB of
segment files that never get cleaned. After 10 renders: ~5GB of orphaned intermediates.

**Policy (founder-defined):** Delete on project delete; 7-day prune for orphans.

**Fix:**
1. **On project delete** (`delete_project_cmd` in `lib.rs`): after deleting DB rows, look up all
   `job_id` values for the project from `jobs` table (before deleting them). For each, call
   `std::fs::remove_dir_all(temp_dir.join(job_id))` (non-fatal — log error if missing).
2. **Startup prune** (`setup()` in `lib.rs`): enumerate `%TEMP%\rushcut\` for UUID-named
   subdirectories whose `mtime` is older than 7 days. Delete them. Run after
   `reset_all_encoding_claims` (same startup window). Non-fatal — wrap in a `spawn`.
3. **Exclusions:** Do NOT prune `zoom-cache\` (owns its own 2-day prune), `*.log` files (small,
   useful for debugging), `*.json` manifest files (small, already timestamped).

**Scope:** `src-tauri/src/lib.rs` only. No UI change.

**Verify:** Render once, confirm `%TEMP%\rushcut\<job_id>\` exists. Delete the project from
Library. Confirm the job dir is gone. Restart app, confirm no directories remain older than
7 days (create a fake dir with a backdated mtime to test the prune).

---

## Batch U5a — TrimBar click-to-seek

> Existing plan — spec unchanged. Trim playback polish. See PRD-DEV.md.

**Summary:** Clicking anywhere on the TrimBar scrubber seeks the video to that position.
Currently the playhead only moves during playback or drag. Click-to-seek makes the TrimBar
interactive for precise review without playing through.

**Scope:** `src/components/TrimBar.tsx` — `onPointerDown` handler that computes click position
as a fraction of TrimBar width → converts to ms within the trimmed range → calls `onSeek` prop.
`src/pages/Trimmer.tsx` — `onSeek` handler already exists for drag; same for click.

---

## Batch U5b — Waveform overlay improvements

> Existing plan — spec unchanged. See PRD-DEV.md.

**Summary:** TrimBar waveform is currently rendered as a low-res canvas overlay. Improvements:
better contrast, clip-locked rendering (waveform updates when `selectedClip` changes without
full reload), and optional silence-region highlight for long clips.

---

## Known open bugs (not yet scheduled — log only)

- **Unexpected clips at front of film (BUG)** — sort_order deduplication after reorder.
  Reproduce consistently before coding. Assign to U4 or U5 once root cause confirmed.
- **MediaPantry shows fewer source files than Library count (BUG)** — unknown root cause.
  Diagnostic first: compare `list_projects_cmd` file_count vs `get_project` include=0 rows.
- **WebView2 crash on 4K playback** — resolved by U4e bitrate reduction (795MB → ~280MB).
  Treat as closed once U4e is verified.
- **Stall threshold false positive on zoom** — resolved by U4f. Treat as closed once U4f ships.
