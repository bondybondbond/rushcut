# RushCut — Batch U1 Sub-batches (U1b–U1e)

## Context

U1a (stage/timer persistence, single-job guard, crash diagnosis) was implemented and E2E-verified (9/9 fast, 14/14 render). During live testing of the real 19-clip 4K "Stagecoach 2025" film, additional failures were observed that U1a did not cover. These are documented here as U1b–U1e, ordered by priority.

**What happened during U1a verification:**
- Render started on the new U1a binary. Timer correctly continued across navigations (confirmed U1a stage/timer fix working). DB confirmed `current_stage='Rendering'` persisted.
- E2E regression tests (`pnpm test:e2e` + `pnpm test:e2e:render`) were run mid-render. WDIO's `beforeSession` hook kills all `rushcut.exe` processes — this silently killed the user's render binary. The pipeline kept running in WSL and completed, writing `stagecoach-2025-01.mp4` (356MB, 2:44). But the new binary had no Rust stdout listener to receive `DONE:`, so the job stayed `processing` in the DB.
- UI stuck at 68%. Required manual SQL via PowerShell to promote job to `done`. Unacceptable for users.
- When the film was finally viewable, the output had render quality issues: music absent or lagging, transitions not applied, opening/closing cards missing, per-clip muting not applied. Root cause unknown — needs log investigation.
- Additional UX bug: clicking "Render new version" (1080p) and navigating away before `start_job` completed silently cancelled the invoke — no new job was created. Returning to Render screen showed old 4K done state with no indication a new render was attempted. User cannot tell if the 1080p render is in progress, pending, or lost.

---

## Batch U1b — Render quality investigation + fix — HIGHEST PRIORITY

**Problem:** The rendered film was missing music, transitions, opening/closing cards, and per-clip muting. Only trimming was applied. The render completed (pipeline said `Pipeline complete`, file exists), but settings were either not written to the manifest, not parsed by `run.py`, or not applied by `render.py`.

**Rule: log first, do not write a single line of fix code until the pipeline log is read.** The temptation is to jump straight to patching `buildJobConfig.ts` — resist it. The log will tell you exactly where the chain broke.

**Step 1 — Read the log (do this before anything else):**
1. Read `pipeline-{job_id}.log` for job `d199eb54-46b4-447c-b76b-0cd1aebc373d`. Look for:
   - Were `music_mood`, `transition`, `intro_text`/`outro_text`, `clip_volume` present in the manifest JSON logged at pipeline start?
   - Did `render.py` reach Step 5 (xfade/transitions)? Step 6 (music mix)? Cards (`cards.py`)?
   - Did `run.py` apply cards config (`intro_on`, `outro_on`)?
   - Any `KeyError`, missing field warning, or silent default fallback lines?
2. Read `%TEMP%\rushcut\<job_id>.json` (the manifest) if still present — confirms what Rust actually wrote.

**Step 2 — Only after reading logs, trace the chain:**
3. Check `buildJobConfig.ts` — are all settings (music, transition, cards, clip volumes, intro_on, outro_on, music_fade_out) correctly serialised from sessionStorage?
4. Check `start_job` in `lib.rs` — are all `JobConfig` fields forwarded into the manifest JSON?
5. Check `run.py` `JobConfig` dataclass — any field added in a later batch but missing here silently defaults.

**Also confirm (one log check closes it):** The "Optimising clips... 1/19 ready" counter visible during the U1a live test was UI initialisation noise, not re-encoding. 2160p proxies qualify for 1080p renders (height gate: 2160 >= 1080). Confirm via the pipeline log: look for `proxy_skip=N/N` in the `TIMING:normalise=` line — if N > 0 proxies were reused, no re-encoding happened.

**Likely suspects (grep before assuming):**
- `buildJobConfig.ts` missing fields added in later batches (cards, per-clip volume, muting, music_fade_out)
- `start_job` Rust manifest builder not including recently added fields
- `run.py` `JobConfig` dataclass missing fields → silently using defaults

**Verify:** Render a film with music, transitions, a start card, and at least one muted clip. Confirm output video has audible music, visual transitions, start card visible, muted clip is silent. Check `pipeline-latest.log` for `[music]`, `[cards]`, xfade filter lines, and per-clip `clip_volume` values.

---

## Batch U1c — Startup self-heal for stuck jobs

**Problem:** If the binary is killed while a pipeline is running (SIGTERM, crash, WDIO test, system reboot), and the pipeline subsequently completes in WSL, the job stays `processing` in the DB forever. The user sees a stuck progress bar. The only fix today is a developer running SQL. The 60-min auto-fail in `list_projects()` helps eventually, but (a) it requires the user to open Library, (b) 60 min is too long, and (c) if the file was produced it should show as done, not failed.

**Changes:**

1. **In `setup()` (lib.rs), after `reset_all_encoding_claims`:**
   Add a check for every "processing" job older than 60 seconds:
   - If `local_output_path` is set AND the file exists on disk → call `update_job_done()` to mark it done.
   - If `local_output_path` is set AND the file does NOT exist → call `update_job_error("Pipeline did not complete -- please try again")` to mark it failed (frees the single-job guard for a retry).
   - If `local_output_path` is not set → leave it (job was killed before the output path was even determined; the 60-min auto-fail in `list_projects()` covers this).
   - The 60-second guard prevents clobbering a job that genuinely started 5 seconds ago on the other binary (two-instances-share-one-DB safety).

