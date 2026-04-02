# RushCut — Phase 2 Build Plan

> **Phase goal:** The founder can upload a full 60+ clip DJI session, have RushCut intelligently filter and compile it into a 3–6 min film with music, card text, zoom, and smart moment selection — a film they're proud enough to publish.
> 
> **Phase 2 exit gate:** "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish." Not: paying users. Not: user testing scores. (See DEC-018, DEC-020.)

---

> **What belongs in this file:**
> 
> - Phase goal and exit gate
> - Specs for batches not yet started or actively in progress
> - Backlog items with enough detail to act on when prioritised
> - Phase 3 preview (high-level only)
> - Compact changelog table
> 
> **What does NOT belong here:**
> 
> - Specs for delivered batches — once a batch ships, trim to a one-line "done" note in the changelog and delete the detail
> - Lambda / Next.js / Supabase / R2 references — that infrastructure is gone
> - "Superseded" or "deferred" batch specs — move to `docs/archive/` or delete
> - Research notes, user testing plans — those go in `docs/COMPETITORS.md` or a dedicated notes file
> - Implementation details already captured in `LEARNINGS.md` or `.claude/rules/`

---

## Batch 14 — Clip Review

> **Scope:** Guided clip-review editor — user decides, pipeline executes.
> **Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."
> **Status:** 14a, 14b, 14c complete. Next: 14d (tabbed settings).

### 14a — Sequential clip review screen (**DONE 2026-04-02**)

`/review/:projectId` route, Quick + Precise modes, keyboard shortcuts, focal point picker, IN/OUT trim sliders, zoom chips, sessionStorage resume, Skip Review escape hatch. Full detail in CONTEXT.md.

### 14b — Proxy generation (**DONE 2026-04-02**)

H.264 720p proxies generated post-render via `proxy.py` + `generate_proxies_cmd`. Full detail in CONTEXT.md.

### 14c — Per-clip data model (**DONE 2026-04-01**)

7 columns added to `clips` table. Full detail in CONTEXT.md.

### 14d — Tabbed settings UI

Reorganise SettingsPanel into tabs: **Music/Sound · Effects · Text** (intro/outro cards).

### Gate

- [x] Quick mode is default; Include/Skip keyboard-accessible; Precise expands per clip (14a)
- [x] Proxy generation runs after render completes; proxies used in review screen scrubbing (14b)
- [x] Per-clip in_ms, out_ms, focal_x/y, zoom_mode passed through manifest to pipeline (14c)
- [x] Pipeline applies user IN/OUT over silence trim when set (14c)
- [x] Skipped clips excluded from render (14c)
- [ ] Post-review Editor contains only the 5 items listed — nothing more
- [ ] Tabbed settings visible in Editor

---

## Batch 14f — Benchmarking + Project Cleanup

> **Scope:** Pipeline telemetry surfaced in UI + proper resource cleanup on project delete.

1. `delete_project_cmd` (Rust) — delete `%APPDATA%\rushcut\proxies\<clip_id>.mp4` for each clip before removing DB rows
2. `src/pages/Library.tsx` — surface `analysis_summary` per project card (render time, clip count, resolution badge)

### Gate

- [ ] Deleting a project removes its proxy files from disk
- [ ] Library card shows: clips used, total duration, max resolution, render time (from `analysis_summary`)

---

## Backlog — Music Loop: Waveform-Matching Loop Point

> **Deprioritised — Batch 15+ or dedicated audio polish batch.**

**Problem:** Pairwise `acrossfade` crossfades wherever the track boundary falls. If the track has a fade-out at the tail and a fade-in at the head, both sides of the crossfade are near-silent — the gap persists.

**Shipped fix (Batch 14-P):** Strip intro/outro silence before tiling (`silencedetect` → `atrim` to active region). Reduces but doesn't eliminate the gap.

**Better fix (this item):** Find a waveform-match loop point — two beat-aligned moments where harmonic/spectral content is nearly identical, crossfade between them. Options: librosa `beat_track` + `chroma_features` similarity; `essentia`; or a purpose-built AI audio model.

Qualifies under AI policy (user-visible, demonstrable) if AI is used. Prioritise only after real-footage testing confirms the gap is still audible post silence-trim fix.

---

## Batch 15 — AI Director Screen (deprioritised)

> **Goal:** Surface the AI's edit proposal explicitly, between Upload and Clip Editor.
> **Prerequisite:** Batch 14 (Clip Review) complete.
> **Estimate:** 2–3 days.

New route: `/director/:projectId` — inserted into flow after scan, before `/editor/:projectId`.

**Left:** AI Proposal summary — style tags, "N of M clips used · X excluded", actions: **Accept & Edit** / **Regenerate** / **Skip → Manual**

