# RushCut — Sprint Context

> This file tracks current focus, in-progress work, and immediate next steps.
> Updated at the end of every session by the wrapup skill.

---

## PIVOT — LOCAL BUILD (decided end of Batch 7)

**Root cause:** 30 Mbps upload -> 1.9 GB clip = ~8 min upload; 19 GB session = ~84 min. Unusable.
**New model:** Pipeline runs locally via WSL2. No uploads. No Lambda. Browser UI unchanged.
**Full pivot spec:** See `CLAUDE.md` -> "MAJOR PIVOT" section at the top.

---

## Current Phase

**Phase 2 — Batch U4g + done-state polish COMPLETE (2026-06-13). Next: U4h deferred; next session: U5a/b.**

---

## Immediate Next Task

- **Batch U4 — COMPLETE (2026-06-11).** Background zoom cache warm: `pipeline/warm_zoom.py` + `warm_zoom_cache_cmd` Rust command + three-tier Arrange.tsx trigger (zoom-tab-leave immediate, 500ms debounced on param edit, unmount backstop). Verified: `zoom_cache_hits=4/4 t_zoom=0` on both 1080p + 4K renders. Stall threshold raised 120s→360s. 9/9 fast + 5/5 editor PASS.
- **Batch U4b — COMPLETE (2026-06-12).** Zoom preview auto-play on clip switch: added `prevZoomClipIdRef` to distinguish clip switch from param edit; clip switch always calls `syncZoomToPlayhead(0, false)` (bypasses stale `isPlayingRef`). Fix is `Arrange.tsx` clip-switch effect only.
- **Batch U4c (BUG) — COMPLETE (2026-06-12).** Four `_render_segmented()` artifact paths moved from `/tmp` tmpfs to NTFS `seg_tmp` via new `_resolve_render_work_dir()` helper (mirrors zoom-cache pattern). `TMP_BASE` / line 357 intentionally untouched. Verified on job `c503f7a0` (21-clip Stagecoach, 4K, xfade): `[U1g] segment work dir: /mnt/c/...` confirmed in log, 7 batches, `drift=0 frame(s)`, no fallback, pipeline complete. **The stall alert that fired mid-render was a false positive** — cold zoom (>6 min, skipped zoom tab) exceeded the 360s stall threshold but the pipeline kept running and completed. Output file healthy (ffprobe: 140.6s, 4214 frames, no corruption). Separate bugs logged: (1) cold-zoom-on-skip-tab → PRD-DEV.md; (2) WebView2 crash playing 40Mbps 4K output → PRD-DEV.md.
- **Batch U4d + U4f — COMPLETE (2026-06-13).** Proactive zoom warm on project entry (`Trimmer.tsx` entry warm gated on `zoom_mode != null` clips, `warmFiredRef` session guard) + Render submit backstop (fire-and-forget at top of `submitJob`). U4f: stage-aware stall threshold — `maxStallMsRef` (default 360s) extended to `min(600s, max(360s, inFilmCountRef.current * 60s))` on `STAGE:zoom`; `inFilmCountRef` synced from state to fix stale closure in once-registered listener; resets to 360s on leaving "rendering" and in `startRenderNow`. **Bundled routing fix:** `Upload.tsx` "Resume a Project" cards were hardcoded to `/trimmer/:id` regardless of job status — now uses `renderStateFromStatus` (same Library Smart Open logic), routing done projects to `/render/:id`. Verified: 4 warm fires in zoom-bg.log (all 10/10 cache hits); 9/9 fast E2E PASS.
- **Batch U4e — COMPLETE (2026-06-13).** AMF auto-enables for 4K silently (no UI toggle) — gate `use_amf or RUSHCUT_USE_AMF or output_resolution=="4k"` in `encoder.py`. Final AMF path switched CQP → VBR (`-rc vbr_peak -b:v 20M -maxrate 24M -bufsize 24M`); explicit `-maxrate` caps the bitrate peaks that crashed WebView2 under uncapped CQP. libx264 final 40M→20M. Single knob `FINAL_BITRATE`. "Fast render" toggle removed from `Render.tsx` (state/handler/UI/pref); `use_amf` field dropped from `buildJobConfig.ts`/`renderStore.ts`/`types/project.ts`. amf_fallback toast reworded to "GPU encode unavailable -- rendered on CPU (standard quality)". Added `videoLoadedRef` so a WebView2 *decode* crash during playback no longer mislabels a present file as "no longer on disk". **Bitrate decision (TV check):** compared 15M/20M/40M renders — 15M loses detail (bleak/pixelated, worst at 1.5–2x zoom), 20M is a worthwhile compromise vs 40M. **Locked at 20M.** Comparison renders use libx264 (AMF can't be invoked from a manual WSL script — exit 127); production app path uses AMF correctly. 9/9 fast E2E PASS. Wrapup skill cleanup fixed (was deleting user's real renders).
- **Spun off:** zoom-quality-at-high-zoom investigation + V-series render-architecture roadmap (clean intermediate → system player → parallel pipeline) in `docs/batch-plan.md`.
- **Batch U4g — COMPLETE (2026-06-13).** Cancel in-progress render: process-group kill via PID file (`pipeline/run.py` `os.setpgrp()` + PID write); `cancel_render_cmd` Rust command (reads `.pid`, `wsl kill -15 -<pgid>`, `update_job_error`/`emit_error`, partial cleanup of NTFS work dir + WSL /tmp). Cancel button in rendering phase (outlined white/30, destructive secondary). Bundled: V3 done-state redesign — split card (`1fr 1px 220px` grid), green "Export finished" pill, 2x2 stats grid, "Saved to" dir row, right-column actions (Open film / Open folder / Render another version). `open_in_player_cmd` Rust: `cmd /c start "" path` (separate OS args, path-with-spaces safe). 1080p: preview panel below main card; 4K: no in-app video (system player only). Error block: cancel-specific sub-copy ("No changes were made...") vs render-failure copy. `buildJobConfig.ts` always emits `output_resolution`. `resLabel()` checks analysis `output_resolution` before `has_4k` (source vs output fix). 9/9 fast + 14/14 render E2E PASS.
- **U4h deferred.** Project-delete temp cleanup + 7-day startup prune of old UUID `%TEMP%\rushcut\` dirs — next session.
- **Next: U5a/b** — Trim playback polish (TrimBar click-to-seek, waveform improvements).
- **E2E:** 9/9 fast + 5/5 editor PASS (2026-06-11).
- **Backlog (low priority):** open/close-to-black projects (`has_open`/`has_close`) still use monolithic path — exit-15 risk on very large 4K with those transitions.
- **Known gap (not urgent):** `handleDeleteCut` in `Trimmer.tsx` does not correct `filmPlayIdx` when the currently-playing clip is deleted.
- Full sub-batch plan (U4d–U5b): `docs/batch-plan-u4d-subbatches.md`.

### Performance confirmed (2026-06-01, Batch T2 warm benchmark):

| Scenario | Gate (proxy gen) | t_normalise | t_total |
|----------|-----------------|-------------|---------|
| Cold 8-clip (≤31s clips), AMF | **121s** | 2s | **133s** |
| Warm 4K 8-clip/3-source, libx264 | ~0s | 9s | **~3 min** |
| Cold 4K 3-source (27s+48s+90s), no bug | ~165s (est.) | — | ~5 min |

**WSL memory** raised to 12GB (`%USERPROFILE%\.wslconfig`) — required for 4K xfade encode on 16GB machines.

### Batch U1 crash diagnosis (item 6 — LOG FINDINGS ONLY, 2026-06-05)

Examined the 3 failed renders from the founder's first-edit session (`%TEMP%\rushcut\pipeline-{job_id}.log`):

| Job (8-char) | Start (manifest) | Log ends | Ran for | Outcome |
|--------------|------------------|----------|---------|---------|
| 036b3c99 | 23:47:57 | 23:53:16 | ~5m19s | cut off mid-`render`, no DONE/ERROR |
| 540b3118 | 23:58:43 | 23:59:25 | ~42s | cut off mid-`render`, no DONE/ERROR |
| abb161d6 | 00:01:43 | 00:02:22 | ~39s | cut off mid-`render`, no DONE/ERROR |

Findings:
- All three are **4K** (`scale=3840:2160`) **~14–22-clip xfade** renders of the ~2:46 film. Each log terminates in the middle of the render-stage `filter_complex` with **no ERROR/Traceback and no DONE marker** → the SIGTERM (exit 15) signature per LEARNINGS ("half-complete run ending mid-stage, numeric signal exit"). The exit-1 attempt's FFmpeg stderr is **not** in these python logs (Rust captures process stderr separately), so exit-1 root cause can't be confirmed from available logs.
- Job **start times are strictly sequential** (5.5 min then 2 min apart) → **no evidence of two concurrent pipelines for a single attempt** in the logs; these read as deliberate sequential retries, not a same-attempt duplicate spawn.
- `render-timing-log.jsonl` has no entry after 2026-06-02 → confirms none of the three wrote a success record.
- Background proxy gen was active in the window (`proxy-bg.log` 23:54) → memory contention between a **20-clip 4K xfade** encode and concurrent proxy AMF remains the most plausible SIGTERM contributor (heavier than the 8-clip case that motivated the 12GB `.wslconfig` bump).

Mitigation status:
- **U1 single-job guard (step 4)** eliminates the navigate-in/out duplicate-spawn class regardless of what the logs show — the standing mitigation.
- The **20-clip 4K xfade memory-pressure** angle is a SEPARATE potential cause and is **out of U1 scope** → logged here as a candidate backlog item (e.g. cap concurrent proxy gen during an active 4K render, or chunk very-large xfade chains). No code change made for it in U1.

---

## Recently shipped this session (2026-06-09)

- **Batch U3b — Zoom-tab playback UX COMPLETE:** `Arrange.tsx` only. (1) `syncZoomToPlayhead(elapsedSec, playing)` replaces `restartZoomAnim()` — positions the `rc-kenburns` CSS animation via negative `animation-delay` + `animation-play-state`, with `animation=none` + `offsetHeight` reflow to force restart on each call. Syncs on play/pause/seek/clip-end; never on `timeupdate` ticks (TRAP comment in code). (2) Gesture split on big preview: click=play, drag=focal (4px `DRAG_THRESHOLD_PX`). Sound tab video box: `onClick={soundTogglePlay}`. (3) Focal indicators: `rc-focal-pulse` removed from both big preview and small picker; big preview indicator removed entirely (pointer cursor + hint text only); small picker reverted to `w-4 h-4` static orange ring. Hint text `"Drag preview to set focal point"` in `text-xs italic text-[#a3a3a3] text-right` below scrubber, zoom-active only. DESIGN.md updated.

- **Batch U3e — Zoom-in destination crop box COMPLETE:** `Arrange.tsx` only. `approxKenBurnsProgress(t)` helper (smoothstep, named to distinguish from CSS curve). Destination box drawn at `videoBox` level (outside CSS-animated `videoWrapRef`) using projected screen coordinates: `screenW = cropPct * sCur`, `screenLeft = focalX + (srcLeft - focalX) * sCur`. `t_raw` normalized against `kbPreviewDurationSec` (animation window, not full clip), so box disappears at correct point for Med (75%) and Fast (50%) speeds. Style: `border-2 border-[#FF8A65] rounded-sm`, `boxShadow: "0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.6)"` dark halo for visibility on bright footage. Conditions: gradual zoom-in + paused + `t_raw < 1`. 9/9 fast + 5/5 editor PASS.

## Recently shipped previous session (2026-06-07)

- **Batch U3a — Zoom-tab focal correctness + SAR fix COMPLETE:** Three changes across two files. (1) `Arrange.tsx` item 2a: removed `wrap.style.transformOrigin = ""` from the non-gradual branch of the paused-preview useEffect — it was wiping React-managed transformOrigin after JSX committed the focal point, reverting the preview back to center. (2) `Arrange.tsx` item 3: new `kbPreviewDurationSec()` helper reads `parseZoom()` and computes preview duration from `trimmedMs / 1000 * KB_SPEED_FRAC[speed]`; both `restartZoomAnim()` and the paused-preview effect now set `wrap.style.animationDuration` from this value instead of hardcoded `4s`; deps extended with `selectedClip?.in_ms`/`out_ms` so retrim/speed changes recompute. (3) `pipeline/transitions.py`: `,setsar=1` added to the canvas `pad=...` string in both `build_batch_video_fc` (segmented U1g path, line ~205) and `build_filter_complex` (monolithic path, line ~351) — fixes FFmpeg exit 234 `Parsed_concat SAR mismatch` when DJI proxy clips (SAR 3321:3320) and zoom-reencoded clips (SAR 1:1) enter the same concat filter. Item 1 (phantom clips) not reproducible — pre-existing sort_order dedup from U2 likely resolved it. Render verified: off-center focal log lines `focal=(0.60,0.40)`, `(0.80,0.70)`, `(0.20,0.30)` with correct crop math confirmed; render completed, visual frame check passed. E2E to run in separate session (chrome-devtools MCP was active in this session).

- **Batch U2 — Drag-to-reorder + filmPlayIdx bugfix COMPLETE:** `StickyFilmStrip.tsx` rewritten with dnd-kit drag-to-reorder (`DndContext` + `SortableContext` + `SortableFilmTile` component, `PointerSensor` with `{ distance: 5 }`, `CSS.Translate.toString` for variable-width tiles). Swipe-delete replaced with hover-reveal `Trash2` bin icon (aligns with DESIGN.md). `onReorder` prop wired in both `Trimmer.tsx` and `Arrange.tsx` — merge reordered film IDs back into full clips array (sort_order pantry-collision safe), optimistic update + rollback, `invoke("reorder_clips_cmd")`. DESIGN.md extended with drag-to-reorder subsection. Bundled bugfix: `handleReorder` in `Trimmer.tsx` now corrects `filmPlayIdx` after reorder by finding the playing clip by ID in the new order (was: integer index stayed fixed causing playhead to show wrong clip). Pre-existing E2E fixes: `arrange.spec.ts` + `sound.spec.ts` `rc_*` key reads migrated from sessionStorage to localStorage (U1b debt). Known gap: `handleDeleteCut` does not correct `filmPlayIdx` on clip delete — pre-existing, not introduced here. 9/9 fast PASS, 26/26 arrange PASS.

## Recently shipped previous session (2026-06-07)

- **Batch U1g — Segmented xfade render COMPLETE (verification):** Already implemented in U1b commit (`ff0e527`). Session verified against real 21-clip 4K Stagecoach project. Result: exit code 0, `drift=0 frame(s) (0.0ms)`, 7 batches, music + cards correct, peak WSL ~9.7 GB (12 GB limit safe). Open/close-to-black still uses monolithic path (documented gap). 9/9 fast PASS, 14/14 render PASS.

## Recently shipped previous session (2026-06-07)

- **Batch U1e — Stalled Render Detection COMPLETE:** UI-only change in `Render.tsx`. Added `lastProgressAtRef` (timestamp of last `pipeline-progress` OR `pipeline-stage` event) and a `stalled` boolean. A 30s interval checks: if `Date.now() - lastProgressAtRef.current > 120_000`, `setStalled(true)`. Both event types reset the ref (stage transitions count as liveness, preventing false positives during long xfade stages). Re-attach seed comes from `active_job.updated_at` inside the load `useEffect` — not `Date.now()` — so a stall that began before the user navigated away surfaces immediately on return (proven live: warning reappeared 2.48s after remount with 54s stale `updated_at`). Warning panel: `border-l-2 border-l-[#FF8A65]` peach accent, `text-sm text-[#e5e5e5]` body, "Try Again" peach text button → `startNewVersion()`. `data-testid="render-stall-warning"` + `data-testid="btn-stall-retry"`. Verified via CDP: Screenshot A (normal render, no warning), Screenshot B (SIGSTOP frozen pipeline, warning at 120s), Screenshot C (SIGCONT resume, render completed, warning cleared). DESIGN.md extended with inline warning panel variant.

## Recently shipped previous session (2026-06-07)

- **Batch U1d — New Render Visibility + Nav-Guard COMPLETE:** Two bugs fixed. Bug 1: cold-path renders (proxy gate still building) were silently lost on navigate-away — `start_job` was only called from the polling effect, which tears down on unmount. Fix: persist intent via `rc_render_pending_<projectId>` in localStorage (via `renderStore.ts`); on mount, if flag is set + no active job, re-enter `submitJob()` to resume from where it left off. Double-submit guard: `removeRenderPref()` called before `await invoke("start_job")` so a job created on the warm path cannot be re-submitted on return. Bug 2: new render visibility — `get_latest_render` already orders by `created_at DESC`, so the newest done job with its correct filename + timestamp always loads. Verified via `eval-test-film-01.mp4` / "5 Jun 2026, 22:03" in the done-state view. [TRAP] discovered: `window.confirm` was silently broken in Tauri WebView2 (no `dialog:allow-confirm` capability in `default.json`). Pre-existing render-gate confirm in `BottomTabBar` never blocked and was logging unhandled rejections. Fixed by replacing `window.confirm` with async `import { confirm } from "@tauri-apps/plugin-dialog"` + adding `dialog:allow-confirm` to capabilities + binary rebuild. Dialog proof is indirect (CDP cannot hook Win32 modals) but strong: Win32 modal blocked desktop for duration of `request_access` timeout (300s), URL stayed on /trimmer/ after "No" click, zero console rejection errors. `src/utils/renderInFlight.ts` created then deleted (module-level nav-guard flag; nav-guard approach dropped because persist-intent makes it redundant). 9/9 fast + 14/14 render PASS.

## Recently shipped previous session (2026-06-06)

- **Batch U1b — Render Quality + Mute Fix + localStorage COMPLETE:** Root cause identified: `sessionStorage` is cleared when the binary is relaunched, wiping transition/music/cards/resolution settings so they fell back to defaults on every new render started from a fresh binary. Fix: migrated all `rc_*` render-setting keys to `localStorage` via new `src/utils/renderStore.ts` (thin `getRenderPref`/`setRenderPref` wrappers). Six files updated: `buildJobConfig.ts`, `useConfiguredTabs.ts`, `Render.tsx`, `Trimmer.tsx`, `Arrange.tsx`, `Sound.tsx`. Bundled pipeline fixes: (1) Python falsiness trap in `render.py` — `0.0 or 1.0 = 1.0` silenced muted clips (volume=0.0) to full volume; fixed with explicit None check. (2) FFmpeg 6.1.1 renamed `aevalsrc` sample-rate param `r=` → `s=`; fixed in 3 occurrences in `transitions.py` `build_audio_only_fc()`. (3) `encoder.py` final master path: 40Mbps target bitrate + medium preset (was ultrafast for both draft and final). 9/9 fast PASS. 19-clip 4K observed render times: 3.6 min (medium/simple), 6.4 min (fast/comparison), 11.7 min (slow/comparison), 8.2 min (medium/final).

## Recently shipped previous session (2026-06-05)

- **Batch U1a — Render Resilience COMPLETE:** `current_stage TEXT` additive migration on `jobs` table (migration guard via `pragma_table_info`). `update_job_stage()` Rust helper called on every `STAGE:` stdout line from `run_pipeline`. Single-in-flight-job guard in `start_job` — returns existing active job id if one exists for the same project_id (prevents duplicate WSL spawns). `Render.tsx` re-attach block now restores stage label (`stageLabel(active_job.current_stage)`) and seeds elapsed timer from `created_at` instead of `Date.now()` (so timer continues across navigations). Reassurance copy on error block. 9/9 fast + 14/14 render E2E PASS. **Live test observations:** timer correctly continued across 5+ navigations on real 19-clip 4K render; `current_stage='Rendering'` confirmed in DB. **Gaps found and documented as U1b–U1e:** render quality (music/transitions/cards/muting absent from output), startup self-heal for stuck jobs, new render visibility + nav-guard, stalled render detection.

## Recently shipped previous session (2026-06-02)

- **Batch T7 — WDIO proxy claim cleanup COMPLETE:** `proxy_claimed_at INTEGER` additive column (stamped by `claim_clip_for_encoding`). Startup self-heal: `reset_all_encoding_claims(900)` in `setup()` clears stale/NULL-ts rows globally; 900s time-guard never clobbers a live encode in the other binary. `reset_proxy_encoding_cmd` scoped Tauri command. `e2e/helpers/testProjects.ts` registry + `trackTestProject()` one-liner in all 7 specs + `after()` hook in `wdio.conf.ts` that calls `reset_proxy_encoding_cmd` for each test project before `afterSession` SIGTERM. Verification: startup reset confirmed (1 legacy cleared, 1 fresh preserved); 0 stuck encoding rows after WDIO run; 9/9 fast PASS. Check 4 (live claim path) verified indirectly — 0 stuck rows after WDIO run that exercised claim→encode→done. Key discovery: in-session binary uses a Claude MSIX container DB (`...\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\...`), NOT real Roaming — documented in LEARNINGS.md.

## Recently shipped previous session (2026-06-02)

- **Batch T6 — Library staleness fix + preparing-phase UX COMPLETE:** Library `job-started` listener: `start_job` Rust now emits `job-started` (`{ jobId, projectId }`) after `insert_job`; Library's mount-once `useEffect` listens and fetches the new job via `get_job_cmd`, inserting it into `jobs`/`progress` state. Live green bar now updates even when Library was already mounted before the render fired (verified via chrome-devtools screenshots A/B/C). **Preparing-phase UX:** "Preparing your film..." spinner now shows `Optimising clips... X/Y ready` + peach progress bar + elapsed timer (`proxyElapsedLabel` wired into the `preparing` effect; was dead code before). **render.spec.ts stale assertion fixed:** `waitUntil` was checking `"Your film is ready"` (T4 copy); corrected to `"Your film"` — was causing 9-min timeout and 13/14 failure on every run. **New E2E spec:** `e2e/library.spec.ts` (4 assertions: heading, card renders, idle "No renders" status, idle→/trimmer/ routing); `test:e2e:library` script added to `package.json`. **launch-cdp.bat** helper created for CDP sessions. 9/9 fast PASS, 4/4 library PASS.

## Recently shipped previous session (2026-06-02)

- **Batch T5 — Render screen done-state fixes COMPLETE:** "Lost my film" problem fixed — Render screen now self-detects existing renders via `get_render_status_cmd` (new Rust command) and shows the done film view on every entry (editor flow + Library). New render is explicit via "Render new version". Filename from real path basename (not project name). Duration from `<video>` element (matches player). Timestamp absolute ("Rendered 1 Jun 2026, 23:54"). "My Projects" + "Render again" removed; "Open in Explorer" + "Render new version" (peach primary) remain. 404 fallback: player hidden, metadata preserved, "no longer on disk" note. Stuck-button fix: `setPhase("starting")` immediately in `submitJob`. `get_active_job` + `get_latest_render` DB helpers in `db.rs`. `absoluteDateTime()` formatter in `src/utils/timeAgo.ts`. `render.spec.ts` updated (`btn-render-new` assertion, heading copy). `e2e.md`: `browser.navigate()` does-not-exist rule added. Library `handleOpen` simplified (dropped T4 resume state). PRD-DEV.md: multi-version pantry added to backlog. 9/9 fast PASS.

## Recently shipped previous session (2026-06-01/02)

- **Batch T4 — Library live render progress + smart Open routing COMPLETE:** `get_job_cmd` prefetch for each project's `last_job_id` on mount; `Record<projectId, Job>` jobs map; four-state meta row (idle/rendering/done/error) with live green `#22c55e` mini progress bar for rendering state; relative-time "Last render: Xh ago · 1080p" for done state; "Render failed" red for error. `pipeline-progress` / `pipeline-done` / `pipeline-error` event listeners update map in place from payload (no re-fetch). Smart Open routing: done/processing/failed → `/render/:id`; idle → `/trimmer/:id`. `timeAgo()` util in `src/utils/timeAgo.ts`. `src/pages/Library.tsx` fully updated. 9/9 fast PASS.

- **Batch T3 — Proxy gate UX COMPLETE:** `awaiting-proxies` phase eliminated. Proxy wait hidden behind "starting" spinner; render bar appears only when `startRenderNow()` fires. `btn-start-anyway` removed. 9/9 fast PASS.

## Recently shipped previous session (2026-06-01)

- **Batch T2 — Proxy deduplication COMPLETE:** `encode_one_clip` renamed proxy files from `{clip_id}.mp4` to `proxy_name_for_path(local_path)` (FNV-1a 64-bit hash, stable across Rust versions). `run_bg_proxy_batch` groups full clip list by `local_path`, builds one queue item per unique source (canonical = `MIN(clip_id)` for trigger-agnostic claim), emits `unique_paths=N` in batch-start log. Fan-out via new `set_proxy_for_all_clips_with_path` DB helper — one UPDATE sets all cuts sharing a source. Atomic temp→rename encode. `vacuum_proxies_cmd` rekeyed to `get_all_proxy_paths()` (full path match) instead of clip-id stems. `run_single_proxy` (Trimmer onError) given same hash + fan-out treatment. **Bug fixed in same session:** duplicate normal-priority boost (`{project_id}:normal` key in concurrency guard) was causing 3 concurrent AMF sessions and 3-5× slowdown. **WSL memory fixed:** `.wslconfig memory=12GB` prevents 4K xfade SIGTERM on 16GB machines. Confirmed: 3-source/8-cut 4K film renders warm in ~3 min. 9/9 fast PASS.

## Recently shipped previous session (2026-05-31)

- **Batch T1 — Library clip count fix COMPLETE:** `list_projects()` SQL replaced `COUNT(*)` with two subqueries: `COUNT(DISTINCT local_path) AS file_count` and `COUNT(*) WHERE include=1 AS cut_count`. `ProjectSummary` Rust struct + TS interface updated (two fields replace `clip_count`; `query_map` indices shifted to 3-7). `Library.tsx` + `Upload.tsx` both updated to display "N files · M cuts". Rules updated: `rust-tauri.md` gets cargo config.toml discovery rule + DB path/WAL stale read note; `CLAUDE.md` gets "grep before claiming single site" rule. 9/9 fast PASS.

## Recently shipped previous session (2026-05-25)

- **Batch S4 — Earlier proxy trigger COMPLETE:** `generate_proxies_cmd` gains `all_clips: Option<bool>` param. New `db.rs` `get_all_clips_for_bg_proxy()` omits `include=1` filter. `run_bg_proxy_batch` switches query based on `all_clips` flag. `Upload.tsx` updated from bare `invoke("generate_proxies_cmd", { projectId })` to `invoke("generate_proxies_cmd", { projectId, lowPriority: true, allClips: true })`. Bug fix bundled: `generate_proxy_file_low_priority` was passing libx264 args to AMF encoder (same bug fixed for normal-priority in Batch S) — all low-priority encodes on AMF hardware failed silently with elapsed=0.1s. Fixed by mirroring the AMF/libx264 arg branching from the normal-priority function. Confirmed: `batch-start all_clips=true encoder=h264_amf` in proxy-bg.log; clip 1 done in 4.1s, clip 2 done in 100.3s; no regressions (9/9 fast PASS).

## Recently shipped previous session (2026-05-24)

- **Batch R Part C — AMF fallback toast + silent-fallback detection COMPLETE:** `pipeline/render.py`: `amf_fallback_flag` list-closure tracks whether AMF fell back to libx264 mid-encode; `_run_with_amf_fallback()` inner function retries with libx264 on RuntimeError when `is_amf=True`; `amf_fallback=0/1` appended to ANALYSIS line. `src-tauri/src/lib.rs`: `last_analysis` captured per job, emitted in `pipeline-done` event payload as `"analysis"` field. `src/pages/Render.tsx`: toast wired to `pipeline-done` analysis field — shows "Fast render unavailable -- rendered at standard quality" for 6s when `amf_fallback=1`; `fastRender` toggle is opt-in OFF by default (auto-ON for 4K reverted per user feedback). Verified: AMF encode 111s vs 226s libx264 on same 6/8 proxies (51% faster). No fallback in live renders (toast correctly silent). Projected warm run with 8/8 proxies: ~124s (under 180s target). 9/9 fast PASS.

- **Batch R — Render Performance (Part A + B) COMPLETE:** Part A: `ZOOM_CACHE_DIR` moved from WSL `/tmp/rushcut-zoom-cache` to NTFS `%TEMP%\rushcut\zoom-cache\` — survives `wsl --shutdown` and Windows reboots. Part B: `get_proxy_readiness_cmd` Rust command + DB helper; `run_bg_proxy_batch` boost path (`lowPriority=false`); Render screen `"awaiting-proxies"` phase with ETA hint, X/Y progress chip, auto-advance on readiness, "Start anyway" CTA. `render.spec.ts` updated to click "Start anyway" to bypass gate. Verified: 1080p warm (proxies=8/8, zoom_cache_hits=8) → `t_total=173s` (under 180s target). 4K cold with proxies: `t_total=256s` on libx264 — Part C (AMF) needed to reach <180s for 4K. Minor bug fixes: `zoom_on` ANALYSIS field (now includes per-clip zoom modes); Trimmer "No clips found" fallback when all clips are `include=1`. 9/9 fast PASS.

## Recently shipped previous session (2026-05-23)

- **Batch Q — GPU AMF render + Fast Render UI toggle COMPLETE:** `pipeline/encoder.py` (new module): `video_encoder_args()`, `to_win_path()`, `_detect_amf()`. AMF default=OFF (libx264 for quality); opt-in via `RUSHCUT_USE_AMF=1` env var OR "Fast render" UI toggle. AMF_QP=23 chosen after benchmarking (67 MB vs libx264 63 MB, +6%). B-frame hardware limitation confirmed (AMD driver ignores `-bf`; `has_b_frames=0` in CQP+VBR). `render.py` + `run.py` updated to thread `use_amf` from manifest. `src/pages/Render.tsx`: "Fast render" toggle in `phase==="ready"` (4K gate only) — pill toggle, `#99B3FF` when on, helper text "slightly lower motion quality". `src/types/project.ts` + `buildJobConfig.ts` wired. 9/9 fast PASS.
- **Batch Q2 deferred — FPS stutter diagnosed:** Stutter on constant-motion DJI clips traced to 29.97fps→25fps conversion in proxy + normalise. Plan documented in `docs/BATCH-Q2-FPS-STUTTER.md`.

## Recently shipped previous session (2026-05-23)

- **Batch P2 — Loudnorm fusion COMPLETE:** Eliminated the separate two-pass loudnorm Step 7 (~17–32s on 4K renders) by fusing single-pass `loudnorm` directly into the encode that already happens. Music-off single-clip: appended to `-af` chain. Music-off multi-clip: `[aout]loudnorm=...[aloud]` label in `filter_complex`, gated on `not music_on` to prevent double-apply. Music-on (any): fused into `music.py` amix tail as `[amixed]loudnorm=...[aout]` via `apply_loudnorm=True`. `loudnorm.py` rewritten: two-pass `loudnorm()` + Lambda dead code deleted; `loudnorm_filter()` helper added. Step 7 replaced with `loudnorm_s=0.0` stub so ANALYSIS/timing log stays intact. Verified: `t_loudnorm_s=0.0` all paths; music-on -13.5/-14.2 LUFS PASS; music-off single-clip -14.4 LUFS PASS; music-off multi-clip -15.7 LUFS accepted (single-pass ±2.0 bar for acrossfade content). A/B listen: "absolutely fine." LEARNINGS.md updated with ±2.0 LUFS bar note.

## Recently shipped previous session (2026-05-21)

- **Batch P — Render Performance COMPLETE:** Zoom step parallelised via `ThreadPoolExecutor(min(4, cpu_count))` with per-worker `-threads N -filter_threads N` cap (mirrors normalise.py). Persistent zoom output cache at `/tmp/rushcut-zoom-cache/` — sha1 key on `(src_path, size, in_ms, out_ms, zoom_mode, focal_x, focal_y, resolution)`; atomic writes via `os.replace(tmp→final)`; INVALID detection via `is_valid_proxy()` for corrupt mid-encode cache entries. Render preset `medium → fast` (CRF 22 kept). `zoom_cache_hits` added to ANALYSIS line + `render-timing-log.jsonl`. `run.py` per-job log file (`pipeline-{job_id}.log`) with `pipeline-latest.log` as symlink — prevents concurrent runs corrupting the log. Measured: 6-clip 4K re-render ~3 min (was ~6.5 min). First renders unaffected by cache (all MISS). E2E: 9/9 fast + 5/5 gap-editor + 26/26 arrange + 15/15 render PASS.

- **Batch O — Gradual Zoom (Ken Burns) COMPLETE:** Per-clip gradual zoom added to Arrange Zoom tab. `zoom_mode` encoding: `kb_<dir>_<ratio>_<speed>` (e.g. `kb_in_1.5_slow`). UI: Style row (Off / Fixed / Gradual) + Direction / Amount / Speed chips. Speed semantics: slow=100%, med=75%, fast=50% of trimmed clip duration. Preview: CSS `rc-kenburns` keyframe on a **wrapper div** (not video element — avoids WebView2 compositor conflict that caused choppy playback); plays once on selection, resets on play. backend: `zoom.py` `_probe()` single ffprobe (w+h+duration), `_parse_kenburns()`, `_kenburns_vf()` with comma-free smoothstep clamp `(a+1-abs(a-1))/2`; `-preset ultrafast` for intermediate. `crop` filter has no `eval` option — x/y re-evaluate per frame natively. `src/utils/zoom.ts` canonical model: `parseZoom()`, `buildZoomMode()`, `zoomLabel()` — no screen shows raw `kb_*` string. 1080p render: zoom=3.7s. 4K render: zoom=9.9s. 9/9 fast PASS, 26/26 arrange PASS. Performance note: 6 clips 4K ~1m20s = 9m first render / 6.5m re-render; zoom step 1.5m for 6 clips — parallelisation needed next batch.

## Recently shipped previous session (2026-05-20)

- **Bug fix — Shuffle label raw JSON on Sound + Render screens:** `Sound.tsx` and `Render.tsx` were reading `rc_transition_${projectId}` via raw `sessionStorage.getItem()`, which since Batch M2 returns a full `TransitionConfig` JSON object. Passing that raw JSON string to `ChosenEffects` caused `TRANSITION_LABELS[jsonString] → undefined → chip shows raw JSON`. Fix: both pages now import and use `readTransitionConfig()` from `buildJobConfig.ts`, deriving `"shuffle"` / `tc.between` / `null` correctly. ChosenEffects chip shows "Shuffle" on all screens. 9/9 fast PASS.

- **Bug fix — Shared video state for two cuts from same source clip (Arrange):** `loadedSrcRef` (URL-based) guard in Arrange zoom + sound tabs fired early when switching from Cut A to Cut B of the same raw clip (identical `proxy_path` URL). Renamed to `loadedClipIdRef` and `soundLoadedClipIdRef`; guard now compares `selectedClip.id` (always unique). Switching cuts correctly seeks to each cut's `in_ms`. 23/23 arrange PASS.

## Recently shipped previous session (2026-05-19)

- **Batch N — Background Proxy Pre-Generation COMPLETE (2026-05-19):** Silent pre-build of 1080p H.264 proxies when user leaves Trimmer → Arrange. Trigger: `Trimmer.tsx` unmount `useEffect` cleanup calls `invoke("generate_proxies_cmd", { projectId, lowPriority: true })`. Rust `run_bg_proxy_batch`: serial HEVC encode at Windows `BELOW_NORMAL_PRIORITY_CLASS` + `-threads 1`; `update_clip_proxy` + `set_clip_proxy_status('done')` on success. Native-codec (H.264) clips skip encode instantly. Concurrency guard (existing `Arc<Mutex<HashSet>>`) prevents duplicate spawns. `proxy_path` written to DB by background gen → `start_job` manifest already includes it → `render.py` Batch C proxy-reuse logic skips normalise automatically. DB: additive `proxy_status TEXT` column + `set_clip_proxy_status()` + `get_clips_needing_bg_proxy()` helpers. Logs to `%TEMP%\rushcut\proxy-bg.log`. Step 5 log confirmed: 5 clips, elapsed 6–18s each, no duplicates, re-trigger guard fires `skip reason=no-clips-need-proxy`. E2E: 9/9 fast PASS, 23/23 arrange PASS, 15/15 render PASS (2026-05-19).

- **Batch M2 — Transitions Expansion COMPLETE (2026-05-18):** 9 transition types (None / Crossfade / Dip to Black / Wipe / Wipe Down / Zoom / Dissolve / Barn Door / Band Wipe) + Shuffle card (random per-cut from all 8 non-none types, job-id seeded for determinism, logs `[M2] cut N: type`). Left-rail 10-card layout + enlarged centre preview (h-56). CSS keyframes for 4 new types: wipe_down (clip-path inset top/bottom), dissolve (opacity, same timing as crossfade), barn_door (scaleY squeeze), band_wipe (two-step clip-path right-to-left). Animation bug fixed: unselected cards use `animation: "none"` in JSX (inline style beats CSS play-state class). Opening / closing cut pickers removed from UI (pipeline plumbing retained). `TransitionConfig` JSON storage with compat reader. Pipeline: `_TRANSITION_MAP` extended (4 new FFmpeg xfade names), `_SHUFFLE_POOL` extended to all 8. 23/23 arrange E2E PASS. PRD: two post-launch backlog items added (animation accuracy polish + geometric mini-preview redesign).

- **Batch M1 — Transition preview card-chips COMPLETE (2026-05-17):** Transitions tab chips on Arrange screen converted to card-chips (vertical card: animated thumbnail on top + label below). CSS `@keyframes` for None (hard cut via `steps(1, end)`), Crossfade (opacity dissolve), Dip to Black (fade-to-black gap). 3s looping animations; play-state `paused` by default, `running` on `.rc-trans-card--selected`. Thumbnails from first/last in-film `thumbnail_data` (base64 JPEG); colour-block fallback when no clips. Description text removed — visual demo replaces it. DESIGN.md extended with transition preview card-chip pattern. 9/9 fast E2E PASS. Deferred: M2 left-rail layout + expanded types + shuffle.

- **Batch L — Cards tab COMPLETE (2026-05-17):** Cards tab on Arrange screen fully implemented. Two panels (Start card + End card). Start: toggle, title input (60 chars), subtitle input (80 chars), 3-swatch colour picker (peach/black/white), CSS preview. End: toggle, text input (40 chars), swatch picker, CSS preview. Defaults: both toggles OFF; start title seeds from project name on first load; end title = "The End". State persists in `rc_cards_${projectId}` sessionStorage. `buildJobConfig.ts` maps colour tokens → hex, respects toggle-OFF (emits empty string). Pipeline: `cards.py` `_make_png` extended with subtitle RGBA composite (60% alpha via `fill=(r,g,b,153)`, `getbbox`-based vertical centring). `render.py` passes `subtitle=config.get("intro_subtitle", "")`. DESIGN.md: two new subsections (Form text input + Card background swatch picker). PRD backlog: card in-film preview deferred post-launch. **Bugs fixed:** (1) `music.py` filter_complex trailing comma before `[mus]` output label (pre-existing; caused FFmpeg exit 8 on any render with music). (2) `run.py` not forwarding `intro_subtitle` from manifest to config dict (subtitle silently empty on render). 9/9 fast E2E PASS.

- **K4 — Dual-buffer black flash fix on Master tab COMPLETE:** Ported the proven Trimmer.tsx A/B slot dual-buffer engine into `src/pages/Sound.tsx`. Replaced single `filmVideoRef` with `filmVideoARef`/`filmVideoBRef` + `activeFilmSlotRef` + `slotGenRef`. Added `getFilmVideo`, `setSlotVisible` (sig: `"a"|"b"|"none"`), `gateFrameRevealThen` (rVFC + `metadata.mediaTime` gate, `TOLERANCE_SEC=0.05`, `MAX_WAITS=30`), `loadIntoSlot`, `preloadIntoSlot`, `crossSeekToClip`. Rewrote `advanceFilmClipRough`, `handleFilmTimeUpdate`, `startFilmPlayback`, `pause/resume/stopFilmPlayback`, `seekToFilmMs`. JSX: two stacked `absolute inset-0 w-full h-full object-contain` `<video>` elements. Fixed post-playback regression: `stopFilmPlayback` must NOT call `setSlotVisible("none")` — leave last frame visible. DESIGN.md extended with dual-buffer model note. 9/9 fast E2E PASS.

- **K3 Revised — Live Rough Mix Playback COMPLETE:** Master mixer tab is now a full-screen film preview (large video area + right sidebar). Hidden `<video>` element cycles through `inFilm` clips sequentially; `<audio>` element plays music simultaneously. No Rust invoke calls, no WSL/Python pipeline. Features: pause/resume (`isFilmPaused` state), seekable progress bar (imperative DOM updates via refs, avoids 4-66Hz re-renders), `out_ms` respected via `onTimeUpdate` guard (not `onEnded`), music syncs to seek position + volume reset on seek, fade-out marker with "fade Xs" label on progress bar, "Press play to preview" overlay suppressed after first play via `hasPlayedRef`. Fade-out settings moved to Music tab. `handleMusicTabChange` stops preview on Master-tab enter; stops film on other-tab switch. 9/9 fast E2E PASS.

- **Batch K2 COMPLETE (2026-05-16):** Arrange Sound tab (4th tab, per-clip volume chips Mute/50%/100%/Custom, `video.volume` for audible feedback, `update_clip_volume_cmd` param fix `volume`→`clipVolume`). Filmstrip volume badges: VolumeX red (mute), Volume1 purple (reduced) — both styled as coloured square badges matching Z badge pattern. Bottom nav "Sound"→"Music". Music screen two-tab shell (Music + Master mixer). Master mixer: volume chips + fade-out chips (None/2s/5s) + Quick Preview placeholder. Pipeline: `music_fade_out_s` wired run.py→music.py. Cross-tab video pause on tab switch. 9/9 fast E2E PASS.

- **Arrange clip playback fixes (post-K1):** Video player in Arrange zoom tab now seeks to `in_ms` on `loadedmetadata`, stops at `out_ms` in `handleTimeUpdate`, clamps scrubber to `[in_ms, out_ms]`, displays trimmed elapsed/total. Playhead wired from per-clip `currentMs` via `filmPlayheadMs` formula. Replay after clip ends fixed (seeks back to `in_ms` in `togglePlay`). 9/9 fast E2E PASS.

- **Batch K1 — Arrange screen full redesign COMPLETE:** Centred `<video>` preview + left clip rail (vertical thumbnails, peach active border) + Prev/Next navigation; "zoom" tab (renamed from "Clips"); play+scrubber row; drag-to-focal on video preview (window-level mousemove, `patchClip` instant + `saveReview` on mouseup); Z badge (green `bg-[#22c55e]` square) on StickyFilmStrip when `zoom_mode != null`; purple dot when `clip_volume !== 1.0`; drag-left/DEL delete on film strip. Volume controls removed from Arrange. `loadedSrcRef` pattern prevents video reload stutter on tab switch (zoom tab kept mounted via `hidden` class). 9/9 fast PASS.
- **Play button standardised:** Trimmer + Arrange both use `<Play size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />` inside `w-10 h-10 rounded-full bg-[#FF8A65] text-white`. No hand-coded SVG.

- **Batch J — Arrange screen COMPLETE:** `/transitions/` → `/arrange/`; 3-tab shell (Clips | Transitions | Cards); per-clip volume (chips + custom input, `clip_volume` DB col + Rust cmd + pipeline volume filter); zoom + focal picker on Clips tab; StickyFilmStrip `onSelectClip`; pipeline `volume=` filter in transitions.py + render.py; E2E `arrange.spec.ts`. 15/15 render E2E PASS.
- **zoom.py static crop fix:** Replaced broken `zoompan` expression syntax with `ffprobe`-derived integer pixel coords → `crop=W:H:X:Y,scale=W2:H2`. Eliminates FFmpeg exit 8.
- **Render timing JSONL log:** `pipeline/run.py` now appends per-render record to `%TEMP%\rushcut\render-timing-log.jsonl` after every successful render: timestamp, instance (wdio/direct), clips, film duration, per-phase timings (normalise/trim/zoom/render/music/loudnorm), proxy usage, resolution, effects. `.jsonl` extension preserved across wrapup cleanups.
- **Two-instance documentation:** CLAUDE.md updated with two-instance rule. `start_job` manifest now includes `"instance": "wdio"|"direct"` detected via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var.
- **render.spec.ts fix:** `isExisting()` → `waitForExist({ timeout: 10_000 })` for `btn-render-film` — fixes race vs async `"ready"` phase. 15/15 PASS.

**TrimBar already-included region overlay — COMPLETE (2026-05-14):**

- `alreadyCutRegions` prop added to `TrimBar` — `Array<{ inMs; outMs }>` from Trimmer.tsx
- Bracket gradient fill: `rgba(153,179,255,0.26)` fill, `rgba(153,179,255,0.52)` edges — `#99B3FF` blue
- Z-index 2 (same tier as waveform); `pointer-events-none`; self-exclusion filter (`c.id !== selectedClip.id`); malformed row guard; micro-cut flat fallback (`widthPct ≤ 2`)
- DESIGN.md updated with "TrimBar — Already-Included Region Overlay" pattern
- 9/9 fast E2E PASS

**Film seek stutter — Option H FIXED (2026-05-13):**

- **Cross-clip seek stutter fixed**: clicking a different clip in the film timeline during playback now cuts cleanly from the outgoing frame to the seek-target frame. No frame-0 flash.
- **`gateFrameRevealThen(v, slot, thisGen, targetSec, onReady)`**: rVFC helper with `metadata.mediaTime` gate — skips frame-0 leaks, reveals only when compositor confirms seek-target frame. Safety cap `MAX_WAITS=30`. Double-rAF fallback when rVFC absent.
- **`crossSeekToClip(idx, seekMs)`**: loads new clip into opposite slot; outgoing slot stays visible during load; atomic swap via `setSlotVisible(targetSlot)` + `oldV?.pause()` on onReady. Mirrors `advanceFilmClip` pattern.
- **`activate()` in `loadIntoSlot` simplified**: Option F (play→pause with mute) removed; replaced by `gateFrameRevealThen`.
- **E2E blocked**: msedgedriver v146 vs Edge v148 mismatch — download v148 from MS Edge WebDriver site (storage CDN unreachable from automation, requires manual browser download).

**Next up — pre-launch must-haves (PRD-DEV.md Batches J–M):**
- **Batch J** — Arrange screen (`/arrange/`, replaces `/transitions/`): 3-tab shell (Clips | Transitions | Cards). Clips tab: per-clip volume + zoom. Transitions tab: migrated from current screen. Cards tab: placeholder.
- **Batch K** — Quick Preview render on Sound screen (~15s 480p) + music crossfade-out chips.
- **Batch L** — Cards tab on Arrange screen (start/end text cards + pipeline). Prereq: J.
- **Batch M** — Transitions tab expanded: 5 types + shuffle + first/last cut. Prereq: J.
- **msedgedriver v148 confirmed** — E2E blocker cleared (already installed)

**Timeline HUD auto-fit — COMPLETE (2026-05-14):**
- `isAutoFitRef` (imperative) + `isAutoFit` state (reactive) dual-tracking pattern
- Clip add → fit-to-width + scroll-to-0 when in auto-fit mode; scroll-to-end when user has manually zoomed
- Ctrl+scroll breaks auto-fit mode; "fit view" pill button restores it
- "fit view" pill: single bordered pill (`bg-[#0a0a0a]`, `border-white/30`, `group-hover`) with SVG ⟷ + "fit view" label — positioned `top: 4, right: 6` on non-scrolling root div; only visible when `!isAutoFit`
- Text polish: TrimBar hint text → `text-xs text-[#e5e5e5]`; "selected" label → solid white; ruler tick labels → solid white
- DESIGN.md updated: micro-control pill button pattern documented; minimum text size rule codified at `text-xs`

**Batch G — Ruler-based proportional timeline for StickyFilmStrip COMPLETE (2026-05-09):**
- Full rewrite of `StickyFilmStrip.tsx`: proportional clip tiles (`trimmedMs * pxPerMs`, min 40px)
- Ruler row (RULER_HEIGHT=20px): dual-array tick system (minor ≥20px spacing, label ≥50px spacing), labels at top, tick marks at bottom pointing down toward clips
- Ctrl+scroll zoom with zoom-to-cursor math; middle-mouse / left-drag-on-track pan; ResizeObserver auto-fit on first render
- CSS thumbnail tiling (`background-image: url(thumbnail_data); background-size: auto 100%; background-repeat: repeat-x`) — no `<video>` elements (autoplay prevention)
- HUD border: `border-t-2 border-[#99B3FF]/30`; clip tiles: `border-2 border-[#99B3FF]/30`; active: `border-[#FF8A65]`; badge: `bg-[#99B3FF] text-[#0a0a0a]`; effect chips: blue `#99B3FF`
- Ruler tick labels: `text-[11px] font-mono text-[#a3a3a3]` — readable at minimum spec
- `Sound.tsx`: `filmDurationMs` derived-variable bug fixed (ReferenceError → white screen)
- DESIGN.md: StickyFilmStrip proportional timeline section fully documented
- PRD-DEV.md: Batch H (App Shell Redesign) + Batch I (Branding) specs added
- 9/9 fast E2E PASS
- **Deferred**: discoverability tooltips for zoom/pan (backlog in PRD), music bar below clip track

**Batch F — Sticky filmstrip HUD across trim/transitions/sound COMPLETE (2026-05-08):**
- `StickyFilmStrip` component: 100px read-only bottom bar, `flex-shrink-0`, `border-t border-white/10 bg-[#0a0a0a]`
- Clip thumbnails (90x56px, `MAX_VISIBLE=7`, +N overflow badge, `overflow: hidden` truncation)
- Total duration summary cell (flex-shrink-0, "Total" label, M:SS, clip count)
- Navigation chips: scissors→`/transitions/:projectId`, music note→`/sound/:projectId` — shown only when set and not "none"
- No Render CTA — users must navigate via StepNav funnel by design
- Music chip persists on Transitions screen: reads `rc_sound_${projectId}` from sessionStorage at render time
- FilmStrip replaced in Trimmer.tsx; "Remove from film" button in right sidebar (conditional on `filmActiveId`)
- Sound.tsx: `clips: Clip[]` state (replaces separate `clipCount`/`filmDurationMs`); header derives both inline
- DESIGN.md: "Persistent Bottom Status HUD" section added
- Deferred: ruler-based proportional timeline (own sub-batch), music bar below clip track
- 9/9 fast E2E PASS

**Batch E — Track duration vs. film duration on Sound screen COMPLETE (2026-05-08):**
- Film duration computed from included clips (`sum of (out_ms ?? duration_ms) - (in_ms ?? 0)`) and shown in header subtitle: "ProjectName · N clips · M:SS" (hidden when 0 clips).
- Library mood chips show track duration badge inline: "Cinematic · 2:34", "Upbeat · 1:30", etc. Probed via `audio.preload = "metadata"` on mount; `probedRef` guard prevents re-probe on re-mount.
- Comparison line below mood description when both durations known: "Film: 1:23 · Track: 3:45 — long enough" (green) or "Film: 1:23 · Track: 0:45 — will loop ~2x". Derived as `React.ReactNode` variable above `return` (not IIFE).
- Custom track duration probed via `audioRef` `loadedmetadata` listener after file pick — no second `Audio` object.
- PRD: "Post-pick metadata" item marked DONE; new backlog item added: Smart Music Track Ending (crossfade-out optimisation / optimal track end point detection via librosa).
- DESIGN.md: duration badge on chips + film vs track comparison line patterns documented.
- e2e.md + LEARNINGS.md: `preview_*` MCP tools added to port-9222 conflict warning (same as chrome-devtools).
- 14/14 sound E2E PASS · 7/7 fast E2E PASS.

**Batch D — Sound screen UX polish COMPLETE (2026-05-07):**
- Three-source selector: No Music / Rushcut Library / Upload Own Track (replaces flat chip row)
- No Music: bright-white active state (`border-white/60 bg-white/15`) — visually distinct from music-blue
- Rushcut Library: expands 4 mood sub-chips (Cinematic/Upbeat/Chill/Electronic) on click; NO auto-play — preview starts only on explicit mood chip click
- Upload Own Track: clicking chip selects source without opening OS dialog; empty state shows dashed "Choose audio file..." button; filled state shows filename (bold, `text-base font-semibold`) + Preview chip button (teenyicons play SVG, MIT) + "Change" text link
- Custom track preview: Play/Stop toggle button; same 30s timer; volume chips (Subtle/Balanced/Prominent) affect live preview `audioRef.current.volume` in real time (0.3 / 0.6 / 1.0)
- `customPath` preserved across source switches (no re-upload needed when switching Library→Custom)
- Pipeline: `_MOVIE_VOL` Balanced 0.7 → 0.4 (evenly spaced: subtle=1.0, balanced=0.4, prominent=0.3)
- Rust: `get_music_dir_cmd` command returns music dir path (strips `\\?\` UNC prefix from canonicalize)
- `LICENSES.md` created at project root (teenyicons MIT attribution)
- E2E: 14/14 sound PASS · 7/7 fast PASS

**Batch C — Proxy reuse as normalise input COMPLETE (2026-05-03):**
- Proxies upgraded from 480p to 1080p normalise-compatible spec (`scale=-2:1080 -r 25 -fps_mode cfr -c:a aac -ar 48000`)
- `start_job` manifest includes `proxy_path` per clip; `run.py` threads `proxy_path_wsl`
- `render.py` two-path logic: proxy clips skip normalise (→ 1.8s), non-proxy clips normalise from HEVC source
- Legacy 480p proxies detected by height check and routed to normalise path automatically
- `vacuum_proxies_cmd` Rust command: deletes orphaned (not in DB) or stale (>30d) proxies, called fire-and-forget after pipeline-done
- Bug found+fixed: `_pretrim_worker` B-0 offset mutation required restoring original `in_ms`/`out_ms` from `clips[i]` for proxy clips

**Batch B Run 3 — Custom music (B2) COMPLETE (2026-05-03):**
- "Custom Track" chip on Sound screen — calls `open()` from `@tauri-apps/plugin-dialog` (no new Rust command). Returns plain `string` on Windows desktop.
- Filename badge below chips when custom is active. Volume section shows automatically (`mood !== "none"` condition already covers `"custom"`).
- `custom_music_path` forwarded through `buildConfig()` → `start_job` → `run.py` (`win_to_wsl` conversion at config-build time) → `render.py` (guards `"custom"` mood from building `music_filename = "custom.mp3"`) → `mix_music()` (`custom_track_path` param, priority over `track_name`).
- `[B2]` log line in `music.py` confirms custom track path in pipeline log.
- `readStorage()` explicitly restores `customPath` when `mood === "custom"`. `handleMood()` clears `customPath` on mood switch.
- `e2e/sound.spec.ts`: updated "shows all 5 mood chips" → "shows all 6 mood chips including Custom Track". 13/13 PASS. 7/7 fast PASS.
- Founder feedback: 2m48s for 38s film (4 clips, custom MP3 w/ silencedetect) — acceptable. Volume "Balanced" still lets clip audio compete — `movie_vol = 0.7` may need tuning to `0.5`. Sound screen UX improvements deferred (see PRD-DEV backlog).

**Batch B Run 2 — 4K chip + render resize (2026-05-03):**
- `has_4k_clips_cmd` Rust command + `has_4k_clips()` DB helper (clips WHERE width>=3840 OR height>=2160).
- Render screen Option B gate: `"ready"` phase shows resolution chips + peach CTA before committing. `buildConfig()` called at click time. Non-4K projects auto-start.
- C6 resize handle on done-state video player (exact C6 copy from Trimmer.tsx).
- `output_resolution` threaded through `run.py` → `render.py` → `normalise.py` + `transitions.py`. Default `"1080p"`.
- 4K normalise: `scale=-2:2160`; transitions canvas: `3840×2160`. `ultrafast` preset kept for intermediates (BATCH-C comment: keep at 1080p once proxy reuse lands).
- `[B1]` log markers in normalise.py + render.py for grep verification.
- `e2e/render.spec.ts`: conditional `renderBtn.isExisting()` check (4K=click, non-4K=skip).
- 7/7 fast E2E PASS.

**Batch B Run 1 — Pipeline perf + music ducking (2026-05-02):**
- B-0 pre-trim: render.py copy-trims each clip to `[in_s-2s, out_s+0.5s]` before normalise → files land in WSL2 tmpfs. Biggest single speedup: 10 min → ~3 min for 1m26s DJI 4K film.
- Parallel normalise: `ThreadPoolExecutor(max_workers=min(4, os.cpu_count()))` in normalise.py. Per-worker `-threads N` cap. 4 workers, 10 clips → 80s (floor = 4K HEVC software decode speed).
- Render preset: `slow` → `medium` (-25s on 86s film).
- Music ducking: `_build_filter()` ducks movie audio by `movie_vol` before amix. Prominent = movie at 0.3×, music at 0.7× → music clearly dominates.
- Proxy reuse candidate flagged (Batch C): using H.264 1080p proxies as normalise input would cut 80s → ~20-30s.

**Startup performance — DONE (Batch A4, 2026-05-02):**
- Native Win32 splash visible ~200ms from binary launch (covers WebView2 cold start entirely)
- Async WSL check — no longer blocks `setup()`; `app-ready` fires as soon as db::init completes
- Repeat launch: ~2-3s (user-confirmed)
- `pnpm dev` is NOT the test vehicle — use `pnpm dev:vite` + direct binary double-click

**Post-15g deferred items (candidate for Batch 16):**
- Sticky filmstrip in bottom nav — updates across all screens as clips are added; render CTA lives in it
- Format selector on Render screen — 4K output, file-size presets, codec choice
- Music preview (30s loop on chip select) + Transition preview (CSS loop demo) — ship together
- Edit screen rename: `/transitions/` → `/edit/` when text cards ship; StepNav "Transitions" → "Edit"

---

## Recently Completed

**Batch H — App Shell Redesign (2026-05-09)**

- Deleted `StepNav.tsx` + `NavDrawer.tsx`; `AppShell` simplified to pass-through.
- Created `src/utils/fmtMs.ts` (shared duration formatter).
- Created `src/hooks/useConfiguredTabs.ts` — reads sessionStorage for transition/mood, returns `Set<"arrange"|"sound">`.
- Created `src/components/BottomTabBar.tsx` — Home/Trim/Arrange/Sound/Render with lucide-react icons, peach active, configured=white, unconfigured=`#a3a3a3`, render-guard `window.confirm`, `data-testid="tab-{name}"`.
- Created `src/components/TopInfoBar.tsx` — `h-7 bg-[#0a0a0a] border-b border-white/10`, project name + clip count + duration.
- Created `src/components/ChosenEffects.tsx` — blue `#99B3FF` chips for transition+mood; "None set" italic fallback; `data-testid="chosen-effects"`.
- Created `src/components/EditorShell.tsx` — 3-column content row (optional left panel, `<main>`, no persistent right aside) + full-width timeline row (`[w-52 gutter][filmstrip flex-1][w-48 ChosenEffects aside]`); `BottomTabBar` fixed at bottom.
- Restructured `Trimmer.tsx`, `Transitions.tsx`, `Sound.tsx`, `Render.tsx` to use `<EditorShell>`.
- `StickyFilmStrip`: removed right duration/chip sidebar; added `onDeleteClip` prop + hover-reveal bin icon (`group`/`group-hover` pattern); border-t-2 removed (EditorShell timeline row owns it).
- Timeline row always `[w-52 blank gutter][filmstrip][w-48 effects]` — filmstrip width identical on all screens.
- Video container fixed: `flex-1 min-h-0` (was `flex-shrink-0 + maxHeight`); video fills available height responsively on window resize.
- Controls column width unified to `w-48` (matches effects aside width — TrimBar and filmstrip share identical width).
- `LICENSES.md`: lucide-react MIT entry added.
- DESIGN.md: EditorShell and StickyFilmStrip sections fully rewritten.
- E2E: 9/9 fast PASS.

**Batch G — Ruler-based proportional timeline for StickyFilmStrip (2026-05-09)**

- `pipeline/proxy.py` `generate_proxy()`: upgraded to 1080p normalise-compatible spec (`scale=-2:1080 format=yuv420p -r 25 -fps_mode cfr -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -ar 48000`). Was 480p with `-c:a copy` (96kHz DJI audio passthrough bug). Timeout 600s kept.
- `pipeline/run.py`: `proxy_path_wsl` threaded through clip dicts after `clip_paths` construction.
- `pipeline/render.py`: `_proxy_height()` helper; `from .proxy import is_valid_proxy`; two-path normalise orchestration (`proxy_clip_indices` + `norm_clip_indices`); `TIMING:normalise=` now shows `proxy_skip=N/N`. Bug fix: proxy clips restore original `in_ms`/`out_ms` from `clips[i]` (B-0 offset mutation patch).
- `src-tauri/src/lib.rs`: `generate_proxy_file()` upgraded to 1080p spec; `start_job` manifest includes `"proxy_path": c.proxy_path`; `vacuum_proxies_cmd` new command (orphaned+stale deletion, `create_dir_all` guard, `SystemTime` mtime, registered in `generate_handler![]`); fire-and-forget vacuum call after `DONE:`.
- `src-tauri/src/db.rs`: `get_all_clip_ids()` added.
- Eval: first render `proxy_skip=0/4, normalise=45s`; re-render `proxy_skip=4/4, normalise=1.8s`; output 1920×1080 H.264 AAC 48kHz; sync drift < 34ms (sub-frame).

**Batch A4 — Native Splash + Async WSL (2026-05-02)**

- `src-tauri/src/splash.rs` (new): Win32 borderless splash. `WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_POPUP`, GDI paint (`#0a0a0a` bg, "RushCut" Segoe UI Semibold 42pt, green progress bar), 50ms timer, `AtomicUsize` HWND cross-thread, `PostMessageW(WM_CLOSE)` async hide.
- `src-tauri/Cargo.toml`: `windows = "0.58"` Windows-platform dep (4 features).
- `src-tauri/tauri.conf.json`: `"visible": false` — window starts hidden, covered by native splash.
- `src-tauri/src/lib.rs`: `mod splash`; `splash::show()` before `tauri::Builder`; `setup()` calls `win.show()` (E2E compat) + async WSL with `spawn_blocking`; `confirm_app_loaded` command calls `splash::hide()` from React mount.
- `src/App.tsx`: `invoke("confirm_app_loaded")` in first `useEffect` — closes splash when React mounts.
- `src/main.tsx`: fallback reduced 5000ms → 500ms (async WSL fires `app-ready` ~50ms after binary start, before React loads).
- Result: ~2-3s repeat launch (user-confirmed). Native splash visible within ~200ms. Single unified loading experience (no two-window flash).
- E2E: 7/7 fast PASS.

**Batch A — Trimmer Core (2026-04-30)**

- **A1 — Multi-cut:** Source rows permanently `include=0` (pantry templates). Each "Add to Film" click INSERTs a new `include=1` cut row via `add_clip_cut_cmd`. `delete_clip_cmd` DELETEs cut rows (source stays in pantry). Duplicate handles guarded with toast. `MediaPantry` filters to `include===0` rows only.
- **A2 — Trim-selection loop:** Removed `loop` attribute from `<video>`. `onTimeUpdate` guard seeks back to `inMs` when `currentMs >= outMs`.
- **A3 — Splash screen (Step E):** Inline `#rc-splash` overlay in `index.html` (appears immediately on WebView2 load). Rust emits `app-ready` after db init + WSL check. React removes overlay on event; 5s timeout fallback. Second Tauri splash window removed from `lib.rs`.
- `docs/DESIGN.md`: Toast/snackbar pattern documented.
- `wdio.conf.ts`: `before` hook comment updated (second window removed, guard now no-op).
- E2E: 7/7 fast PASS · 12/12 trimmer PASS.

**Batch 15g — Render screen (2026-04-29)**

- `src/pages/Render.tsx` (new): `/render/:projectId`. Auto-starts render on mount — no idle phase, no "Render Film" button. Phase state machine: `"starting" | "rendering" | "done" | "error"`. `buildConfig()` reads `rc_transition_` + `rc_sound_` sessionStorage. Progress bar (green), stage label, elapsed timer, 10-min inactivity timeout. Done state: video player, output filename, Open in Explorer, My Projects. Error state: Try Again (if clips > 0).
- `src/App.tsx`: `/render/:projectId` route added; `/editor/` and `/output/` routes removed.
- `src/pages/Sound.tsx`: CTA updated to navigate to `/render/` (was `/editor/`).
- `src/pages/Library.tsx`: rename (pencil + inline input) added. Processing projects route to `/trimmer/` (was `/output/`).
- `src/pages/Review.tsx`: 3× `navigate('/editor/${projectId}')` changed to `/trimmer/`.
- Deleted: `src/pages/Editor.tsx`, `src/pages/Output.tsx`, `src/components/editor/SettingsPanel.tsx`, `src/components/editor/TimelineStrip.tsx`.
- `e2e/render.spec.ts` rewritten: full Upload→Trim→Transitions→Sound→Render pipeline flow. `btn-render-film` tests removed (auto-start). Duration threshold `> 3` (1 clip = ~7s output). 15/15 PASS in 2m 37s.
- `wdio.conf.ts`: `/render/` added to `waitForAppRoute()`.

**Batch 15f — Sound screen (2026-04-28)**

- `src/pages/Sound.tsx` (new): `/sound/:projectId` route. Music mood chips (No Music / Cinematic / Upbeat / Chill / Electronic) + conditional volume chips (Subtle / Balanced / Prominent, hidden when mood = "none"). `sessionStorage` key `rc_sound_${projectId}` stores JSON `{ mood, volume }`. StepNav `active="sound"`, CTA "Next: Render →" bridges to `/editor/` until 15g ships.
- `src/App.tsx`: `/sound/:projectId` route + `Sound` import added.
- `src/pages/Transitions.tsx`: CTA `onNext` updated to navigate to `/sound/${projectId}` (was `/editor/`). Footer text updated.
- `src/pages/Editor.tsx`: `VALID_MOODS`, `VALID_VOLUMES`, `VALID_TRANSITIONS` const arrays; `setConfig` seeded from `rc_transition_${projectId}` + `rc_sound_${projectId}` sessionStorage on project load. Strict `.includes()` validation guards.
- `wdio.conf.ts`: `/transitions/` and `/sound/` added to `waitForAppRoute()` URL check list.
- `e2e/sound.spec.ts` (new): 13 assertions — load, URL, heading, StepNav, screenshots A/B/C, chip presence, default active, volume hidden/shown, sessionStorage persistence, reload restore.
- `package.json`: `test:e2e:sound` script added.
- `docs/DESIGN.md`: Conditional chip row pattern documented (Sound screen).
- E2E: 13/13 sound PASS · 12/12 transitions PASS · 7/7 fast PASS.

**E2E spec debt + UX fixes (2026-04-26)**

- `e2e/trimmer.spec.ts`: All 3× `$("body").getHTML(false)` replaced with `browser.execute(() => document.body.textContent ?? "")`. "In Film" assertion (removed in Batch 16b C3) updated to "Total" (FilmStrip duration label). `// TODO` comment added to `pushState` block explaining the permitted exception. 12/12 PASS.
- `e2e/gap-editor.spec.ts`: Full rewrite as "Trimmer via real navigation" — `before()` drives real UI (hamburger → My Projects → "Open project"), waits for `/trimmer/` (was `/editor/`). All Editor-specific assertions replaced with 5 Trimmer assertions. 5/5 PASS.
- `src/pages/Editor.tsx`: Back button `navigate("/library")` → `navigate(projectId ? \`/trimmer/${projectId}\` : "/library")` — user returns to same project's Trimmer, not library.
- `src/components/StepNav.tsx`: Breadcrumb text colours corrected — past steps `#e5e5e5` (was `/70` opacity), future steps `#a3a3a3` (was `/20` opacity), separators `#555555` flat. No opacity tricks.
- `wdio.conf.ts`: `/trimmer/` added to `waitForAppRoute()` URL check list.
- `e2e.md` rules: "Known stale specs" cleared; "No pushState in before() hooks" rule added; `getHTML(false)` rule generalised to all specs.
- `docs/DESIGN.md`: StepNav breadcrumb pattern added (flat hex tokens, no opacity).

**Editor screen display fix (2026-04-26)**

- `src/pages/Editor.tsx`: `setClips` now filters `c.include != 0` — excluded clips no longer appear in the Editor clip strip.
- `src/components/editor/TimelineStrip.tsx`: duration badge now shows `out_ms - in_ms` when both are set, falling back to `duration_ms` when no trim data. Fixes raw durations being shown for trimmed clips.

**Batch 15c remaining (C4 + C5) — TrimBar seek + playhead pip (2026-04-26)**

- `src/components/trimmer/TrimBar.tsx`: `onSeek?: (ms: number) => void` prop added. `onTrackClick` changed to seek-only — no longer moves handles. Playhead thickened from `w-0.5` (2px) to `w-1` (4px). Triangle pip added above track (`top: -8px`, CSS border triangle, `rgba(255,255,255,0.8)`). Hint text updated to "Click to seek · drag handles to trim · saves on release". `didDrag` ref guard suppresses seek after handle drag-end.
- `src/pages/Trimmer.tsx`: `handleSeek(ms)` added — sets `videoRef.current.currentTime = ms / 1000` + `setCurrentMs(ms)`. `onSeek={handleSeek}` wired to `<TrimBar>`.
- E2E: 7/7 fast PASS. 10/12 trimmer (2 pre-existing getHTML timeouts). 0/1 editor (pre-existing /editor/ URL regression since Batch 15a).

**Batch 16 + 16b — Native FFmpeg + Source-First Playback (2026-04-26)**

- `src-tauri/src/lib.rs`: Full Rust native scan (ffprobe) and proxy pipeline — no WSL Python for media work. `detect_best_encoder()` with `OnceLock` — one-time GPU probe (`h264_nvenc → h264_qsv → h264_amf → libx264`). `run_media_batch` (thumbnail + waveform upfront only). `run_single_proxy` + `generate_proxy_for_clip` Tauri command — lazy per-clip proxy gen on demand.
- `src-tauri/src/db.rs`: `codec_name TEXT` additive migration; `Clip` struct + `get_project_with_clips` extended to 20 cols.
- `src/pages/Trimmer.tsx`: Source-first `src = proxy_path ?? local_path`. `onError` triggers lazy proxy gen gated by `generatingProxyRef`. `proxy-progress` listener (with `unlisten`) clears `sourceFailed` when proxy ready. Badge shows only on source failure + no proxy. 4s poll removed — event-driven. C2 (overflow-y-auto on right aside), C3 (always-active Add to Film), C6 (resizable video with pointer drag handle).
- `src/pages/Upload.tsx`: `waveform_data: null` added to `metaToClip`.
- GPU encoder fallback: nvenc → qsv → amf → libx264. HEVC clips with HEVC Video Extension play instantly at native resolution; without extension ~3-5s GPU encode on demand.

**Batch 15c Package 2 — UX fixes (2026-04-25)**

- `pipeline/proxy.py`: waveform: `s=800x80` (was 120×80), `scale=cbrt` with two-pass `volumedetect` normalization (boost by -peak_db so loudest = 0 dBFS = full bar height, capped at 40 dB). Codec-aware proxy: H.264/VP8/VP9 sources → emit `PROXY` with source path (WebView2 native, instant); HEVC/unknown → transcode 480p H.264.
- `src-tauri/src/db.rs`: `get_project_output_paths()` — queries `local_output_path` from `jobs` for a project.
- `src-tauri/src/lib.rs`: `delete_project_cmd` — calls `get_project_output_paths` + `remove_file` (best-effort) before DB rows deleted. Concurrency guard: `Arc<Mutex<HashSet<String>>>` managed state; `generate_proxies_cmd` skips duplicate calls for in-progress projects.
- `src/pages/Library.tsx`: `pendingDelete` state replaces `window.confirm()` (which is silently swallowed by WebView2). Inline confirmation panel per row; copy describes whether a render file will be removed.
- `src/pages/Upload.tsx`: `generate_proxies_cmd` fires immediately after `create_project`, before `navigate` — proxy gen starts while user is still on Trimmer clip 1.
- `src/pages/Trimmer.tsx`: `sourceFailed` boolean state — `onError` hides `<video>` and shows `<img src={thumbnail_data}>` fallback when WebView2 cannot decode the proxy (HEVC without extension, corrupt file). Reset on clip change. `videoCanPlay` state and disabled play button already in place.

**Batch 15c Package 1 — Pipeline + DB (C1 + C7) (2026-04-24)**

- `pipeline/proxy.py`: `extract_thumbnail()` extracts JPEG from source at 1s seek, emits `THUMBNAIL_DONE:clip_id=<id>,data=<data_uri>`. `extract_waveform()` renders 120×80 waveform PNG via `showwavespic=s=120x80:colors=0x22c55e:scale=cbrt`, emits `WAVEFORM_DONE:clip_id=<id>,data=<data_uri>`. Both run before proxy encode (fast-first ordering). `is_valid_proxy()` validates existing proxy files via ffprobe before skipping re-encode — catches corrupt files (missing moov atom). Proxy encode timeout raised to 600s. `-preset ultrafast -vf scale=-2:480`.
- `src-tauri/src/db.rs`: `waveform_data TEXT` additive migration (col 18), `update_clip_thumbnail()`, `update_clip_waveform()`. `Clip` struct + `get_project_with_clips` SELECT updated.
- `src-tauri/src/lib.rs`: manifest JSON per clip now includes `needs_thumbnail`, `needs_waveform`. `run_proxy_gen` parses `THUMBNAIL_DONE:` and `WAVEFORM_DONE:` lines, calls DB updaters, emits `thumbnail-progress` / `waveform-progress` Tauri events.
- `src/types/project.ts`: `waveform_data: string | null` added to `Clip` interface.
- `src/pages/Trimmer.tsx`: listeners for `thumbnail-progress` and `waveform-progress` events update clip state incrementally. Proxy status row ("Generating previews…" pulse + "Preview optimised" badge) removed — video player spinner overlay is sufficient feedback. `preload="auto"` + `play().then(pause)` first-frame paint fix (WebView2 black frame issue). `loadeddata` event gate ensures the paint runs after buffering.
- `src/components/trimmer/TrimBar.tsx`: `waveformData` prop renders waveform `<img>` at z-2 with `mix-blend-mode: screen` opacity 0.9.

**Batch 15a Groups A+B — Trimmer Polish (2026-04-05)**

- **A1** `src-tauri/src/db.rs`: `insert_clip` now explicitly writes `include = 0` in INSERT SQL — never relies on column DEFAULT (was `DEFAULT 1` from Batch 14c, so existing DBs still defaulted to 1). Root cause fixed.
- **A1** `src-tauri/src/lib.rs`: `include: 0` in `create_project` Clip struct for clarity
- **A1** `src/pages/Upload.tsx`: `metaToClip` `include: 0`
- **A2** `src/pages/Upload.tsx`: removed `view === "clips"` staging screen entirely — after scan completes, name modal appears directly over home view. Removed `handleContinueClick`, `ClipList` import, `handleDelete`, `handleReorder`. Derive project name inline from scan results.
- **A3** `src/components/trimmer/TrimBar.tsx`: timer row redesigned — static `0:00` far-left, static `fmtMs(durationMs)` far-right, centered `selected` label; floating handle labels above IN/OUT handles (position: absolute, `clampLabelPct` prevents overflow)
- **A4** All grey text → `#e5e5e5` in Trimmer.tsx, TrimBar.tsx, FilmStrip.tsx, MediaPantry.tsx, StepNav.tsx. Separator chars updated. Exception: TrimBar hint text stays subdued.
- **A5** `src/pages/Trimmer.tsx`: proxy status row — orange pulse during generation → green checkmark + "Preview optimised" static when `proxiesReady === true`
- **A6** `src/pages/Trimmer.tsx`: `onClick={togglePlay}` + `cursor-pointer` placed directly on `<video>` element (not wrapper div — video has no interactive children, no guard needed)
- **A7** `src/components/trimmer/TrimBar.tsx`: track base changed from `bg-black/50` to `rgba(255,255,255,0.08)` dark neutral surface; inactive regions are `rgba(0,0,0,0.55)` darker overlay on top
- **A8** `src/components/trimmer/TrimBar.tsx`: `currentMs: number` prop added; white vertical playhead line (`w-0.5 h-full bg-white/80 z-10`) positioned at `${playheadPct}%`. `src/pages/Trimmer.tsx`: `currentMs` state, `onTimeUpdate` + `onSeeked` on video element, reset to `inMs` on clip change.
- **B1** `src/components/trimmer/MediaPantry.tsx`: `draggable={true}` + `onDragStart={(e) => e.dataTransfer.setData("clipId", clip.id)}` on each tile. `src/components/trimmer/FilmStrip.tsx`: `onDragOver` + `onDrop` on container; `onAdd` prop; empty state text updated to "Drag clips here or use Add to Film". `src/pages/Trimmer.tsx`: `onAdd={(c) => handleToggleInclude(c, 1)}` wired.
- **TrimBar z-index documented:** z-0 base surface → z-1 inactive overlays → z-2 (future waveform slot) → z-3 selected region → z-10 playhead → z-20 handles
- `e2e/trimmer.spec.ts` written (12 assertions, 3 screenshots A/B/C auto-saved). `pnpm test:e2e:trimmer` added to package.json.
- E2E: 26/26 PASS (7 fast + 7 editor + 12 trimmer + 0 console errors)

**Batch 14e-core — "Build Your Film" redesign (2026-04-05)**

- `src-tauri/src/db.rs`: `reorder_clips()` helper (transaction, sort_order UPDATE per clip)
- `src-tauri/src/lib.rs`: `reorder_clips_cmd` Tauri command; registered in `generate_handler![]`
- `src/globals.css`: `rc-focal-pulse` + `rc-zoom-preview` keyframes
- `src/components/review/ClipNavStrip.tsx` (new): DnD thumbnail strip, auto-scroll, duration counter
- `src/pages/Review.tsx`: title → "Build Your Film", ClipNavStrip wired, focal animation, `saveCurrentClip()` helper, `isSaving` guard, `[review]` log instrumentation, Skip demoted to text-link, "Next →" primary CTA, autoPlay removed, progress bar removed, "Finish & Go to Editor" CTA removed
- 25/25 E2E PASS

**Batch 14e-hotfix (2026-04-05)**

- `Upload.tsx`: removed `REVIEW_THRESHOLD` — always routes to `/review/:projectId`
- Product direction pivot: task-based screen architecture decided (Upload→Trimmer→Transitions→Sound→Render)
- Explicit-add assembly model confirmed (was all-IN; changing in 15a when Trimmer ships)
- `docs/trimmer-designs.html`: Design A (pantry grid) chosen as Batch 15a blueprint

**Batch 14d — Quick Wins + Upload Delight (2026-04-03)**

- `Review.tsx`: back button `ml-10` clears fixed hamburger; proxy pending badge removed; centre focal point button removed; Skip Review gains `title` tooltip
- `Upload.tsx`: scanning overlay replaced — folder scan grows skeleton cards 1/200ms via setInterval (cap 24); file picker shows exactly N cards (`knownCount = paths.length`) with staggered fly-in (`animationDelay: i * 50ms`). Spinner + "Scanning your clips..." label retained alongside grid.
- `ClipList.tsx`: staggered `rc-fly-in` animation on cards (`index * 40ms` delay, cap 400ms)
- `src/globals.css`: `@keyframes rc-fly-in` added (opacity 0→1, translateY 10px→0)
- Skeleton cards use `aspect-video` (compact 16:9) not `aspect-square`
- E2E: 25/25 PASS

**Batch 14a — Review Screen UI (2026-04-02)**

- New route `/review/:projectId` added to App.tsx
- `src/pages/Review.tsx` (new): sequential clip review, Quick mode (Include/Skip + focal point picker), Precise mode (IN/OUT trim sliders + zoom preset chips)
- Video player: `convertFileSrc(proxy_path ?? local_path)`, "proxy pending" badge when no proxy yet
- Focal point: `position: relative` wrapper + transparent overlay div (click → focal_x/focal_y); visual dot indicator; "Centre focal point" reset
- Keyboard shortcuts: `Enter` = include, `Space` = skip; listener cleanup on unmount; `isSaving` ref guard vs rapid keypresses
- `sessionStorage` resume: `review_index_${projectId}` key — Back → return resumes at correct clip
- "Skip Review →" escape hatch in header; "Continue to Editor →" shortcut on last clip
- `update_clip_review_cmd` invoked per clip; navigates to `/editor/:projectId` on completion
- `src/lib/constants.ts` (new): `REVIEW_THRESHOLD = 5` — Upload navigates >5 clips to review, ≤5 direct to editor
- `tauri.conf.json`: asset protocol scope expanded from `C:\clips\processed\**` to `C:\**`, `D:\**`, `E:\**` — fixes 403 on source clip video playback
- E2E: 25/25 PASS (7 fast + 7 editor + 11 render)

**Batch 14b — Proxy Generation + Hygiene (2026-04-02)**

- `pipeline/proxy.py` (new): H.264 720p proxy encode per clip, `--manifest-path` protocol, per-clip `PROXY:clip_id=...,win_path=...` stdout, `-c:a copy` (audio stream-copied, not re-encoded), skips existing proxies, per-clip failure non-fatal
- `src-tauri/src/lib.rs`: `generate_proxies_cmd` (async Tauri command, filters `include!=0 && proxy_path IS NULL`, writes proxy manifest, spawns background WSL task); `run_proxy_gen` (stdout parser, calls `update_clip_proxy` per clip, emits `proxy-progress`/`proxy-done`/`proxy-error` events); registered in `generate_handler![]`; `update_clip_proxy` added to `use db::{}` imports
- `src/pages/Output.tsx`: proxy gen fires on `pipeline-done` (not on project create) — avoids WSL2 FFmpeg contention with render pipeline; `projectIdRef` captures project ID from job load
- `src/pages/Upload.tsx`: fire-and-forget removed (was firing on create, causing ~90s render slowdown)
- `pipeline/run.py`: `shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)` after copy — frees 1-3 GB WSL2 tmpfs per render immediately
- `pipeline/render.py`: rich `ANALYSIS:` line emitted at pipeline end (not mid-run): `raw_duration_s`, `output_duration_s`, `total_raw_mb`, `max_resolution`, `has_4k`, `audio_clip_count`, `normalise_s`, `render_s`, `total_s`, `music`, `cards`, `zoom`, `transition`; `t_wall_start` + named timing vars (`normalise_s`, `render_s`)
- Wrapup skill: added Windows temp manifest + WSL2 `/tmp/` cleanup commands to Step 5

**Batch 14c — Per-Clip Data Model (2026-04-01)**

- DB: 7 additive migrations on `clips` table: `in_ms`, `out_ms`, `focal_x`, `focal_y`, `zoom_mode`, `include` (default 1), `proxy_path`
- Rust: `Clip` struct extended; `get_project_with_clips` SELECT expanded to 18 cols with index comment map; `update_clip_review()` (clamps focal to 0.0-1.0); `update_clip_proxy()`
- Tauri: `update_clip_review_cmd` registered; `start_job` filters `include==0` clips, returns error on empty manifest, clamps `out_ms` to `duration_ms`, includes per-clip fields in manifest JSON
- TypeScript: `Clip` interface + 7 new fields; `metaToClip` updated with defaults
- Pipeline `render.py`: Step 2 user `in_ms`/`out_ms` override silence detection; Step 3 per-clip `zoom_mode` + focal point
- Pipeline `zoom.py`: 3 presets (gentle 1.1x / medium 1.3x / tight 1.5x), focal-aware x/y with edge clamping, diagnostic logging

**Batch 14-P — Pipeline Reliability (2026-04-01)**

- A/V sync fixed: root cause = hard-concat audio for 3+ clips assigns clip N audio a 1.5s late start at every cut after the first (audio cut at sum(durations[:N]) while xfade ends at sum(durations[:N]) − xfade_dur). Fix: pairwise chained `acrossfade` for ALL N>=2 clips. `apad=whole_dur=durations[i]` normalises each clip's audio duration to exact video frame boundary, so acrossfade start = xfade offset exactly.
- Music looping: N-copy pairwise chained acrossfade (replaced `-stream_loop -1`); `silencedetect` strips track intro/outro silence before tiling. Residual gap persists (track tail is low-energy, not silence); waveform-matching deferred.
- Per-clip normalise progress: `report_stage(f"Normalising clip {done} of {total}")` + per-clip `report()` remapping (10%→50% normalise, 52/55/60/80/88/95 for remainder).
- Library routing: processing project "Open" button navigates to `/output/:jobId` instead of editor.
- Persistent pipeline log: `run.py` `FileHandler` at `/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/pipeline-latest.log`.
- LEARNINGS.md + pipeline.md rules updated: `apad` + pairwise acrossfade is correct for 3+ clips.

**Batch 13b — Pipeline Fix + UI Cleanup + Post-batch Hotfixes (2026-03-29)**

- Motion scoring removed from `render.py`; `motion.py` kept as dead code
- `filter_boring` toggle removed from SettingsPanel
- Output filename: `slug-01.mp4` / `slug-02.mp4` per-project counter (Rust `lib.rs`)
- Volume chip color: `#FF8A65` → `#99B3FF` (docs/DESIGN.md updated)
- Per-stage timing logs in `render.py` (TIMING: prefix)
- Toggle translate-x visual bug fixed (`translate-x-5`)
- Post-batch hotfix: `transitions.py` — fixed-canvas pre-scale on every input (`[svN]` labels, both "none" and xfade paths) — fixes portrait+landscape crash (FFmpeg exit 234)
- Post-batch hotfix: `normalise.py` — final mode preset `fast` → `ultrafast` (~3min → ~60-90s normalise)
- Post-batch hotfix: `Output.tsx` — rolling 10-min inactivity timeout (resets on `pipeline-stage` events only, not progress ticks)
- E2E spec updates: clips capped to first 3, codec assertion height-only, Mocha timeout 600s, script timeout 90s
- E2E: 25/25 PASS

**Batch 13 — Motion Intelligence (2026-03-29)**

- `pipeline/motion.py` (NEW): FFmpeg scene-change scoring via `select='gt(scene,0.02)',metadata=print:file=-`; `score_clip()` single pass returning `(motion_score, scored_frames)`; `filter_by_motion()` with safety keep-all fallback; `find_peak_window()` sliding window, no extra FFmpeg pass
- `pipeline/beats.py` (NEW): `detect_beats()` via librosa; `snap_to_beat()` with tolerance; graceful fallback (returns `[]` on ImportError)
- `pipeline/render.py`: replaced freezedetect inline block; added motion filter (13a), clip cap by motion×sqrt(duration) (13b), peak-window trim (13c), beat-sync re-trim (13d); `ANALYSIS:clips_used=N,...` stdout protocol
- `pipeline/run.py`: `on_analysis` callback; `max_clips`, `target_clip_dur` forwarded; `filter_boring` default `True`
- `src-tauri/src/db.rs`: `analysis_summary TEXT` column; SQLite migration guard (`pragma_table_info` check); `update_job_analysis()` helper
- `src-tauri/src/lib.rs`: `ANALYSIS:` stdout prefix handler; calls `update_job_analysis`
- `src/types/project.ts`: `analysis_summary: string | null` on `Job`
- `src/components/editor/SettingsPanel.tsx`: Smart Clip Selection toggle row; `filter_boring` wired
- librosa 0.11.0 installed in WSL2 Ubuntu-24.04
- E2E: 25/25 PASS (fast suite)

**Batch 12b — Music Mode Presets + Spec Bug Fixes (2026-03-28)**

- `music_volume` type → `"subtle" | "balanced" | "prominent"` union (was `number` 0–100)
- SettingsPanel: 3-chip group (Subtle / Balanced / Prominent), conditional on `music_mood !== "none"`, Balanced default
- `run.py`: preset→float map `{subtle: 0.2, balanced: 0.4, prominent: 0.7}`; legacy numeric values fall back to 0.4
- E2E spec fixes: `expect(val,msg)` 2-arg (×2), progress poll race condition, filename slug regex → `.mp4` suffix check, `clip-item` testid added to `TimelineStrip.tsx`

**Batch 12 — QoL Fixes (2026-03-27)**

- Audio: `-ar 48000` added to all 6 FFmpeg re-encode sites; multi-clip path was missing `-c:a` entirely (silent bug fixed)
- Music volume: slider (0–100) in SettingsPanel; pipeline scales via `/ 100.0` in `run.py`; removed stale `MUSIC_VOLUME = 0.3` constant from `music.py`; `mix_music()` now takes `music_volume: float = 0.4` param
- Delete project: `delete_project_cmd` Rust command; manual delete order clips→jobs→projects (no FK cascade); Library UI with trash icon, `window.confirm`, optimistic list update
- Stale job cleanup: 60-min SQL UPDATE inside `list_projects_cmd`; jobs stuck in `processing` auto-failed
- Output timeout: 10-min `setTimeout` with `completedRef` guard; `useEffect` cleanup prevents unmounted-component warning
- `music_volume: 40` added to stale `DEFAULT_CONFIG` in `ConfigurePanel.tsx` to fix TS2741 error

**Batch 11c — UX Polish Round 2 (2026-03-27)**

- Home screen: two-card layout (Start New Project + Resume a Project), real thumbnails from `first_clip_thumbnail` (Rust subquery added to `list_projects`), dates in Resume section
- Mandatory project name modal before `create_project` is called; Skip button removed
- Scan spinner overlay during `scanning` state
- AppShell: shared `<AppShell>` wrapper with fixed NavDrawer; removed per-page NavDrawer inline usage
- Transition picker: None (default) / Crossfade / Dip to black; `DEFAULT_CONFIG.transition = "none"`
- `XFADE_DUR` increased to 1.5s; clamped to `min(1.5, min_clip_dur / 2.0)` to prevent short clip consumption
- Output page: elapsed count-up timer replacing static copy; "Starting up the magic..." initial stage; "My Projects" button top-right; project name displayed as `{name}.mp4`
- Open File button on Output done state (Rust `open_output_path` command using `explorer /select,`)
- Always-red bin icons in ClipList and timeline; CardBlock bins; card delete bins in SettingsPanel headers
- `#C5FFF9` Back buttons on Upload/Editor/Library; `#E1F2CE` My Projects button on Output
- E2E eval: 41/41 PASS (0 failures)

**Batch 11b — E2E Infrastructure + Eval Skill (2026-03-26)**

- WebdriverIO v9 + msedgedriver E2E scaffold; 3-layer BiDi fix; `rushcut-eval` skill; 33/35 PASS

---

## Deferred / Blocked

| Item                                       | Status                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| Motion scoring (boring filter)             | DEAD CODE — pipeline/motion.py kept, not called             |
| Beat-sync music cuts                       | Not required now — revisit if <1 min total                  |
| Music looping                              | FIXED Batch 14-P — N-copy acrossfade + silence-trim         |
| Music loop: waveform-matching loop point   | Future (Batch 15+) — find spectral-match point in track for zero-gap loop; may need AI/librosa |
| Audio/video sync drift                     | FIXED Batch 14-P — pairwise acrossfade chain (apad-aligned) |
| Hardware HEVC decode (`-hwaccel auto`)     | Batch 13c (probe WSL2 GPU passthrough, implement if viable) |
| Per-clip IN/OUT + trim (data model)        | DONE Batch 14c — pipeline wired, UI in 14a                  |
| Per-clip focal point + zoom (data model)   | DONE Batch 14c — pipeline wired, UI in 14a                  |
| Sequential clip review flow                | Batch 14a (Review screen UI)                                |
| Proxy files for HEVC scrubbing             | Batch 14b (next task)                                       |
| Per-clip transition picker                 | Batch 14+                                                   |
| Previewable transitions (proxy)            | Batch 14+ (proxy system needed)                             |
| Tabbed settings UI (Music / Effects / Text)| Batch 14                                                    |
| AI Director screen                         | Batch 15 (deprioritised)                                    |
| Auth / project library                     | Batch 16                                                    |
| 4K output                                  | Batch 16                                                    |
| Stripe / paid tier                         | Batch 16                                                    |
| Cloud mode (Vercel + Lambda)               | Phase 3                                                     |

---

## Key Decisions Since Phase 1

- **DEC-018:** Phase 2 gate = founder's own successful 60+ clip session (not paying users)
- **DEC-019:** Competitor research = web-only (desktop apps have different capability/latency profile)
- **DEC-020:** Stripe deferred until AI layer exists — charging for clip stitching has no lock-in
- **DEC-021:** "In the middle" positioning confirmed — direction power, not full auto-AI, not manual timeline
- **DEC-022:** Full local build — upload bottleneck (84 min for 19 GB session at 30 Mbps) makes cloud-upload model unworkable for real sessions. Phase 2 runs entirely on-machine via WSL2.
- **DEC-023:** Motion scoring removed — FFmpeg-per-clip scoring adds >10 min on 10 min footage; unacceptable. pipeline/motion.py kept as dead code only. May be revisited as a premium AI feature if total time can be <1 min.
- **DEC-024:** Product pivots to guided clip-review editor — user sets IN/OUT + focal point per clip; pipeline does deterministic assembly. No invisible auto-curation. "Anti-fake-AI, not anti-AI."
- **DEC-025:** AI policy = selective, user-visible only — AI only where improvement is demonstrable and sellable. Never for internals the user can't see or verify.
- **DEC-026:** Clip Review has two modes — Quick (default: Include/Skip + focal point only) and Precise (opt-in per clip: adds IN/OUT handles + zoom preset). Quick mode must be fast enough that a 60-clip session is not a chore. Do not force full manual trimming on every clip.
- **DEC-027:** Post-review Editor is intentionally minimal — reorder, music, transition, intro/outro, render. No feature creep. Any per-clip decision belongs in the Review screen, not the Editor.
- **Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."

Full decision log: `docs/DECISIONS.md`

---

## Live Infra State

- **Vercel:** Still deployed (git-main URL), but not the active dev target for Phase 2
- **Lambda:** Idle — retired as processing backend. Do not delete.
- **Supabase:** PAUSED — data preserved, restorable within 90 days. Not used in Phase 2.
- **R2:** DELETED — bucket emptied and removed.
- **Lambda / ECR:** DELETED — do not rebuild.
- **Local FFmpeg:** WSL2 Ubuntu-24.04, `/usr/bin/ffmpeg` (v6.1.1) — installed via `apt-get install -y --fix-missing ffmpeg`
- **SQLite:** `%APPDATA%\rushcut\rushcut.db` — created on first `pnpm dev`
