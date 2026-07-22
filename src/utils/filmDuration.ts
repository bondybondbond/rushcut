import type { Clip } from "@/types/project";
import type { TransitionConfig } from "@/utils/buildJobConfig";

// Crossfade overlap per cut, in ms. MUST stay in sync with pipeline/transitions.py
// XFADE_DUR = 1.5 (seconds). The render telescopes every transition by this amount,
// clamped to half the shortest clip -- see render.py / transitions.py.
export const XFADE_DUR_MS = 1500;

// Open/close text-card duration in ms. MUST stay in sync with pipeline/cards.py
// DEFAULT_DURATION_S = 3.0 (passed as duration_s=3.0 in render.py). Cards are real
// clips prepended/appended to the film and join the same xfade chain.
export const CARD_DUR_MS = 3000;

/** Trimmed length of a single clip in ms (out - in, floored at 0). */
export function trimmedMs(clip: Clip): number {
  return Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
}

/**
 * Naive sum of trimmed clip lengths. This is the TIMELINE GEOMETRY value:
 * clips are laid end-to-end visually and their cumulative start offsets are naive.
 * Use this for px-per-ms, tick marks, scrub-bar position, playhead, and seek math.
 */
export function naiveFilmMs(inFilm: Clip[]): number {
  return inFilm.reduce((sum, c) => sum + trimmedMs(c), 0);
}

/**
 * Effective DISPLAYED runtime after subtracting transition overlap -- mirrors the
 * pipeline telescoping math (#62/#63). This is the value shown to the user as the film
 * runtime, NOT the absolute rendered-file duration. Text cards are real 3s clips the
 * pipeline splices in and that join the same xfade chain, so each active card adds
 * CARD_DUR_MS AND one more xfade overlap regardless of where it sits (#63/#149). Pass
 * the total card count via `cardCount`. Backend/music truth comes from get_duration(output).
 *
 * Mirrors render.py: has_xfade = (between != "none") || shuffleBetween;
 *   elements = clips + open-card + close-card
 *   total = naive(elements) - (elements-1) * min(1500, min(clip)/2)
 * plus +0.1s net per open/close-to-black (black_dur - xfade_dur).
 */
export function effectiveFilmMs(
  inFilm: Clip[],
  tc: TransitionConfig,
  cardCount = 0,
): number {
  const n = inFilm.length;

  // Guard: no footage clips -> just the card seconds (nothing to crossfade between;
  // an all-empty clip manifest errors in start_job anyway, so this is purely defensive).
  // Preserves `return 0` when there are neither clips nor cards.
  if (n === 0) return cardCount * CARD_DUR_MS;

  let total = naiveFilmMs(inFilm) + cardCount * CARD_DUR_MS;

  // Cards count as elements in the xfade chain, so each adds one more (elements-1) overlap.
  const elementCount = n + cardCount;
  const hasOverlap = tc.between !== "none" || tc.shuffleBetween;
  if (hasOverlap && elementCount >= 2) {
    // Guard: clamp against the shortest *non-zero* clip so a pathological
    // zero-length trim can't drive xfade_dur to 0 or negative. Cards are 3s,
    // never the min, so the clamp stays based on real clip durations.
    const positiveDurs = inFilm.map(trimmedMs).filter((d) => d > 0);
    if (positiveDurs.length > 0) {
      const xfadeMs = Math.min(XFADE_DUR_MS, Math.min(...positiveDurs) / 2);
      total -= (elementCount - 1) * xfadeMs;
    }
  }

  // Open/close-to-black each net +0.1s overlap (gated on the transition, not card text).
  if (tc.opening !== "none") total += 100;
  if (tc.closing !== "none") total += 100;

  return Math.max(0, total);
}

/**
 * The single source of the per-cut crossfade overlap value (#71). Mirrors the clamp
 * inside effectiveFilmMs and the pipeline (transitions.py clamps xfade_dur to
 * min(1.5s, shortest_clip / 2)). Returns 0 when no crossfade/shuffle is active or there
 * is nothing to overlap (< 2 clips, or no positive-duration clips).
 *
 * Callers pass the result BOTH to StickyFilmStrip (`xfadeOverlapMs` prop) AND to
 * filmTimeAtClipStart for the playhead, so the ruler and the playhead share exactly one
 * overlap decision and cannot drift apart.
 */
export function clampedXfadeMs(inFilm: Clip[], tc: TransitionConfig): number {
  if (inFilm.length < 2) return 0;
  const hasOverlap = tc.between !== "none" || tc.shuffleBetween;
  if (!hasOverlap) return 0;
  const positiveDurs = inFilm.map(trimmedMs).filter((d) => d > 0);
  if (positiveDurs.length === 0) return 0;
  return Math.min(XFADE_DUR_MS, Math.min(...positiveDurs) / 2);
}

/**
 * Render-time (telescoped) start of clip `index` in film-time ms: the naive cumulative
 * start of the preceding clips minus the overlap consumed by the preceding cuts.
 * This is the ONE boundary formula shared by every screen's playhead feed (Trimmer,
 * Arrange, Sound) so they cannot fork into slightly different telescoping math (#71).
 * Pass the xfade value from clampedXfadeMs(inFilm, tc).
 *
 * `cardsBeforeClip[i]` (#149, generalizes #74's single hasOpenCard boolean to arbitrary
 * mid-roll positions) is true when a text card sits immediately before clip[i] -- each
 * such card adds CARD_DUR_MS of lead time AND one more overlap (the card->clip cut) to
 * every clip at or after it. `false` (default) means no cards at all, byte-identical to
 * the pre-#149 formula. The old single-open-card case is just `[true]` (or omitted since
 * only index 0 mattered) -- callers that don't care about card-precise timing (e.g. Sound's
 * approximate playhead sync) can keep passing `false`.
 */
export function filmTimeAtClipStart(
  inFilm: Clip[],
  index: number,
  xfadeMs: number,
  cardsBeforeClip: boolean[] | false = false,
): number {
  const lim = Math.min(index, inFilm.length);
  let naive = 0;
  for (let i = 0; i < lim; i++) naive += trimmedMs(inFilm[i]);
  const arr = cardsBeforeClip || [];
  let cardsBefore = 0;
  for (let i = 0; i < lim; i++) if (arr[i]) cardsBefore++;
  const lead = cardsBefore * CARD_DUR_MS;
  const cuts = lim + cardsBefore;
  return Math.max(0, lead + naive - cuts * xfadeMs);
}
