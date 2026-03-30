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

**Phase 2 — Batch 13c PARTIAL. Next: Batch 13d (sync fix + loop crossfade + music volume balance).**

Batch 13c delivered: music looping (`-stream_loop -1` + `asetpts=PTS-STARTPTS`), A/V sync logging (`[sync-check]` lines after normalise + post-trim), hwaccel probed (Vulkan extension absent — skipped). E2E: 25/25 PASS.

**Real-footage testing observations (3 DJI 4K landscape clips, 3840×2160):**
- Music loops correctly — but audible gap between loop iterations (crossfade at loop boundary still needed)
- Audio/video sync still drifting — logs now in place; root cause not yet analysed
- Music volume too loud relative to clip audio — relative balance control needed urgently
- Build time 5.5 min for 3 clips — hwaccel not viable (Vulkan extension missing); further investigation needed
- Hardware HEVC decode: `/dev/dxg` present but `VK_KHR_video_decode_queue` not supported; CUDA/VDPAU absent. `ultrafast` software decode is the current ceiling.

---

## Immediate Next Task

**Batch 13d — Sync Fix + Music Polish**

---

## Batch 13d Scope

1. **Loop crossfade** — `music.py`: add `acrossfade` at the loop boundary so track iterations blend seamlessly rather than cutting hard.
2. **A/V sync fix** — analyse `[sync-check]` logs from a real render; identify drift origin (normalise resampling, silence-trim boundary, or concat offset); fix the root cause.
3. **Relative music volume** — expose a per-render music/clip loudness balance. Current `music_volume` presets (subtle/balanced/prominent) set an absolute music level but don't adapt to clip audio levels. Consider: measure average clip audio dBFS at normalise time and scale music target accordingly, or add a `clip_volume` companion preset.
4. **Build speed** — investigate normalise parallelisation (concurrent `subprocess.run` for N clips); target <2 min for 3×4K clips.

---

## Recently Completed

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
| Music looping                              | Batch 13c (music.py `-stream_loop -1`)                      |
| Audio/video sync drift                     | Batch 13c (log first, fix after root cause confirmed)       |
| Hardware HEVC decode (`-hwaccel auto`)     | Batch 13c (probe WSL2 GPU passthrough, implement if viable) |
| Per-clip IN/OUT handles + trim             | Batch 14 (Clip Review screen)                               |
| Per-clip focal point + deterministic zoom  | Batch 14 (Clip Review screen)                               |
| Sequential clip review flow                | Batch 14 (replaces old Clip Editor concept)                 |
| Proxy files for HEVC scrubbing             | Batch 14 — first task (scrubbing unusable without proxies)  |
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
