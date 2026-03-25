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

**Phase 2 — Batch 10 (Director Intelligence)**

Batch 9 complete: Full Tauri UX flow wired. Folder picker → scan_folder (scan.py) → editor (clip timeline + settings) → start_job (manifest-based pipeline) → output page (progress events + asset:// video player). App launches, `[wsl_check] ok`, all routes functional. Pipeline produces a dumb stitch (clips in folder order) — no AI selection yet.

---

## Immediate Next Task

**Batch 10b — Director Intelligence** (E2E gate passed — unblocked)

Add the AI layer that makes RushCut more than a clip stitcher:

1. **Gemini clip ordering** — score clips by visual interest, reorder before render
2. **Beat-sync cuts** — use librosa to align cut points to music beats
3. **Motion peak trimming** — per-clip best 5–10s using motion score rather than full duration

Pre-condition: user verification of `test-batch10-full.mp4` in Windows Media Player (scheduled tomorrow).

Gate: founder's own successful 60+ clip session (DEC-018).

---

## In Progress

**Batch 10 E2E — COMPLETE (2026-03-25)**

Pipeline is end-to-end verified on DJI_01–03 (1728×3072 portrait, 1–11s clips):
- Bare run (no features): ✅ 19.6s output, h264, 608×1080
- + intro/outro cards: ✅ 24.6s, 5-input xfade correct
- + cinematic music: ✅ 24.5s, loudnorm applied

Three bugs fixed this session:
1. `scan.py` SyntaxWarnings (`\c`, `\.` in docstrings) — escaped
2. `run.py` hardcoded `silence_removal: True` and `transition: "crossfade"` — now reads from manifest settings
3. `pipeline-progress` Rust event emitted `stage: "processing"` — clobbered stage labels; stripped from payload, Output.tsx handler no longer calls `setStage`

UI walk-through (Vite-only, Preview MCP):
- All 4 pages render correctly (/upload, /editor, /output, /library)
- All Tauri command + event names verified as correctly wired
- Render button correctly disabled when 0 clips; all settings interactive

**Observation (not a bug):** `DEFAULT_CONFIG` in Editor.tsx defaults `music_mood` to `"cinematic"`. Settings are not persisted per project — every open resets to defaults. Intentional for V1; revisit when project settings persistence is added.

---

## Blocked / Deferred

| Item | Blocked by | Status |
|---|---|---|
| Boring clip filter (motion score) | Local pipeline must exist first | Batch 8 sub-task |
| Smart clip selection (>20 clips) | Local pipeline must exist first | Batch 8 sub-task |
| Per-clip in/out handles | Local pipeline + folder scan first | Batch 8 sub-task |
| Auth / project library | Batch 10 | Batch 10 |
| Stripe / paid tier | AI layer (DEC-020) | Phase 3 |
| Cloud mode (Vercel + Lambda) | Phase 3 reintroduction | Phase 3 |

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
