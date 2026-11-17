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
import { cardRegionMs, filmTimeAtClipStart, cardDurMs, cardCuts, CARD_VISIBLE_MS, CARD_PLAIN_MS, XFADE_DUR_MS } from "./filmDuration";

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
    `filmTimeAtClipStart: an interior card adds cardDurMs(xf,2) - xfade, the film-first card cardDurMs(xf,1) - xfade (xfade=${xf})`,
    Math.abs((oneCard - noCards) - (cardDurMs(xf, 2) - xf)) < 1e-6 &&
      Math.abs((twoCards - oneCard) - (cardDurMs(xf, 1) - xf)) < 1e-6,
    `no=${noCards} one=${oneCard} two=${twoCards}`,
  );
}

// --- cardRegionMs -------------------------------------------------------------
check("cardDurMs(0) === 3000 (no transition: card unchanged)", cardDurMs(0) === CARD_PLAIN_MS);
check("cardDurMs(1500) === 4500 (#190: 1.5s visible + 2 x 1.5s, interior card)", cardDurMs(XFADE_DUR_MS) === 4500);
check("cardDurMs(1500, 1) === 3000 (first/last card: one neighbouring crossfade)", cardDurMs(XFADE_DUR_MS, 1) === 3000);
check("cardCuts: first=1, interior=2, last=1, sole=0",
  cardCuts(0, 5) === 1 && cardCuts(2, 5) === 2 && cardCuts(4, 5) === 1 && cardCuts(0, 1) === 0);
check("cardCuts with opening+closing fades: first and last element count the fade as a cut",
  cardCuts(0, 5, { open: true, close: true }) === 2 && cardCuts(4, 5, { open: true, close: true }) === 2 &&
  cardCuts(0, 5, { open: true, close: false }) === 2 && cardCuts(4, 5, { open: true, close: false }) === 1 &&
  cardCuts(2, 5, { open: true, close: true }) === 2);
for (const cuts of [0, 1, 2]) {
  check(`every card keeps exactly ${CARD_VISIBLE_MS}ms fully visible (cuts=${cuts})`, cardDurMs(XFADE_DUR_MS, cuts) - cuts * XFADE_DUR_MS === CARD_VISIBLE_MS);
}
check("no transition: every card stays 3000ms whatever its position", cardDurMs(0, 0) === 3000 && cardDurMs(0, 1) === 3000 && cardDurMs(0, 2) === 3000);
check("cardRegionMs(0) === 3000", cardRegionMs(0) === CARD_PLAIN_MS);
check("cardRegionMs(xfade) interior === visible + 2 x xfade - xfade", cardRegionMs(XFADE_DUR_MS) === CARD_VISIBLE_MS + XFADE_DUR_MS);
check("cardRegionMs last element keeps its full length (no outgoing cut)", cardRegionMs(XFADE_DUR_MS, 1, true) === CARD_VISIBLE_MS + XFADE_DUR_MS);
check("interior card keeps exactly the visible time between two crossfades", cardDurMs(XFADE_DUR_MS) - 2 * XFADE_DUR_MS === CARD_VISIBLE_MS);
check("shorter crossfade (800ms): same visible time", cardDurMs(800) - 2 * 800 === CARD_VISIBLE_MS);

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall filmDuration helper invariants hold");
