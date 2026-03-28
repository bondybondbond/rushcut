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

**Phase 2 — Batch 12 (QoL Fixes) COMPLETE**

Batch 12 delivered: audio `-ar 48000` enforced at all 6 FFmpeg re-encode sites (normalise, inject_silence, single-clip render, multi-clip render, music mix, loudnorm), music volume slider (0–100 UI → 0.0–1.0 pipeline, fixed 0.3/0.4 default mismatch), delete project from Library (Rust command + confirmation dialog + optimistic list removal), stale job auto-cleanup (60-min SQL timeout inline in `list_projects_cmd`), 10-min client-side pipeline timeout on Output page with `useRef` guard and cleanup. E2E eval: 7/7 fast PASS; 5/7 editor (2 pre-existing spec bugs); 8/11 render (3 pre-existing spec bugs — render itself PASS, film confirmed 23s).

---

## Immediate Next Task

**Batch 12b — Music Mode Presets** (small patch): Replace the `music_volume` 0–100 slider with a 3-chip preset group (Subtle / Balanced / Prominent). Changes: TS `JobConfig` type, Rust `JobConfig` struct, SettingsPanel UI, `run.py` mode→float mapping. Expect Tauri recompile. Diagnose before fixing if IPC breaks.

After 12b: **Batch 13 — Motion Intelligence** (FFmpeg/librosa only — no Gemini). See PRD-DEV.md for full scope.

---

## Recently Completed

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

| Item                              | Status                           |
| --------------------------------- | -------------------------------- |
| Boring clip filter (motion score)     | Batch 13                         |
| Smart clip selection (>20 clips)      | Batch 13                         |
| Per-clip in/out handles + trim        | Batch 14 (Clip Editor)           |
| Per-clip transition picker            | Batch 14 (Clip Editor)           |
| Previewable transitions (proxy)       | Batch 14+ (proxy system needed)  |
| Clip reorder UI                       | Batch 14 (Clip Editor)           |
| AI Director screen                    | Batch 15                         |
| Proxy files for HEVC scrubbing        | Batch 14+ (interactive timeline) |
| Auth / project library                | Batch 16                         |
| 4K output                             | Batch 16                         |
| Stripe / paid tier                    | Batch 16                         |
| Cloud mode (Vercel + Lambda)          | Phase 3                          |

---

## Key Decisions Since Phase 1

- **DEC-018:** Phase 2 gate = founder's own successful 60+ clip session (not paying users)
- **DEC-019:** Competitor research = web-only (desktop apps have different capability/latency profile)
- **DEC-020:** Stripe deferred until AI layer exists — charging for clip stitching has no lock-in
- **DEC-021:** "In the middle" positioning confirmed — direction power, not full auto-AI, not manual timeline
- **DEC-022:** Full local build — upload bottleneck (84 min for 19 GB session at 30 Mbps) makes cloud-upload model unworkable for real sessions. Phase 2 runs entirely on-machine via WSL2.

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
