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

**Phase 2 — Batch 11b (E2E Infrastructure + Eval Skill) COMPLETE**

Batch 11b delivered: WebdriverIO v9 + msedgedriver E2E scaffold with 3-layer BiDi fix (verified 3x consecutive green runs). Created `rushcut-eval` skill for human-like E2E testing via chrome-devtools MCP. Dry run passed 33/35 checks (2 permanent SKIPs due to native file dialog limitation).

---

## Immediate Next Task

**Batch 11c** — 9 UI items: mandatory project name prompt, scan spinner, home screen redesign, remove manual path input, transition picker, nav drawer position, download button, copy fixes, 4K notice on upload.

After 11c: **Director Intelligence** (Gemini clip ordering, beat-sync, motion peak trimming).

---

## Recently Completed

**Batch 11b — E2E Infrastructure + Eval Skill (2026-03-26)**

- WebdriverIO v9 + msedgedriver E2E scaffold (`wdio.conf.ts`, `e2e/fast.spec.ts`, `e2e/render.spec.ts`)
- 3-layer BiDi fix: `--disable-bidi` + `webSocketUrl: false` + route-aware readiness gate
- Verified 3x consecutive `pnpm test:e2e` green runs (7/7 each)
- Created `rushcut-eval` skill (`.claude/skills/rushcut-eval/SKILL.md`) for human-like E2E testing via chrome-devtools MCP
- Dry run: 33/35 PASS, 2 permanent SKIP (Upload page clip display — requires native file dialog)

---

## Deferred / Blocked

| Item | Status |
|---|---|
| Boring clip filter (motion score) | Batch 12+ |
| Smart clip selection (>20 clips) | Batch 12+ |
| Per-clip in/out handles | Batch 12+ |
| Proxy files for HEVC scrubbing | Batch 13+ (interactive timeline) |
| Auth / project library | Batch 12+ |
| Stripe / paid tier | Phase 3 |
| Cloud mode (Vercel + Lambda) | Phase 3 |

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
