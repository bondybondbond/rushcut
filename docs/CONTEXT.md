# RushCut — Sprint Context

> This file tracks current focus, in-progress work, and immediate next steps.
> Updated at the end of every session by the wrapup skill.

---

## Current Phase

**Phase 2 — Batch 7 (P1 carry-overs + quick wins)**

Phase 1 is complete and archived. Phase 2 plan is live in `docs/PRD-DEV.md`.

---

## Immediate Next Task

**Batch 7a — cards.py text overlay via Pillow**

This is the first task of Phase 2. It's a self-contained Lambda change:
- Add Pillow to `lambda/requirements.txt`
- Rewrite card generation in `lambda/pipeline/cards.py` to use PIL instead of drawtext
- Bundle a font in `lambda/fonts/`
- Rebuild + deploy Lambda image
- Test: rendered film shows intro + outro card text

Then continue with 7b (music MP3s), 7c (2GB file limit), 7d (enable zoom) before wrapping Batch 7.

---

## In Progress

Nothing in progress. Batch 7 not started.

---

## Blocked / Deferred

| Item | Blocked by | Status |
|---|---|---|
| Music picker (NEXT_PUBLIC_MUSIC_ENABLED=true) | MP3 files not yet in Lambda | Unblocked when 7b done |
| Lazy upload (DEC-017) | Per-clip in/out handles (Batch 8d) | Batch 8 |
| Auth / project library | Phase 1 foundation complete, building in Batch 10 | Batch 10 |
| Stripe / paid tier | AI intelligence layer not yet built (DEC-020) | Phase 3 |
| Competitor audit (RT-1) | No blocker — 2h research task | Anytime |
| User testing (RT-2) | Wait until Batches 7+8+10 done | After Batch 10 |

---

## Key Decisions Since Phase 1

- **DEC-018:** Phase 2 gate = founder's own successful 60+ clip session (not paying users)
- **DEC-019:** Competitor research = web-only (desktop apps have different capability/latency profile)
- **DEC-020:** Stripe deferred until AI layer exists — charging for clip stitching has no lock-in
- **DEC-021:** "In the middle" positioning confirmed — direction power, not full auto-AI, not manual timeline

Full decision log: `docs/DECISIONS.md`

---

## Live Infra State

- **Vercel:** Deployed, production URL in `reference_vercel_url.md`
- **Lambda:** `rushcut-lambda` ARM64 3008MB, image `sha256:9c99eafb...`
- **Supabase:** `clips` table has `thumbnail_data TEXT NULL` (added Batch 6)
- **R2:** `rushcut-uploads` bucket, CORS configured for localhost + Vercel
