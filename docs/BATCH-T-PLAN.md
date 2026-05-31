# Batch T — Library, Proxy Dedup, Gate UX, Resume Flow

## Overview

Four sub-batches addressing: Library display bugs, proxy generation
efficiency, render gate UX, and mid-render resume. Execute in order —
T2 is the core structural fix that makes T3 simpler; T3 should not
ship before T2.

---

## T1 — Library clip count fix

**Problem:** Library shows total DB rows (source clips + cuts = e.g. 11),
not meaningful clip count. A project with 3 raw files and 8 cuts shows
"11 clips". Correct display is 8 (included cuts in film) or "3 sources,
8 cuts" — but NOT raw DB row count.

**Root cause:** `list_projects` DB query or the React rendering is
counting ALL clips rows for a project without filtering to `include=1`
or cuts only.

**Fix scope:** One DB query or one React display line. No pipeline change.

**Acceptance:** Library card shows 8 (number of cuts user added to film),
not 11. "View all projects" row matches.

**Effort:** ~15 min. Zero risk.

---

## T2 — Proxy deduplication by source file

**Problem:** 8 cuts from 3 raw source files generates 8 proxy encodes.
Cuts 1, 3, 5 all point to `DJI_0001.MP4` — encoding it three times is
wasted work. 3 source files should produce exactly 3 proxy encodes;
all cuts sharing a source reuse the same proxy file.

**Why this is the right model:** A proxy is a full-duration re-encode of
the source file. The `in_ms`/`out_ms` trim is applied at render time
(Step 2 in `render.py`), not at proxy gen time. So one proxy covers all
cuts from the same source.

**Data model change:**
- Group clips by `local_path` before encoding in `run_bg_proxy_batch`
- Encode once per unique `local_path`
- On completion, call `update_clip_proxy` for ALL clips in the project
  sharing that `local_path` (fan-out DB update)
- Gate readiness check is unchanged — it reads `proxy_path` per included
  clip; with dedup, all 8 cuts already have `proxy_path` set once the
  3 source proxies are done

**Proxy filename:** Currently `{clip_id}.mp4`. With dedup, use a stable
hash of `local_path` (e.g. SHA-1 first 12 chars) so the same source
always maps to the same proxy file. This also enables cross-project
reuse: if the user creates a new project from the same folder, the
proxies are already warm.

**Render gate effect:** Gate shows 3 tiles (source files), not 8. This
is the honest representation — you are waiting on 3 encodes.

**Render.py effect:** `render.py` proxy reuse gate checks height + fps
on the proxy file per clip. With shared proxies, all cuts get the
same proxy path — no change to render.py required.

**Log first:** Before any code change, add a log line in the current
`run_bg_proxy_batch` that prints: clip_id, local_path, and whether
a proxy for that local_path already exists. Run once and confirm the
duplication is real and matches expectations.

**Acceptance:**
- `proxy-bg.log`: 3 `batch-start` clip entries, not 8, for a 3-source / 8-cut project
- All 8 included clips show green tiles on Render gate after 3 encodes complete
- Re-opening the same source folder for a new project: proxies reused immediately (0 encodes)
- No proxy file corruption; `ffprobe` validates all 3 proxy files

**Effort:** Medium. Core change is `run_bg_proxy_batch` (dedup + fan-out)
and proxy filename scheme. No pipeline Python change needed.

---

## T3 — Fold gate into render pipeline as a named stage

**DO NOT START before T2 is confirmed working.**

**Current behaviour:** `awaiting-proxies` is a blocking screen — user
sees pulsing tiles and a timer, must wait or click "Start anyway
(slower)". With T2 done, this screen shows 3 tiles not 8, and 3 AMF
encodes complete in ~3 min. The screen is less bad but still exists.

**Proposed behaviour:** No separate blocking screen. The render pipeline
starts immediately. If all proxies are ready, the existing fast path
runs unchanged. If proxies are still building, the render shows
"Preparing clips (2/3 ready...)" as the first named stage in the
existing progress bar — same bar as "Encoding" and "Finishing". When
the last proxy lands, the pipeline automatically advances.

