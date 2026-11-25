#!/usr/bin/env python3
"""#284 -- per-cut transition lengths and the segmented batch planner. Pure Python, no ffmpeg.

  python3 pipeline/_test_cuts.py

1. Every case in pipeline/fixtures/cut_cases.json (shared with the TypeScript self-test).
2. Random films: every element keeps min(1.5 s, half itself) un-faded (whole-frame tolerance).
3. Batch planner, 2,000 plans with short (down to 1 frame) elements on every batch-boundary
   position: 0 rejections (a rejection would send the render to the single-graph fallback).
Exit 0 = pass, 1 = fail.
"""
import json
import math
import random
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.transitions import (  # noqa: E402
    KEEP_OWN_S, XFADE_DUR, card_duration_s, plan_video_batches, resolve_cuts,
)

NTSC = 30000 / 1001
BATCH = 4
failures: "list[str]" = []


def fps_of(raw: str) -> float:
    a, _, b = raw.partition("/")
    return float(a) / float(b or 1)


def check(label: str, cond: bool, detail: str = "") -> None:
    if not cond:
        failures.append(f"{label} {detail}")
        print(f"FAIL: {label} {detail}")


# 1. shared fixtures
cases = json.loads((ROOT / "pipeline" / "fixtures" / "cut_cases.json").read_text())["cases"]
for c in cases:
    fps = fps_of(c["fps"])

    def secs(v, fps=fps):
        return XFADE_DUR if v == "full" else v / fps

    p = resolve_cuts(c["elements"], c["between"], c["open"], c["close"], fps)
    e = c["expect"]
    got = [p.open_s, *p.between_s, p.close_s]
    want = [secs(e["open"]), *[secs(v) for v in e["between"]], secs(e["close"])]
    check(c["name"], len(got) == len(want) and all(abs(g - w) < 1e-9 for g, w in zip(got, want)),
          f"got={[round(g, 4) for g in got]} want={[round(w, 4) for w in want]}")
print(f"fixtures: {len(cases)} cases")

# card length derives from its own two cuts
p = resolve_cuts([None, 2.302, 6, None], True, False, False, NTSC)
check("card before a short clip", abs(card_duration_s(p, 0, True) - (1.5 + 17 / NTSC)) < 1e-9)
check("card after a long clip", abs(card_duration_s(p, 3, True) - 3.0) < 1e-9)
check("no between transition: card is 3 s", card_duration_s(None, 0, False) == 3.0)


# 2 + 3. random films
def random_film(rng: random.Random):
    n = rng.randint(5, 24)
    d = [rng.randint(int(4 * NTSC), int(12 * NTSC)) / NTSC for _ in range(n)]
    boundaries = list(range(BATCH - 1, n, BATCH - 1))
    return n, d, boundaries


rng = random.Random(284)
rejected: "list[str]" = []
plans = 0
positions: "set[int]" = set()
min_margin = float("inf")
while plans < 2000:
    n, d, boundaries = random_film(rng)
    # one boundary position per plan in rotation, plus random extra short elements anywhere
    target = boundaries[plans % len(boundaries)]
    d[target] = rng.randint(1, int(4.5 * NTSC)) / NTSC
    for b in boundaries:
        if rng.random() < 0.3:
            d[b] = rng.randint(1, 12) / NTSC
    for _ in range(rng.randint(0, 3)):
        d[rng.randrange(n)] = rng.randint(1, int(4.5 * NTSC)) / NTSC
    open_on, close_on = rng.random() < 0.5, rng.random() < 0.5
    cp = resolve_cuts(d, True, open_on, close_on, NTSC)
    for i, length in enumerate(d):
        faded = (cp.open_s if i == 0 else cp.between_s[i - 1]) + (cp.close_s if i == n - 1 else cp.between_s[i])
        own = length - faded
        need = min(KEEP_OWN_S, length / 2)
        check("element keeps its own time", own >= need - 1 / NTSC - 1e-9,
              f"len={length:.3f} own={own:.3f} need={need:.3f}")
        if length >= 4.5:
            sides = [cp.open_s if i == 0 else cp.between_s[i - 1], cp.close_s if i == n - 1 else cp.between_s[i]]
            for j, other in ((0, i - 1), (1, i + 1)):
                if 0 <= other < n and d[other] >= 4.5:
                    check("cut between two long elements is 1.5 s", sides[j] == XFADE_DUR)
    plans += 1
    positions.add(target)
    try:
        batches, total = plan_video_batches(d, cp.between_s, batch_size=BATCH)
    except ValueError as exc:
        rejected.append(f"n={n} target={target} len={d[target]:.3f} {exc}")
        continue
    frames = [round((total if b["seg_end_local"] is None else b["seg_end_global"]) * NTSC)
              - round(b["seg_start_global"] * NTSC) for b in batches]
    check("every segment has frames", all(f > 0 for f in frames), str(frames))
    check("segments telescope to the film", sum(frames) == round(total * NTSC))
    for b in batches[1:]:
        k = b["clip_indices"][0]
        start_k = sum(d[:k]) - sum(cp.between_s[:k])
        solo = d[k] - cp.between_s[k - 1] - (cp.between_s[k] if k < n - 1 else 0.0)
        min_margin = min(min_margin, solo)
        check("batch cut is inside the shared element's own time",
              start_k + cp.between_s[k - 1] < b["seg_start_global"] < start_k + cp.between_s[k - 1] + solo)

print(f"planner: {plans} plans, boundary positions covered {sorted(positions)}, rejected {len(rejected)}, "
      f"smallest own time at a batch cut {min_margin * NTSC:.1f} frame(s)")
for r in rejected[:10]:
    print("  REJECTED", r)
check("0 planner rejections", not rejected, str(len(rejected)))
print("PASS" if not failures else f"FAIL ({len(failures)})")
sys.exit(0 if not failures else 1)