2. **No UI change needed** — `get_render_status_cmd` already shows done state when the job is `done`; self-heal in `setup()` means the fix is visible the next time the user opens the app.

**Verify:** Start a render, kill the binary via Task Manager while pipeline is running in WSL, wait for the pipeline to complete (watch `pipeline-latest.log`), relaunch binary, navigate to Render screen → should show "Your film" done state without any SQL intervention.

---

## Batch U1d — New render visibility + nav-guard

**Two related bugs observed in one session:**

**Scope risk on Bug 1 — diagnose before coding.** The assumption is that navigating away mid-invoke cancels the invoke. Verify this first: add a `console.log` before and after the `invoke("start_job", ...)` call, navigate away, and check browser console to confirm whether the invoke resolves or throws. It is possible the invoke completes (Rust processes it) and the job IS created — but `Render.tsx` unmounts and never receives the resolved job ID. If that is the case, the fix is "re-attach to the new job on next mount" rather than "guard the invoke". Do not ship a navigation confirm dialog until you know whether the job was created at all.

### Bug 1 — `start_job` possibly silently cancelled by navigation
When the user clicks "Render Film" and navigates away before the async `invoke("start_job", ...)` resolves, the React component unmounts. The invoke may be abandoned (job never created) or may resolve after unmount (job created, not attached). The user has no idea which.

**Diagnose first:** Check browser console for invoke errors. Check the DB (`invoke("list_projects_cmd")` via CDP) for a new job row after the scenario. Determine whether the job was created or not.

**Fix (after diagnosis):** If job was NOT created — simplest fix is a navigation guard (confirm dialog: "A render is starting -- leaving now will cancel it. Continue?") while `phase === "starting"`. If job WAS created — the fix is re-attach logic on next mount that checks for a recently-started job (within ~30s) for this project, not just an active one.

### Bug 2 — Old done state hides new render in progress
After a render completes (done state showing), clicking "Render new version" starts a new job. If the user navigates away and comes back quickly, `get_render_status_cmd` returns the new processing job AND the previous done job. If the re-render completes very quickly (proxy-skip path), the user returns to see the old film's done state with the old timestamp and no indication the new render ran.

**Fix:** `get_render_status_cmd` already returns both `active_job` and `latest_render`. Check: does the done-state filename update to `stagecoach-2025-02.mp4` (the new file)? If the re-render produces a new sequential filename, the filename is the natural signal. If not, display `created_at` prominently on the done state so a changed timestamp is visible.

**Verify:** Start a render. While rendering, navigate away and back — confirm "in progress" state is shown, not old done state. Start a new version, navigate away before it completes, come back — confirm new done state (new filename, new timestamp) is shown.

---

## Batch U1e — Stalled render detection

**Problem:** The elapsed timer keeps counting even when the pipeline has died (binary killed, WSL OOM, SIGTERM). Users see "14m 23s elapsed" with a frozen progress bar and no idea if the render is still running or has silently failed. There is no feedback until the error event arrives (which never arrives if the Rust listener is dead).

**Fix:**
1. In `Render.tsx`, track `lastProgressAt` (timestamp of last `pipeline-progress` event received while in "rendering" phase).
2. A separate `useEffect` checks every 30 seconds: if `Date.now() - lastProgressAt > 120_000` (2 min no progress), set a `stalled` boolean.
3. When `stalled` is true, show a secondary warning below the progress bar: `"This is taking longer than expected -- the render may have stalled. You can wait or try again."` with a "Try Again" link.
4. Stall detection resets on any new `pipeline-progress` event (long stages like xfade render legitimately produce no progress for 2-3 min; 2 min threshold is a balance).

**Note:** This is a UI-only change (no Rust/pipeline). It does not fix the underlying stuck-job problem (that is U1c) — it just surfaces it to the user sooner so they are not left staring at a running timer.

**Verify:** Start a render, kill `run.py` in WSL, wait 2 minutes → stall warning should appear. Click "Try Again" → new render starts reusing proxies.

---

## Backlog (not in U1 sub-batches)

- **Re-proxy efficiency for resolution downscale:** 2160p proxies already cover 1080p renders (height gate: `2160 >= 1080`). The "Optimising clips... 1/19 ready" display during the starting phase is the proxy-status UI initialising, not re-encoding. No re-proxy actually occurs on resolution downscale. Closed by the `proxy_skip=N/N` log check in U1b diagnosis. The question of producing a dedicated 1080p proxy set is a separate large job — not worthwhile given 2160p proxies already work for 1080p output.

---

## Priority order

1. **U1b** — Render quality (pipeline output missing music/transitions/cards). Product value is broken if the film is wrong. **Log first — no code until the pipeline log is read.**
2. **U1c** — Startup self-heal (~10-line Rust change, zero risk). No SQL for users ever again. Ship immediately after U1b.
3. **U1d** — New render visibility + nav-guard. Design-complex; diagnose Bug 1 (invoke cancelled vs. orphaned) before coding. Do not let this block U1c.
4. **U1e** — Stalled render detection (timer honesty when pipeline is dead).
