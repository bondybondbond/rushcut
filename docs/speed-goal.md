# Speed Goal

Transparency doc — not a strategy doc. Tracks progress toward the render-speed north star so we don't re-propose rejected ideas or lose sight of the real bottleneck.

## North star

- **Cold render: 5 min max** (any project size, any resolution)
- **Proxy gen: as little as possible, ~5–10 min ceiling** for a full project's background proxy batch
- Existential goal: close the gap to DaVinci Resolve's render speed — see [[feedback_no_recalibrate_render_time_target]]. Do not soften this target.

## Current speed logs (real numbers, from `%TEMP%\rushcut\render-timing-log.jsonl`)

**Big case — 19 clips, 4K, crossfade, AMF (Stagecoach test project):**
| stage | range | % of total |
|---|---|---|
| `t_total_s` | 500–705s (8.3–11.75 min) | 100% |
| `t_render_s` | 317–486s | 63–69% |
| `t_trim_s` | 94–139s | 15–25% |
| `t_normalise_s` | 22–25s | ~4% |
| `t_music_s` | 19–21s | ~3% |
| `t_zoom_s` | 3–4s | <1% |

**Smaller case — 8 clips, 4K, no transition/zoom, proxies warm:** `t_total_s` 173–215s, `t_render_s` 123–157s, `t_trim_s` 25–32s.

**Gap to north star:** big-case cold total is 1.7–2.35x over the 5-min target. `t_render_s` + `t_trim_s` = 85%+ of the gap. Everything else is noise — don't optimise it first.

**Variance diagnosed (2026-07-11):** `t_render_s` swings 317→486s (~50%) across renders of the *identical* clip set/settings. Checked against proxy contention (never fired) and WSL memory (flat 11340–11354MB across all 4 renders, no correlation with render time) — both ruled out. Diagnosis: Windows/WSL scheduler noise from other load during a back-to-back A/B testing session, not a pipeline inefficiency — unfalsifiable from pipeline logs alone. **317s is the clean-machine floor for this baseline going forward, not 486s.** `mem_avail_mb` is now logged at U1g batch start (not just completion) so a future variance event has richer data if worth revisiting.

## Outstanding hypotheses / relevant open issues (ranked)

1. **#104 (GO, measured 2026-07-11)** — Step 2 trim: partial-GOP re-encode. Scoping-pass measurement done (see issue comment): the ~7–8s floor is libx264-encode-specific, not per-FFmpeg-invocation — reproduced #99's exact 7.88–7.90s/job under 4-way contention, while `-c copy` under the same contention stayed at 0.28–0.29s/job. Real periodic GOP (~8.34s keyint) confirmed in a real normalised clip, with ~55% of a realistic 12s trim window sitting after an internal keyframe. Not yet implemented — **now the top candidate** since #107 (batching) closed NO-GO.
2. **#101** — proxy resolution trade-off (2160p vs tiered). Measure amortization before changing.
3. **#88** — isolate 4K bitrate cost from open/close post-pass; possible Fast/Best-Quality toggle.
4. **#85** — ideation: `hevc_amf` for final encode. Untested.
5. **#106 (P3-Low)** — copy-stream normalise for already-compliant clips. Narrow: never fires on the primary DJI HEVC workload.

## Learning log (brief — tried, success/fail)

