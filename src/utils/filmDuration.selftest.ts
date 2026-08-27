/**
 * Standalone self-test for the #163 film-mode playhead invariants. No unit-test runner
 * exists in this project (E2E-only, see package.json) -- run this directly:
 *
 *   pnpm dlx tsx src/utils/filmDuration.selftest.ts
 *
 * Exit 0 = all invariants hold, exit 1 = a failure (prints which). Mirrors the pipeline's
 * standalone `_test_*.py` convention. Kept in the repo as executable documentation of the
 * cross-boundary monotonicity CPO required for #163 Gate 3.
 */
import type { Clip } from "@/types/project";
import { cardRegionMs, filmPlayheadAtClip, filmTimeAtClipStart, CARD_DUR_MS } from "./filmDuration";

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
  // Only the fields filmDuration reads are needed; cast through unknown for the rest.
  return { id, in_ms: inMs, out_ms: outMs, duration_ms: outMs } as unknown as Clip;
}

/**
 * #163 is specifically about the CARD region double-traverse. This samples, per clip:
 *   - if a card precedes it: the 3s card-hold needle (clamped to the card-region width,
 *     mirroring `cardHold.filmMs + Math.min(elapsed, cardRegionMs)`), THEN
 *   - the first instants of that clip's own playback (offset 0 -> 500ms).
 * i.e. every clip[i-1]-end -> card -> clip[i]-start seam. It does NOT sample the full
 * clip body, because clip->clip crossfade seams telescope by `xfadeMs` (a pre-existing
 * `filmTimeAtClipStart` property, unchanged by #163 — the raw formula reduces to the old
 * expression when no card precedes the clip) and would swamp the card signal.
 */
function cardSeamSamples(
  inFilm: Clip[],
  xfadeMs: number,
  cardsBeforeClip: boolean[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < inFilm.length; i++) {
    if (cardsBeforeClip[i]) {
      const base = filmTimeAtClipStart(inFilm, i, xfadeMs, cardsBeforeClip);
      for (let e = 0; e <= CARD_DUR_MS; e += 250) {
        out.push(base + Math.min(e, cardRegionMs(xfadeMs)));
      }
      for (let off = 0; off <= 500; off += 100) {
        out.push(filmPlayheadAtClip(inFilm, i, xfadeMs, cardsBeforeClip, off));
      }
    }
  }
  return out;
}

function assertMonotonic(label: string, samples: number[]) {
  let ok = true;
  let worst = "";
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < samples[i - 1] - 1e-6) {
      ok = false;
      worst = `idx ${i}: ${samples[i - 1].toFixed(1)} -> ${samples[i].toFixed(1)}`;
      break;
    }
  }
  check(`${label} - card-seam needle is monotonic non-decreasing (no snap-back)`, ok, worst);
}

const A = clip("a", 0, 10_000);
const B = clip("b", 0, 8_000);
const C = clip("c", 0, 12_000);
const D = clip("d", 0, 6_000);

// --- 0 cards -----------------------------------------------------------------
{
  const film = [A, B, C];
  const cards = [false, false, false];
  for (const xf of [0, 1500]) {
    assertMonotonic(`0 cards, xfade=${xf}`, cardSeamSamples(film, xf, cards));
    check(
      `0 cards, xfade=${xf} - filmPlayheadAtClip === filmTimeAtClipStart + offset`,
      filmPlayheadAtClip(film, 2, xf, cards, 1234) ===
        filmTimeAtClipStart(film, 2, xf, cards) + 1234,
    );
  }
}

// --- 1 mid-roll card (before B) --------------------------------------------
{
  const film = [A, B, C];
  const cards = [false, true, false];
  for (const xf of [0, 1500]) {
    const s = cardSeamSamples(film, xf, cards);
    assertMonotonic(`1 mid-roll card, xfade=${xf}`, s);
    // Hold end (card-region start + region width) must equal clip B's playhead at offset 0.
    const holdEnd =
      filmTimeAtClipStart(film, 1, xf, cards) + cardRegionMs(xf);
    const bStart = filmPlayheadAtClip(film, 1, xf, cards, 0);
    check(
      `1 mid-roll card, xfade=${xf} - card-hold end meets clip B start (no snap-back)`,
      Math.abs(holdEnd - bStart) < 1e-6,
      `holdEnd=${holdEnd} bStart=${bStart}`,
    );
    // Clip B's needle must NOT sit at/behind the card-region start.
    check(
      `1 mid-roll card, xfade=${xf} - clip B needle is past the card region`,
      bStart > filmTimeAtClipStart(film, 1, xf, cards),
    );
  }
}

// --- 2+ mid-roll cards (before B and before D) — the CPO "N cards" case -----
{
  const film = [A, B, C, D];
  const cards = [false, true, false, true];
  for (const xf of [0, 1500]) {
    assertMonotonic(`2 mid-roll cards, xfade=${xf}`, cardSeamSamples(film, xf, cards));
    // Every card-preceded clip meets its own preceding hold with no backward jump.
    for (const i of [1, 3]) {
      const holdEnd = filmTimeAtClipStart(film, i, xf, cards) + cardRegionMs(xf);
      const clipStart = filmPlayheadAtClip(film, i, xf, cards, 0);
      check(
        `2 mid-roll cards, xfade=${xf} - clip idx ${i} start meets its hold end`,
        Math.abs(holdEnd - clipStart) < 1e-6,
        `holdEnd=${holdEnd} clipStart=${clipStart}`,
      );
    }
    // Correction is exactly ONE card width regardless of how many cards precede (CPO claim).
    const naiveArr: boolean[] = [false, false, false, false];
    const dCorrected = filmPlayheadAtClip(film, 3, xf, cards, 0);
    const dNoCardImmediatelyBefore = filmPlayheadAtClip(film, 3, xf, [true, true, false, false], 0);
    check(
      `2 mid-roll cards, xfade=${xf} - only the immediately-preceding card adds to clip D`,
      Math.abs(
        dCorrected - (filmTimeAtClipStart(film, 3, xf, cards) + cardRegionMs(xf)),
      ) < 1e-6 &&
        filmPlayheadAtClip(film, 3, xf, naiveArr, 0) === filmTimeAtClipStart(film, 3, xf, naiveArr),
      `dCorrected=${dCorrected} dNoImmediate=${dNoCardImmediatelyBefore}`,
    );
  }
}

// --- open card only (before A) -------------------------------------------
{
  const film = [A, B, C];
  const cards = [true, false, false];
  for (const xf of [0, 1500]) {
    assertMonotonic(`open card only, xfade=${xf}`, cardSeamSamples(film, xf, cards));
    check(
      `open card only, xfade=${xf} - clip A needle starts after the open-card region`,
      filmPlayheadAtClip(film, 0, xf, cards, 0) >= cardRegionMs(xf) - 1e-6,
    );
  }
}

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall film-mode playhead invariants hold");
