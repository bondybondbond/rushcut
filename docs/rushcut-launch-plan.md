# RushCut: Open Source Launch Plan

A prioritised action plan for cleaning up, quality-boosting, and publishing RushCut as an open source project. Based on current codebase state and measured performance data.

---

## Why Publish Now

RushCut solves a real, underserved problem: DaVinci Resolve and Premiere Pro are overwhelming for recreational filmmakers who just want to trim, transition, zoom, and export. RushCut does all of that with simple button presses. The rendering speed (10 min cold, 3-5 min for typical 6-9 clip projects) is acceptable for a leave-and-come-back workflow. The quality gap vs DaVinci is closable with encoder changes that take minutes to implement. The project is technically solid enough to publish — it just needs a cleanup pass first.

Publishing as open source is the right move because:
- Community contributors on Nvidia hardware can solve the B-frame/codec quality ceiling you can't fix on AMD alone
- The GPU decode bottleneck (decode + filter_complex compositing = 63-69% of render time) is a hard FFmpeg/WSL problem that benefits from more eyes
- It validates the product positioning with zero marketing effort

---

## Phase 1: Quality Boost (Do First — 1-2 hours)

These are code changes that improve output quality at zero render time cost. The encoder is a small fraction of total render time; changing encoder mode does not meaningfully affect the 10-min cold render.

### 1.1 Switch 4K Final Encode to CQP

In `pipeline/encoder.py`, replace the VBR `vbr_peak` mode for the 4K AMF final encode with CQP:

```python
# Replace this:
"-rc", "vbr_peak", "-b:v", "40M", "-maxrate", "50M"

# With this:
"-rc", "cqp", "-qp_i", "18", "-qp_p", "20"
```

**Why:** VBR averages bits across the film, starving complex pan shots of the bits they need. CQP gives every frame what it needs regardless of complexity. QP 18-20 is near-lossless for H.264 AMF. Pan-heavy footage (the primary DJI use case) will be visibly sharper. Start with QP 20 and TV-check a pan-heavy 30s section vs source; drop to QP 18 if you want more headroom. File sizes will increase (~60-80 MB for a 2-3 min clip) but that is the correct trade for a master export tool.

### 1.2 Add VBAQ and High-Motion Boost to 1080p AMF

`encoder.py` already applies `-vbaq true -high_motion_quality_boost_enable true` for 4K AMF renders. These flags should also apply when the 1080p AMF opt-in (`RUSHCUT_USE_AMF`) is active — currently they are 4K-only. This is a one-line change and is zero render-time cost (hardware-side perceptual bit redistribution).

### 1.3 Do a TV-Check Comparison

After making the above changes, render a 30s pan-heavy clip and compare frame-by-frame vs source and vs a DaVinci export at default settings. Document the result in `docs/speed-goal.md` as a quality baseline. This becomes the benchmark for future community contributors.

---

## Phase 2: Dead Code & Bug Cleanup (Before Publishing — 2-3 hours)

Do not let new contributors open the repo and find dead code as the first thing they see.

### 2.1 Delete Dead Code

