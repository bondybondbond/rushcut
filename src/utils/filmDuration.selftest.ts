/**
 * Standalone self-test for the surviving `filmDuration.ts` helpers. No unit-test
 * runner exists in this project (E2E-only, see package.json) -- run this directly:
 *
 *   pnpm exec tsx src/utils/filmDuration.selftest.ts
 *
 * Exit 0 = all invariants hold, exit 1 = a failure (prints which).
 *
 * #174 (Phase D): `filmPlayheadAtClip` was deleted -- the film-mode needle is now
 * a projection of the authoritative sequence clock, and its card-seam monotonicity
 * is covered by `sequenceClock.selftest.ts` (AC3). What remains here is the
 * `filmTimeAtClipStart` / `cardRegionMs` contract still consumed by Trimmer's
 * `seekFilmTo`/`gotoFilmClip` and Arrange's static playhead.
 */
import type { Clip } from "@/types/project";
import { cardRegionMs, filmTimeAtClipStart, CARD_DUR_MS, XFADE_DUR_MS } from "./filmDuration";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL- ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function clip(id: string, inMs: number, outMs: number): Clip {
  return { id, in_ms: inMs, out_ms: outMs, duration_ms: outMs } as unknown as Clip;
}

const A = clip("a", 0, 10_000);
const B = clip("b", 0, 8_000);
const C = clip("c", 0, 12_000);
const D = clip("d", 0, 6_000);
const film = [A, B, C, D];

// --- filmTimeAtClipStart is monotonic non-decreasing in `index` ------------
for (const xf of [0, XFADE_DUR_MS]) {
  for (const cards of [
    [false, false, false, false],
    [false, true, false, false],
    [true, true, false, true],
    [true, false, true, false],
  ]) {
    let prev = -Infinity;
    let ok = true;
    let worst = "";
    for (let i = 0; i <= film.length; i++) {
      const t = filmTimeAtClipStart(film, i, xf, cards);
      if (t < prev - 1e-6) { ok = false; worst = `i=${i}: ${prev} -> ${t}`; break; }
      prev = t;
    }
    check(`filmTimeAtClipStart monotonic in index (xfade=${xf}, cards=${cards.join("")})`, ok, worst);
  }
}

// --- filmTimeAtClipStart(0) is always 0 -----------------------------------
check("filmTimeAtClipStart(_, 0) === 0 (no card)", filmTimeAtClipStart(film, 0, XFADE_DUR_MS, [false, false, false, false]) === 0);
check("filmTimeAtClipStart(_, 0) === 0 (open card -- returns the CARD-region start, still 0)",
  filmTimeAtClipStart(film, 0, XFADE_DUR_MS, [true, false, false, false]) === 0);

// --- each card preceding a clip adds exactly one card-region of lead -------
for (const xf of [0, XFADE_DUR_MS]) {
  const noCards = filmTimeAtClipStart(film, 3, xf, [false, false, false, false]);
  const oneCard = filmTimeAtClipStart(film, 3, xf, [false, true, false, false]);
  const twoCards = filmTimeAtClipStart(film, 3, xf, [true, true, false, false]);
  check(
    `filmTimeAtClipStart: each preceding card adds CARD_DUR_MS - xfade lead (xfade=${xf})`,
    Math.abs((oneCard - noCards) - (CARD_DUR_MS - xf)) < 1e-6 &&
      Math.abs((twoCards - oneCard) - (CARD_DUR_MS - xf)) < 1e-6,
    `no=${noCards} one=${oneCard} two=${twoCards}`,
  );
}

// --- cardRegionMs -------------------------------------------------------------
check("cardRegionMs(0) === CARD_DUR_MS", cardRegionMs(0) === CARD_DUR_MS);
check("cardRegionMs(xfade) === CARD_DUR_MS - xfade", cardRegionMs(XFADE_DUR_MS) === CARD_DUR_MS - XFADE_DUR_MS);
check("cardRegionMs never negative", cardRegionMs(CARD_DUR_MS + 5_000) === 0);

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall filmDuration helper invariants hold");
