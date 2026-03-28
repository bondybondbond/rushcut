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

**Phase 2 — Batch 12b (Music Mode Presets) COMPLETE**

Batch 12b delivered: `music_volume` type changed from `number` (0–100) to `"subtle" | "balanced" | "prominent"` union; 3-chip preset group in SettingsPanel replaces slider (conditional on `music_mood !== "none"`); `run.py` maps presets to floats `{subtle: 0.2, balanced: 0.4, prominent: 0.7}` with legacy numeric fallback; 5 pre-existing E2E spec bugs fixed (2× `expect(val,msg)` 2-arg, progress poll race, filename slug regex, `clip-item` testid missing from TimelineStrip). E2E eval: 7/7 fast PASS, 5/7 editor, 8/11 render — all failures pre-existing; none new.

---

## Immediate Next Task

**Batch 13 — Motion Intelligence** (FFmpeg/librosa only — no Gemini). See PRD-DEV.md for full scope. Goal: a 60+ clip DJI session produces a watchable 3–6 min film with no manual curation.

---

## Recently Completed

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
