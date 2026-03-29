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

**Phase 2 — Batch 13 (Motion Intelligence) COMPLETE — with strategic pivot**

Batch 13 delivered: `pipeline/motion.py` (FFmpeg scene-change scoring, peak window trim), `pipeline/beats.py` (librosa beat detection + snap), `pipeline/render.py` rewrite (motion filter, clip cap, peak window trim, beat-sync steps), `pipeline/run.py` (forwarded max_clips, target_clip_dur, flipped filter_boring default), `src-tauri/src/db.rs` (analysis_summary column + migration guard), `src-tauri/src/lib.rs` (ANALYSIS: stdout parser), `src/types/project.ts` (analysis_summary field), `src/components/editor/SettingsPanel.tsx` (filter_boring toggle).

**STRATEGIC PIVOT (post-Batch 13 real-footage testing):** Motion scoring runs FFmpeg once per clip before encoding — on 10 min / 6 GB footage this adds >10 min processing time. User decision: remove motion scoring entirely if it cannot be brought under ~1 min total. Product direction shifts from auto-curation to **guided clip-review editor** (user sets IN/OUT + focal point per clip, pipeline does deterministic assembly). AI policy updated: AI only where user-visible improvement is demonstrable — never invisible internals. Beat-sync explicitly "not required now."

---

## Immediate Next Task

**Batch 13b — Pipeline Fix + UI Cleanup** (see scope below)

---

## Batch 13b Scope

Priority order — implement all before Batch 14:

1. **Remove motion scoring from pipeline** — `motion.py` kept as dead code (future premium AI feature), but NOT called from `render.py`. Remove `filter_by_motion`, `find_peak_window`, `scored_frames_map` wiring from render.py. Remove `filter_boring` from the active config path in `run.py`. Revert peak-window trim back to silence trim (detect.py) as default. Beat-sync steps may stay as stubs but must not slow pipeline.
2. **Hide filter_boring toggle** — remove "Smart Clip Selection" row from SettingsPanel (the toggle is meaningless without motion scoring). Keep `filter_boring` in `JobConfig` type for future use, just don't render it.
3. **Filename versioning** — output filename changes from `slug-{8-char-uuid}.mp4` to `slug-01.mp4`, `slug-02.mp4` etc (per-project counter). Rust `lib.rs` must query count of existing output files matching `slug-NN.mp4` and pick next N.
4. **Volume chip color** — change from `#FF8A65` (orange) to `#99B3FF` (blue) for music volume preset chips (Subtle/Balanced/Prominent). Document in `docs/DESIGN.md`.
5. **Per-stage timing logs** — add `time.time()` instrumentation to `render.py` at each major stage boundary; emit `STAGE:Timing: <stage>=<elapsed>s` lines so Rust log output makes bottlenecks visible.
6. **Fix toggle translate-x visual bug** — "on" state thumb doesn't visually reach the right end. Audit `h-5 w-9` container vs `h-3.5 w-3.5` thumb vs `translate-x-4` — adjust translate value so thumb sits flush-right when active.

---

## Recently Completed

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

| Item                                       | Status                                          |
| ------------------------------------------ | ----------------------------------------------- |
| Motion scoring (boring filter)             | DEAD CODE — pipeline/motion.py kept, not called |
| Beat-sync music cuts                       | Not required now — revisit if <1 min total      |
| Per-clip IN/OUT handles + trim             | Batch 14 (Clip Review screen)                   |
| Per-clip focal point + deterministic zoom  | Batch 14 (Clip Review screen)                   |
| Sequential clip review flow                | Batch 14 (replaces old Clip Editor concept)     |
| Per-clip transition picker                 | Batch 14+                                       |
| Previewable transitions (proxy)            | Batch 14+ (proxy system needed)                 |
| Proxy files for HEVC scrubbing             | Batch 14 (prerequisite for fast scrub)          |
| Tabbed settings UI (Music / Effects / Text)| Batch 14                                        |
| AI Director screen                         | Batch 15 (deprioritised)                        |
| Auth / project library                     | Batch 16                                        |
| 4K output                                  | Batch 16                                        |
| Stripe / paid tier                         | Batch 16                                        |
| Cloud mode (Vercel + Lambda)               | Phase 3                                         |

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