| Item | Action |
|------|--------|
| `Review.tsx` (#94 — built but unreachable) | **Product decision, not cleanup.** It's referenced in `Upload.tsx`, `Arrange.tsx`, and `App.tsx` — not dead code. Consciously decide: wire up navigation, or deliberately remove. Do not blind-delete. |
| Unused `trim_smart()` in `pipeline/trim.py` / imported in `render.py` | Confirmed genuinely unwired (`render.py:59` comment: "built but NOT wired in"). Safe to delete or clearly comment as archived experiment. |
| Any commented-out prototype code from speed experiments (#99, #104, #107) | Delete |

### 2.2 Fix Open Correctness Issues

| Issue | Priority | What to do |
|-------|----------|------------|
| #115 — boundary re-encode opt-out toggle | Low | Leave open, not blocking |
| #113 — d3d11va GPU decode spike | Low | Leave open, community pick-up |
| #112 — TOCTOU filename race | Very low | Leave open with comment |

None of these are blocking for publishing. The only one worth fixing before launch is if any issue causes a silent wrong-result for a new user on a fresh project — review open issues with that lens specifically.

### 2.3 Deduplicate LEARNINGS.md (#108)

LEARNINGS.md has grown large and has duplicate entries from iterative investigation sessions. Before publishing: consolidate to one entry per experiment, delete superseded hypotheses, and ensure every NO-GO entry has a clear one-line reason at the top so contributors don't re-propose rejected ideas. This is the single most valuable onboarding document for a new contributor.

---

## Phase 3: Open Source Publishing (2-3 hours)

### 3.1 Rewrite README.md (full rewrite, not an edit pass)

The current README describes a **retired architecture** — "Web-first," Next.js, Lambda pipeline, "Phase: Pre-build — not yet in code." None of this is true anymore (Tauri desktop app, WSL2 Python pipeline, fully built and in daily use). This is actively misleading to a new reader, not just stale. Budget this as a from-scratch rewrite, not a touch-up.

The README is the product pitch. It must nail the positioning immediately.

**Required sections:**
- **What it is** — one paragraph, specific. "RushCut is a Windows desktop app for recreational filmmakers who find DaVinci Resolve too complex. Trim, add transitions, apply Ken Burns zoom, and export — all with button presses, no timeline scrubbing."
- **What it is not** — be honest. Not a professional editor. Not real-time preview. Render times are 3-10 min depending on project size.
- **Requirements** — Windows 11, WSL2, AMD GPU (for AMF acceleration), FFmpeg on both WSL and Windows-native paths
- **Quick start** — numbered steps from clone to first render
- **Known limitations** — render speed, B-frame gap vs Nvidia, HEVC playback extension dependency
- **Contributing** — link to open issues; call out #113 (GPU decode spike) and #115 (boundary re-encode opt-out) as good first community picks

### 3.2 Write CONTRIBUTING.md

Short file, three sections:
- How to run the project locally (Tauri dev setup, WSL Python path, Windows ffmpeg.exe path)
- Conventions: logs-first before fixes, real measured data in issues, no re-proposing NO-GO ideas without new evidence
- Open issues labelled `good-first-issue` — tag a handful of low-risk, well-scoped issues for this

### 3.3a Issue Triage Pass (~30 min)

~40 open issues with zero `good-first-issue` tags reads as an unmaintained backlog to a new contributor, not an inviting one. One pass, once: close stale/out-of-scope issues, and tag 3-5 genuinely low-risk, well-scoped issues as `good-first-issue` (candidates: #113 GPU decode spike, #115 boundary re-encode toggle).

### 3.3 Purge Sensitive / Personal Data

**CRITICAL — leaked GitHub PAT in git history.** `.claude/settings.local.json` (tracked in git since near the initial commit) contains a live personal access token (`ghp_...`) in a stale `GIT_ASKPASS` push command, superseded 2026-06-16 by Windows Credential Manager (see CLAUDE.md `git push` rule). Repo is currently private so it isn't publicly exposed yet, but:
1. Revoke the token at github.com/settings/tokens immediately, regardless of publish timing — it's dead weight sitting in history either way.
2. Before making the repo public, scrub it from git history (`git filter-repo` or BFG) — removing it from HEAD alone is not enough, it's present across ~10+ historical commits. This is a destructive, force-push-requiring operation; do it deliberately, not as a drive-by step.

**Username scan is whole-repo, not docs-only.** `Manasak` (personal Windows username) appears in 12+ tracked files, not just docs — including `pipeline/run.py`, `pipeline/utils.py`, `wdio.conf.ts`, `src/pages/Arrange.tsx`, `scripts/compare_renders.py`, and `docs/LEARNINGS.md` (path examples). Grep the whole repo (`git grep -n Manasak`), not just `docs/`.

Before making the repo public:
- Whole-repo username/path scan (see above), not just `docs/`
- Check `render-timing-log.jsonl` examples in docs — strip or anonymise any personal project names
- Ensure `.gitignore` covers `%TEMP%\rushcut\*` logs and any local config files with personal paths

### 3.4 Remove `.claude/` from the public repo

`.claude/` (agents, hooks, rules, skills, notes, `settings.local.json`) is dev tooling for working *on* RushCut with Claude Code — not part of the product, and not useful noise for a contributor browsing the repo. `settings.local.json` in particular must never be public (it's also the file holding the leaked PAT above).

**Decision: gitignore `.claude/` entirely before going public.**
- `git rm -r --cached .claude` to untrack existing files (keeps them on disk locally)
- Add `.claude/` to `.gitignore` (supersedes the now-redundant `.claude/worktrees/` line)
- Commit the untracking
- This does **not** remove `.claude/settings.local.json`'s leaked PAT from history — that still needs the history-scrub in 3.3

### 3.5 Add a License

MIT License is the right choice for a project inviting community contributions. Add `LICENSE` file to repo root.

---

## What to Leave for the Community

These are real problems worth solving but require capabilities or time you don't have alone:

| Problem | Why it's a community problem |
|---------|------------------------------|
| GPU decode (#113) — D3D11VA on Windows ffmpeg inputs | Needs empirical probe; low risk to test, potentially 20-30% render gain |
| Nvidia path — B-frames, NVENC quality | You're on AMD; someone else needs to own this |
| HEVC playback gate (#110) — detect MS HEVC extension on target machine | UX/detection problem, not a pipeline problem |
| 1080p quality parity with 4K | Needs a user with 1080p source footage to TV-check |

---

## What Not to Do

- **Do not rewrite the render pipeline before publishing.** The segmented U1g batching, render cache, and AMF fallback logic are battle-tested and well-documented. Publish what works.
- **Do not add features before publishing.** The backlog (#76 playable card previews, #97 proxy toast) can be post-launch issues — they make great community contributions.
- **Do not optimise render speed further before publishing.** The learning log in `docs/speed-goal.md` already documents five dead ends from a single session. The bottleneck (decode + compositing) has no known FFmpeg solution within the current WSL/Windows architecture. Ship what you have.

---

## Summary Checklist

- [ ] Revoke leaked GitHub PAT (`.claude/settings.local.json`)
- [ ] CQP encode change + TV-check comparison
- [ ] Resolve #94 — wire up `Review.tsx` or deliberately remove it (product decision)
- [ ] Delete confirmed-dead `trim_smart()` code
- [ ] Consolidate `LEARNINGS.md`
- [ ] gitignore `.claude/`, untrack existing files, commit
- [ ] Issue triage pass — tag `good-first-issue`, close stale
- [ ] Full rewrite of `README.md` (current one describes retired Next.js/Lambda architecture)
- [ ] Write `CONTRIBUTING.md`
- [ ] Whole-repo personal-path scan (not just docs)
- [ ] Scrub leaked PAT from git history before making repo public (destructive — confirm before running)
- [ ] Add `LICENSE` (MIT)
- [ ] Make repo public