**Right:** Proposed clip order list — filename, trim duration, transition label per cut. Excluded clips shown dimmed with reason. Tap excluded clip → option to add back.

### Gate

- [ ] Director screen appears after scan for new projects
- [ ] Accept loads Editor with AI-proposed order pre-populated
- [ ] Regenerate re-runs analysis and refreshes proposal
- [ ] Skip loads Editor with original scan order
- [ ] Excluded clips shown with reason; can be added back

---

## Batch 16 — Auth + 4K + Tier

> **Goal:** Product is shareable with paying users. Pro tier enforced.
> **Estimate:** 3–5 days.
> **Prerequisite:** DEC-020 conditions met (AI layer shipped = Batch 15).

- Supabase Auth (email + Google OAuth)
- 4K pipeline path (`-vf scale=-2:2160`, libx264, profile high)
- Pro tier gating: AI Director screen, 4K output, advanced transitions, timeline volume slider
- Upgrade chips + locked overlays for free-tier users
- Stripe (£4.99/mo Creator)
- Library: resolution badge (1080p / 4K) per project

---

## Phase 3 Preview (not in scope now)

- Google Video Intelligence frame-level scoring — replaces FFmpeg motion heuristic
- Face/subject-aware zoom — GVI + Vision API
- Stabilisation via ffmpeg-vidstab
- 50 clips / 20GB cap for Creator
- Licensed music library (Loudly or Soundraw API)

---

## Changelog

| Version | Date       | Changes                                                                                                                                                                                                                                                                             |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2     | 2026-04-02 | Batch 14a — Review Screen UI: `/review/:projectId`, Quick + Precise modes, keyboard shortcuts, focal point overlay, IN/OUT sliders, zoom chips, sessionStorage resume, Skip Review escape hatch, `REVIEW_THRESHOLD` constant, asset scope expanded for source clips. E2E: 25/25. |
| 1.1     | 2026-04-02 | Batch 14b — proxy generation: `proxy.py`, `generate_proxies_cmd`, post-render firing (avoids FFmpeg contention), `-c:a copy`, `include`-filter. Hygiene: `/tmp/<job_id>` cleanup in `run.py`, rich `ANALYSIS:` line in `render.py`, wrapup temp cleanup. Next: 14a (Review screen). |
| 1.0     | 2026-04-01 | Batch 14c — per-clip data model: 7 DB columns, Rust/TS types, `update_clip_review` cmd, manifest filtering, `out_ms` clamp, pipeline trim override, focal-aware `zoom.py`. Next: 14b (proxies).                                                                                     |
| 0.9     | 2026-03-31 | Batch 13d deferred (all changes reverted). `aresample=async` worsened DJI sync; `ProcessPoolExecutor` slower (I/O bound); `volumedetect` overcorrects on wind noise. Lessons in LEARNINGS.md.                                                                                       |
| 0.8     | 2026-03-30 | Batch 14-P — A/V sync fixed (pairwise acrossfade + apad); music loop improved (N-copy acrossfade + silencedetect silence-trim); per-clip normalise progress; library routing; persistent pipeline log.                                                                              |
| 0.7     | 2026-03-30 | Batch 13c — music looping (`-stream_loop -1` + `asetpts` ordering), `[sync-check]` logging, hwaccel probed (non-viable).                                                                                                                                                            |
| 0.6     | 2026-03-29 | Batch 13b — motion scoring removed, toggle bug fixed, filename versioning (`slug-01.mp4`), volume chip `#99B3FF`, timing logs. Post-batch hotfixes: fixed-canvas pre-scale (portrait+landscape crash), normalise ultrafast, Output rolling timeout. E2E 25/25.                      |
| 0.5     | 2026-03-29 | Batch 13 — motion.py, beats.py, render.py rewrite, analysis_summary DB column. Subsequently pivoted: motion scoring too slow (>10 min). See `docs/archive/PRD-DEV-batches-11-13.md`.                                                                                                |
| 0.4     | 2026-03-28 | Batch 12b — `music_volume` → `"subtle"\|"balanced"\|"prominent"` union; 3-chip UI; `run.py` float map.                                                                                                                                                                              |
| 0.3     | 2026-03-27 | Batch 12 — `-ar 48000` at all 6 re-encode sites, music volume slider, delete project, stale job cleanup, Output timeout.                                                                                                                                                            |
| 0.2     | 2026-03-26 | Batches 11–11c — UI polish (19 items), E2E infrastructure (WebdriverIO + BiDi fix + rushcut-eval skill), home redesign, transition picker, AppShell, elapsed timer. See `docs/archive/PRD-DEV-batches-11-13.md`.                                                                    |
| 0.1     | 2026-03-22 | Phase 2 build plan created. Batches 8–9 (Tauri scaffold + full UX flow) delivered.                                                                                                                                                                                                  |
