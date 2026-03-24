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

**Phase 2 — Batch 9 (Tauri UX flow)**

Batch 8 complete: Tauri 2.x scaffold, Rust backend with SQLite schema, WSL2 check on startup, Python pipeline CLI wired. App launches with `pnpm dev` and shows `[wsl_check] ok`.

---

## Immediate Next Task

**Batch 9 — UX flow: Folder picker → Editor → Output**

Build the three Tauri/React pages using the existing UX flow:

1. **`/upload`** — folder picker (Tauri dialog API), scan MP4/MOV/MKV, insert project + clips to SQLite via Tauri command
2. **`/editor/:projectId`** — clip timeline, settings panel (music mood, card text, zoom toggle)
3. **`/output/:jobId`** — progress bar (listen to Tauri events), video player (asset:// protocol)

All state persists to SQLite (`%APPDATA%\rushcut\rushcut.db`). No Supabase. No R2.

---

## In Progress

Nothing in progress. Batch 9 not started.

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
- **Local FFmpeg:** WSL2 Ubuntu-24.04, `/usr/bin/ffmpeg` (v7.x)
- **SQLite:** `%APPDATA%\rushcut\rushcut.db` — created on first `pnpm dev`
