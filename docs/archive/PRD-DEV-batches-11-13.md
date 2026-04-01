# Archived Batch Specs — Batches 11b through 13c

> Moved from PRD-DEV.md on 2026-04-01. These batches are fully delivered.
> Kept for reference: E2E setup rationale, UX design decisions, and the motion-scoring pivot story.
> LEARNINGS.md has the technical lessons. DECISIONS.md has the strategic decisions.

---

## Batch 11b — Autonomous E2E Testing (tauri-driver)

> **Goal:** Claude can see what the user sees. After every code session, Claude runs a full UI walk-through — upload clips, render, check output — without a human in the loop.
> **Estimate:** 2–4 hrs setup, then zero ongoing cost.
> **Why now:** Batch 11 UI changes were verified by TypeScript + build only. Claude could not click buttons or watch the video player. This batch fixes that permanently.

### Why the browser preview doesn't work

RushCut renders blank in a standard headless browser because `window.__TAURI_INTERNALS__` is not injected outside the Tauri WebView. `invoke()`, `listen()`, and `convertFileSrc()` all depend on it. The only way to drive the real app is via the compiled Tauri binary.

### 11b-1 — Add `data-testid` attributes to key elements

| Element                | `data-testid`       |
| ---------------------- | ------------------- |
| "Choose Folder" button | `btn-choose-folder` |
| "Add Files" button     | `btn-add-files`     |
| Clip list item         | `clip-item`         |
| Continue/Render button | `btn-render`        |
| Project name heading   | `project-name`      |
| Hamburger nav button   | `btn-nav-open`      |
| Music chip (each mood) | `chip-music-{mood}` |
| Intro text input       | `input-intro-text`  |
| Outro text input       | `input-outro-text`  |
| Progress bar           | `progress-bar`      |
| Output video player    | `video-player`      |
| Output filename label  | `output-filename`   |

Files touched: `Upload.tsx`, `Editor.tsx`, `SettingsPanel.tsx`, `Output.tsx`, `NavDrawer.tsx`

### 11b-2 — Install tauri-driver + msedgedriver

```powershell
# From PowerShell (NOT Git Bash — paths get mangled)
cargo install tauri-driver
# Drop msedgedriver.exe matching Edge version into PATH (e.g. C:\tools\)
```

Key config gotcha: All paths in `wdio.conf.ts` must be Windows-native (`C:\...`). Run `pnpm test:e2e` from PowerShell only.

**3-layer BiDi fix (critical — do not remove):**
- `--disable-bidi` on msedgedriver spawn
- `webSocketUrl: false` in capabilities
- Route-aware `waitForAppRoute()` readiness gate

### 11b-3 — Smoke test suite

Three specs in `e2e/`:
- **Spec 1 (upload):** App opens, Upload screen visible, nav drawer opens/closes
- **Spec 2 (editor):** Project name editable, music default "No Music", Back navigates to Library
- **Spec 3 (render):** Scan → clips appear → Render → progress increments → video player src set

### Gate

> **Delivered 2026-03-26.** WebdriverIO v9 + msedgedriver with 3-layer BiDi fix. `rushcut-eval` skill created. 33/35 PASS. Two permanent SKIPs: Upload page clip display (native file dialog bypasses React state).

---

## Batch 11c — UX Polish Round 2

> **Goal:** Close remaining UX gaps from second round of post-Batch-11 feedback. All items UI-only or pipeline config fixes — no new Rust commands.
> **Estimate:** 3–5 hrs.

### 11c-1 — Mandatory project name prompt

After user selects clips and clicks Continue (before `create_project`), show a name prompt modal:
- Single required input, min 2 chars
- Placeholder: "e.g. Dolomites Trip, Summer 2026"
- CTA: "Create Project" (disabled until name entered)
- Small "Skip" link (uses folder name as fallback)

### 11c-2 — Scan loading spinner

During `scanning` state in `Upload.tsx`, show spinner overlay with "Scanning your clips..." instead of silent grey-out.

### 11c-3 — Home screen redesign

Two-card layout: **Start New Project** (left, peach) + **Resume a Project** (right, sand). Resume shows 3 most recent projects with real thumbnails (from `first_clip_thumbnail` Rust subquery). No previous projects = placeholder copy.

### 11c-4 — Restore transition picker

SettingsPanel: None (default) / Crossfade / Dip to black chip group. `DEFAULT_CONFIG.transition = "none"`.

### 11c-5 — AppShell + fixed nav drawer

`<AppShell>` wrapper renders NavDrawer at fixed `top-4 left-4 z-50` on all screens. Remove per-page `<NavDrawer />` inline usage.

### 11c-6 — Open File button on Output screen

"Open File" button → `invoke("open_output_path", { path })` → `explorer.exe /select,<path>`. New Rust command.

### 11c-7 — Output screen: elapsed timer

Replace static copy with live elapsed count-up timer. Remove "switch tabs" (browser-only advice).

### Gate

> **Delivered 2026-03-27.** All 7 tasks complete. E2E eval 41/41 PASS.