- **#65 (closed, SUCCESS)** — AMF quality preset raised + eliminated full-film double-encode for open/close (post-pass now only re-encodes the boundary segment, not the whole film). Real win.
- **#84 (closed, REJECTED)** — AMF `-quality "balanced"` tested as an A/B against `"quality"`. Zero speed gain at current 40M/50M bitrate, visible quality loss. Reverted. **Don't re-propose without a bitrate change too.**
- **#99 (closed, PARTIAL)** — Parallelised Step 2 trim. Only 1.1–1.3x, not the expected 3–4x — real ceiling is a ~7–8s fixed cost per FFmpeg invocation, not a parallelism problem. See #104 for the actual fix direction.
- **#96 (closed, MIXED)** — Fixed trim precision (keyframe-snap bug adding ~1s of wrong footage). Correctness win, but changed Step 2 from stream-copy to re-encode — added the cost #99/#104 are now dealing with.
- **#98 (closed, FIX)** — U1g tail-batch crash fix; was silently falling back to slow monolithic render on the last batch.
- **#100 (closed, DIAGNOSIS)** — `t_normalise_s=25s` on a full proxy-skip render confirmed to be B-0 pre-trim time bucketed under the "normalise" timer label, not a regression. Logs-only, no code change. Floor magnitude (does B-0's stream-copy hit a fixed per-invocation floor like #104's re-encode?) is still open, cross-referenced on #104.
- **2026-07-11 diagnosis session — 5 proposed speed ideas, 4 rejected:**
  - Pre-bake xfade segments at proxy time — high complexity, mostly redundant with the V4.1 render cache, and repeats a pattern (pre-bake-and-cache) already tried and reverted for zoom (#67/#79).
  - Parallel U1g batch encoding — **reintroduces OOM.** U1g's `BATCH_SIZE=4` sequential design exists specifically because one 4K batch peaks at 6–9.7 GB against a 12 GB WSL budget; running batches in parallel would blow that budget. Also AMF hardware contention makes concurrent encodes *slower*, not faster (documented precedent in the proxy-batch concurrency guard).
  - Pre-compute/cache zoom VF strings — near-zero payoff (`t_zoom_s` is <1% of total); `build_zoom_vf` is a cheap string-builder, not a heavy computation.
  - Second-tier music/loudnorm cache — **already built** (V4.1 render cache excludes music fields from the signature and reapplies them as a cheap remux on every hit).
  - **Kept:** copy-stream normalise for already-compliant clips (no compliance check exists in `normalise.py` today) — real but narrow, since primary DJI HEVC footage is never "already compliant" H.264. Filed as **#106** (P3-Low).
- **2026-07-11 variance diagnostic pass — DIAGNOSED, not a pipeline problem.** Correlated the 317–486s `t_render_s` spread against proxy-contention logs and `mem_avail_mb` (added per-batch logging as part of this pass) across the 4 matching job logs (matched by timestamp proximity — `render-timing-log.jsonl` has no `job_id` field, see LEARNINGS.md). Contention warning never fired; memory was flat (11340–11354MB) regardless of render speed. Conclusion: external machine load during A/B testing, not pipeline inefficiency. **317s recorded as the clean-machine floor.**
- **#104 (scoping measurement, 2026-07-11) — GO, floor is encode-specific.** Measured whether a pure `-c copy` invocation pays #99's ~7-8s floor. Serial test: reencode 2.63s avg vs. copy 0.26s avg (10x). Reproduced #99's exact production conditions (4-way `ThreadPoolExecutor`, 4 threads/worker): parallel reencode 7.88-7.90s/job (matches #99 exactly), parallel copy 0.28-0.29s/job (no floor at all). Conclusion: the floor is libx264 encode work under thread-capped contention, not generic FFmpeg process-spawn overhead — partial-GOP trim's extra invocations would be cheap if they're copy/concat, not re-encode. Also found (after fixing a CSV-column-order bug in the probe script) a real periodic ~8.34s GOP in a real normalised DJI clip (no scene cuts, so x264 falls back to default max keyint=250) — a realistic 12s trim window has ~55% sitting after an internal keyframe, i.e. real copyable middle, not a hypothetical one. Full data: issue #104 comment. No code shipped — batching should be evaluated first (same win, lower risk).
- **#107 (scoping measurement, 2026-07-11) — NO-GO, closed.** Measured whether batching all of a job's Step 2 trims into ONE ffmpeg process (N inputs, N independent filter chains, N output files — not a literal concat, which would have broken zoom/volume/transitions' per-clip file contract) amortizes the ~7-8s/job encode floor. Result: the opposite — batched avg 11.82s (default `rc-lookahead`) / 10.90s (`rc-lookahead=0`) vs. current per-clip avg 8.83s, on 6 real DJI clips under the same `MAX_PARALLEL_TRIM=4` contention shape. Batching is ~25-35% **slower**, not faster. Memory: batching roughly doubled peak WSL memory vs. current (~2.75GB vs ~1.4GB above baseline for N=6, no throttle analogous to `MAX_PARALLEL_TRIM` in the one-process design) — projects to ~8-9GB for a 19-clip project, real OOM risk. `rc-lookahead` turned out not to be the dominant memory driver at this scale (estimated ~712MB contribution from lookahead buffers; measured difference was ~0MB) — don't re-propose that specific lever without new evidence. Full data + GO/NO-GO writeup: issue #107 comment. **#104 (partial-GOP trim) is now the top remaining speed candidate** — it doesn't share #107's contention/memory failure mode since it reduces re-encode work per clip instead of trying to batch/parallelize differently.
