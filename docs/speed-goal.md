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

**Open question:** `t_render_s` swings 317→486s (~50%) across renders of the *identical* clip set/settings. Likely system/GPU contention, not pipeline inefficiency — not yet investigated.

## Outstanding hypotheses / relevant open issues (ranked)

1. **#104** — Step 2 trim: partial-GOP re-encode instead of full libx264 re-encode. Real fix after #99's disappointing result. Targets the 15–25% `t_trim_s` slice.
2. **#100** — `t_normalise_s=25s` on a full proxy-skip render, expected 2–5s. Unexplained, logs-only investigation needed.
3. **#101** — proxy resolution trade-off (2160p vs tiered). Measure amortization before changing.
4. **#88** — isolate 4K bitrate cost from open/close post-pass; possible Fast/Best-Quality toggle.
5. **#85** — ideation: `hevc_amf` for final encode. Untested.
6. **Unexplained `t_render_s` variance** (317–486s on identical input) — not filed, worth a quick investigation before chasing anything else.

## Learning log (brief — tried, success/fail)

- **#65 (closed, SUCCESS)** — AMF quality preset raised + eliminated full-film double-encode for open/close (post-pass now only re-encodes the boundary segment, not the whole film). Real win.
- **#84 (closed, REJECTED)** — AMF `-quality "balanced"` tested as an A/B against `"quality"`. Zero speed gain at current 40M/50M bitrate, visible quality loss. Reverted. **Don't re-propose without a bitrate change too.**
- **#99 (closed, PARTIAL)** — Parallelised Step 2 trim. Only 1.1–1.3x, not the expected 3–4x — real ceiling is a ~7–8s fixed cost per FFmpeg invocation, not a parallelism problem. See #104 for the actual fix direction.
- **#96 (closed, MIXED)** — Fixed trim precision (keyframe-snap bug adding ~1s of wrong footage). Correctness win, but changed Step 2 from stream-copy to re-encode — added the cost #99/#104 are now dealing with.
- **#98 (closed, FIX)** — U1g tail-batch crash fix; was silently falling back to slow monolithic render on the last batch.
- **2026-07-11 diagnosis session — 5 proposed speed ideas, 4 rejected:**
  - Pre-bake xfade segments at proxy time — high complexity, mostly redundant with the V4.1 render cache, and repeats a pattern (pre-bake-and-cache) already tried and reverted for zoom (#67/#79).
  - Parallel U1g batch encoding — **reintroduces OOM.** U1g's `BATCH_SIZE=4` sequential design exists specifically because one 4K batch peaks at 6–9.7 GB against a 12 GB WSL budget; running batches in parallel would blow that budget. Also AMF hardware contention makes concurrent encodes *slower*, not faster (documented precedent in the proxy-batch concurrency guard).
  - Pre-compute/cache zoom VF strings — near-zero payoff (`t_zoom_s` is <1% of total); `build_zoom_vf` is a cheap string-builder, not a heavy computation.
  - Second-tier music/loudnorm cache — **already built** (V4.1 render cache excludes music fields from the signature and reapplies them as a cheap remux on every hit).
  - **Kept:** copy-stream normalise for already-compliant clips (no compliance check exists in `normalise.py` today) — real but narrow, since primary DJI HEVC footage is never "already compliant" H.264. Not yet filed as an issue.