---

## Batch 13 — Motion Intelligence

> **Goal:** A 60+ clip DJI session produces a watchable 3–6 min film with no manual clip curation.
> **Estimate:** 2–3 days (pipeline only — no new screens, no new Rust commands).
> Note: Gemini API deferred. All intelligence is FFmpeg/librosa-only.

### 13a — Boring clip filter (motion scoring)

Score each clip via FFmpeg scene change detection:
```python
ffmpeg -i clip.mp4 -vf "select='gt(scene,0.02)',metadata=print:file=-" -an -f null -
```
Parse scores → `motion_score: float` per clip. Auto-exclude clips below threshold (default 0.015).

### 13b — Smart clip cap

When >N clips remain after motion filtering (default N=20), rank by `motion_score × duration_weight`, keep top N. Log excluded clips to job metadata.

### 13c — Peak window detection

Per clip, find best-N-seconds window using motion score at 0.5s intervals. Return `(start_ms, end_ms)` as default in/out. Replaces silence-trim as default trim heuristic. User handles always win.

### 13d — Beat-sync music cuts

Via librosa: detect beat times in selected track. Snap xfade cut points to nearest beat within ±0.3s.

### Gate

> **Delivered 2026-03-29.** motion.py, beats.py, render.py rewrite, db analysis_summary, SettingsPanel toggle. E2E: 25/25 PASS.
>
> **PIVOTED:** Motion scoring subsequently found to add >10 min on 10 min footage. Removed in Batch 13b (DEC-023). Product direction changed to user-directed clip review (Batch 14).

---

## Batch 13b — Pipeline Fix + UI Cleanup

> **Goal:** Remove motion scoring overhead, fix UI polish bugs, add pipeline timing diagnostics.
> **Estimate:** 2–4 hrs.

### 13b-1 — Remove motion scoring from pipeline

- Remove `filter_by_motion`, `find_peak_window`, `scored_frames_map` from `render.py`
- Revert trim heuristic: use `detect.py` silence trim (pre-Batch-13 behaviour)
- `pipeline/motion.py`: keep as dead code only — not called

### 13b-2 — Hide filter_boring toggle

Remove "Smart Clip Selection" row from SettingsPanel. Keep `filter_boring` in TypeScript types.

### 13b-3 — Filename versioning

Output: `slug-01.mp4`, `slug-02.mp4` per-project counter (not `slug-{uuid}.mp4`). Rust `lib.rs` counts existing `<slug>-NN.mp4` files, picks next N.

### 13b-4 — Volume chip color

Music volume preset chips: `#FF8A65` (orange) → `#99B3FF` (blue). Documented in DESIGN.md.

### 13b-5 — Per-stage timing logs

`render.py`: record `time.time()` at each stage boundary, emit `STAGE:Timing: <stage>=<elapsed:.1f>s`.

### 13b-6 — Fix toggle translate-x visual bug

`translate-x-[18px]` on "On" state so thumb reaches flush-right with 2px padding.

### Gate

> **Delivered 2026-03-29.** All 6 tasks complete.
> Post-batch hotfixes also shipped:
> - `transitions.py`: fixed-canvas pre-scale (`[svN]` labels) on ALL inputs before concat/xfade — fixes portrait+landscape crash (FFmpeg exit 234)
> - `normalise.py`: final mode preset `fast` → `ultrafast` (~3 min → ~60–90s)
> - `Output.tsx`: rolling 10-min inactivity timeout (resets on `pipeline-stage` events only)
>
> E2E: 25/25 PASS.

---

## Batch 13c — Pipeline Reliability + Speed

> **Goal:** Fix remaining pipeline bugs from real 4K footage testing. No new features — reliability only.
> **Estimate:** 1–2 days.

### 13c-1 — Music looping

`pipeline/music.py`: use `-stream_loop -1` on music input to loop indefinitely, trim to exact film duration. Add `-af "afade=t=out:st=<end-2>:d=2"` for clean fade.

Critical ordering fix: `asetpts=PTS-STARTPTS` BEFORE `atrim` — `-stream_loop -1` assigns continuously rising PTS; trimming before reset cuts too early.

### 13c-2 — Audio/video sync investigation

Add `[sync-check]` PTS log lines at normalise output, post-trim, and concat input. Reproduce with known drifting clip pair. Fix only after root cause confirmed.

### 13c-3 — Hardware HEVC decode

Probe: `ls /dev/dxg` + `ffmpeg -hwaccels` in WSL2. If GPU passthrough active, add `-hwaccel auto`.

**Result:** `/dev/dxg` present but `VK_KHR_video_decode_queue` not supported. CUDA/VDPAU absent. Software HEVC decode is the ceiling. Commented in `normalise.py`.

### Gate

> **Delivered 2026-03-30.** Music looping shipped. `[sync-check]` logging in place. Hwaccel confirmed non-viable.
> Remaining items (loop crossfade, sync root-cause fix, relative music volume) deferred → Batch 13d attempted and reverted → fixed in Batch 14-P.