**IMPORTANT — pipeline-touching, not just UI:**

The gate currently acts as a synchronisation barrier: render does NOT
start until all proxies are confirmed valid. Removing the barrier means
the render pipeline must handle the case where a clip's proxy is not
yet ready at the moment it needs to be processed.

Two options:

**Option A — Wait inline (simpler, safer):** The pipeline still waits
for all proxies before starting Step 2. The difference is purely UI:
instead of a separate screen, the wait is shown as "Stage 1: Preparing
clips" in the existing progress bar. The barrier is preserved; only
the visual treatment changes. This is the recommended option.

**Option B — Fallback to normalise per clip (complex):** Each clip is
processed as soon as its proxy is ready (or falls back to normalise if
the proxy is still encoding). This requires Step-level parallelism in
`render.py` and careful ordering. Do not implement without explicit
spec and log-first verification that normalise quality is equivalent
to proxy reuse for the specific clips involved.

**Devil's advocate:** The gate exists for a reason. If Option B is chosen
and normalise produces different output quality (e.g. colour space
differences, audio offset), users will see inconsistent export quality
with no visible explanation. Confirm normalise-vs-proxy output is
bit-identical or visually equivalent before removing the barrier.

**Recommendation:** Ship Option A for T3. Option B is a separate batch
(T3b) with explicit spec and A/B quality comparison.

**Acceptance (Option A):**
- Render screen shows single continuous progress bar from click
- First stage label reads "Preparing clips — X/N ready" during proxy wait
- No separate blocking screen; no "Start anyway" button
- When all proxies are ready, pipeline advances automatically (same as today)
- 1080p non-4K projects: no wait stage (proxy gate does not apply)

**Effort:** Medium-UI. Render.tsx state machine change. No Python change
(Option A). Confirm Option before starting.

---

## T4 — Live progress + smart Open routing

**DEFINE THE STATE MACHINE BEFORE CODING.**

A project is always in exactly one of these states:

| State | Condition | Library card shows | "Open" routes to |
|---|---|---|---|
| `idle` | No jobs ever | — | Trimmer |
| `rendering` | Job status = 'processing' | "Rendering — 55%" (live) | Render screen (rendering phase) |
| `done` | Job status = 'done' | "Last render: 2h ago · 1080p" | Render screen (done phase, video player) |
| `error` | Job status = 'failed' | "Render failed" | Render screen (error phase) |

**Library live progress:** Rust already emits `pipeline-progress` events
with `{ jobId, progress }`. Library needs to:
1. On mount, check if any open job exists for each listed project (query `jobs` table for latest job per project)
2. Subscribe to `pipeline-progress` events; match `jobId` to project; update card progress live
3. Subscribe to `pipeline-done` / `pipeline-error` events; update state

**Smart Open routing:** On "Open" click, check latest job status for
project. Route to Render screen (with correct phase pre-loaded) if
job is active or completed. Route to Trimmer if no job or job is
idle/cancelled.

**Render screen done-state:** Currently the done phase shows the output
video player and filename. This needs to also show: render timestamp,
output resolution, duration, and a "Render again" CTA (not the default
action — just available).

**Effort:** Medium-frontend. No Rust/pipeline change. Library.tsx +
Render.tsx changes only. State machine must be reviewed before coding
starts — Claude must be given the explicit map above, not asked to
infer it.

---

## Batch order

```
T1 (15 min) → T2 (log first, then deduplicate) → T3 (Option A only,
after T2 confirmed) → T4 (state machine spec review before coding)
```

**Do not combine T2 and T3 into one batch.** T2 is a data model change;
T3 is a UI/flow change. Running them together makes it impossible to
isolate regressions.

---

## Open questions before T3

1. Is normalise output quality bit-identical to proxy reuse output?
   (Affects whether Option B is ever viable)
2. For T3 Option A: should the "Preparing clips" stage show elapsed
   time or an ETA? (ETA requires knowing encode rate per clip)
3. For T4: is there a maximum number of jobs to show per project in
   Library, or just the most recent?
