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

1. **#104** — Step 2 trim: partial-GOP re-encode instead of full libx264 re-encode. Real fix after #99's disappointing result. Targets the 15–25% `t_trim_s` slice.
2. ~~**#100**~~ — RESOLVED (closed 2026-07-11): `t_normalise_s` brackets B-0 pre-trim, not just `normalise()` — the 25s is B-0 wall time, not an anomaly. See LEARNINGS.md entry.
3. **#101** — proxy resolution trade-off (2160p vs tiered). Measure amortization before changing.
4. **#88** — isolate 4K bitrate cost from open/close post-pass; possible Fast/Best-Quality toggle.
5. **#85** — ideation: `hevc_amf` for final encode. Untested.
6. **#106 (P3-Low)** — copy-stream normalise for already-compliant clips. Narrow: never fires on the primary DJI HEVC workload.

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
