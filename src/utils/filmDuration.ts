import type { Clip } from "@/types/project";
import type { TransitionConfig } from "@/utils/buildJobConfig";

// Crossfade overlap per cut, in ms. MUST stay in sync with pipeline/transitions.py
// XFADE_DUR = 1.5 (seconds). The render telescopes every transition by this amount,
// clamped to half the shortest clip -- see render.py / transitions.py.
export const XFADE_DUR_MS = 1500;

// #190: a card is a real clip in the xfade chain, so each neighbouring cut eats one
// crossfade of it. With a transition active a card is CARD_VISIBLE_MS + one crossfade per
// neighbouring cut (1.5s fully visible between its crossfades, owner 2026-11-17); with none
// it is CARD_PLAIN_MS. MUST stay in sync with pipeline/transitions.py CARD_VISIBLE_S /
// CARD_PLAIN_S / card_duration_s() / card_cuts().
export const CARD_VISIBLE_MS = 1500;
export const CARD_PLAIN_MS = 3000;

/**
 * Crossfades touching the element at `elementIndex` of `elementCount` (0, 1 or 2): one per
 * side, minus the film's own start and end. Elements = clips + cards in film order.
 */
export function cardCuts(
  elementIndex: number,
  elementCount: number,
  edge: EdgeFades = NO_EDGE_FADES,
): number {
  const left = elementIndex > 0 || edge.open ? 1 : 0;
  const right = elementIndex < elementCount - 1 || edge.close ? 1 : 0;
  return left + right;
}

/** The opening / closing transition (fade from / to black) is on. It uses the crossfade
 *  length, so it consumes the film's first / last element exactly like a neighbouring cut. */
export interface EdgeFades {
  open: boolean;
  close: boolean;
}
export const NO_EDGE_FADES: EdgeFades = { open: false, close: false };
export function edgeFadesOf(tc: TransitionConfig): EdgeFades {
  return { open: tc.opening !== "none", close: tc.closing !== "none" };
}

/**
 * Length of a text card in ms (#190): CARD_VISIBLE_MS + one crossfade per neighbouring cut
 * (`cuts`, from cardCuts: 2 inside the film, 1 at the very start/end), or CARD_PLAIN_MS when
 * no transition is active. Same fully-visible time for every card, wherever it sits.
 * `xfadeMs` is the clamped crossfade (clampedXfadeMs), 0 when no transition is active.
 * This only changes the card's INPUT length; the telescoping math is untouched.
 */
export function cardDurMs(xfadeMs: number, cuts = 2): number {
  return xfadeMs > 0 ? CARD_VISIBLE_MS + cuts * xfadeMs : CARD_PLAIN_MS;
}

/** Where cards sit at the film's edges: a card is the first/last ELEMENT of the film. */
export interface CardEdges {
  count: number;
  leading: boolean;
  trailing: boolean;
}

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
 * runtime, NOT the absolute rendered-file duration. Text cards are real clips the
 * pipeline splices in and that join the same xfade chain, so each active card adds its
 * length (cardDurMs) AND one more xfade overlap (#63/#149). Pass the card count and
 * whether a card is the film's first / last element via `cards` (cardEdges()). Backend/music truth comes from get_duration(output).
 *
 * Mirrors render.py: has_xfade = (between != "none") || shuffleBetween;
 *   elements = clips + open-card + close-card
 *   total = naive(elements) - (elements-1) * min(1500, min(clip)/2)
 * plus +0.1s net per open/close-to-black (black_dur - xfade_dur).
 */
export function effectiveFilmMs(
  inFilm: Clip[],
  tc: TransitionConfig,
  cards: CardEdges = { count: 0, leading: false, trailing: false },
): number {
  const n = inFilm.length;
  const cardCount = cards.count;

  // Guard: no footage clips -> just the card seconds (nothing to crossfade between;
  // an all-empty clip manifest errors in start_job anyway, so this is purely defensive).
  // Preserves `return 0` when there are neither clips nor cards.
  if (n === 0) return cardCount * CARD_PLAIN_MS;

  // #190: card length depends on the clamped crossfade (0 when no overlap is active).
  const hasOverlap = tc.between !== "none" || tc.shuffleBetween;
  const positiveDurs = inFilm.map(trimmedMs).filter((d) => d > 0);
  const xfadeForCards =
    hasOverlap && positiveDurs.length > 0
      ? Math.min(XFADE_DUR_MS, Math.min(...positiveDurs) / 2)
      : 0;
  // Each card's length = visible + one crossfade per neighbouring cut: 2 inside the film,
  // 1 for a card that is the film's first / last element (cardCuts).
  const cardCutsTotal =
    2 * cardCount -
    (cards.leading && tc.opening === "none" ? 1 : 0) -
    (cards.trailing && tc.closing === "none" ? 1 : 0);
  let total =
    naiveFilmMs(inFilm) +
    (xfadeForCards > 0
      ? cardCount * CARD_VISIBLE_MS + cardCutsTotal * xfadeForCards
      : cardCount * CARD_PLAIN_MS);

  // Cards count as elements in the xfade chain, so each adds one more (elements-1) overlap.
  const elementCount = n + cardCount;
  if (hasOverlap && elementCount >= 2) {
    // Guard: clamp against the shortest *non-zero* clip so a pathological
    // zero-length trim can't drive xfade_dur to 0 or negative. Cards are >=3s,
    // never the min, so the clamp stays based on real clip durations.
    if (positiveDurs.length > 0) {
      total -= (elementCount - 1) * xfadeForCards;
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
 * is nothing to overlap (fewer than 2 elements, counting `cardCount` text cards as elements like
 * effectiveFilmMs and the render do, #243; or no positive-duration clips).
 *
 * Callers pass the result BOTH to StickyFilmStrip (`xfadeOverlapMs` prop) AND to
 * filmTimeAtClipStart for the playhead, so the ruler and the playhead share exactly one
 * overlap decision and cannot drift apart.
 */
export function clampedXfadeMs(inFilm: Clip[], tc: TransitionConfig, cardCount = 0): number {
  // #243: cards are elements in the render's xfade chain, so 1 clip + a card still crossfades.
  if (inFilm.length + cardCount < 2) return 0;
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
 * Pass the xfade value from clampedXfadeMs(inFilm, tc, cardCount).
 *
 * `cardsBeforeClip[i]` (#149, generalizes #74's single hasOpenCard boolean to arbitrary
 * mid-roll positions) is true when a text card sits immediately before clip[i] -- each
 * such card adds CARD_DUR_MS of lead time AND one more overlap (the card->clip cut) to
 * every clip at or after it. `false` (default) means no cards at all, byte-identical to
 * the pre-#149 formula. The old single-open-card case is just `[true]` (or omitted since
 * only index 0 mattered) -- callers that don't care about card-precise timing (e.g. Sound's
 * approximate playhead sync) can keep passing `false`.
 *
 * CARD-REGION-START CONTRACT (#163): the loop runs `i < index`, so the lead of the card
 * sitting *immediately before* clip[index] (`cardsBeforeClip[index]`) is deliberately NOT
 * counted -- this function returns the CARD-REGION START for a card-preceded clip, not the
 * clip's own visual start. That is exactly what its remaining callers want: the card-park
 * paths in Trimmer's `seekFilmTo`/`gotoFilmClip` (which park the overlay on the card
 * region) and Arrange's static selected-clip playhead.
 *
 * The film-mode PLAYBACK needle no longer uses this at all (#174): it is a pure projection
 * of the authoritative sequence clock (`sequenceClock.ts` `buildSequence` +
 * `advanceSequenceClock`/`reconcile`), where a card is a first-class item with its own
 * telescoped span -- so the "add `cardRegionMs` back" workaround this note used to describe
 * (via the deleted `filmPlayheadAtClip`) is gone.
 */
export function filmTimeAtClipStart(
  inFilm: Clip[],
  index: number,
  xfadeMs: number,
  cardsBeforeClip: boolean[] | false = false,
  edge: EdgeFades = NO_EDGE_FADES,
): number {
  const lim = Math.min(index, inFilm.length);
  let naive = 0;
  for (let i = 0; i < lim; i++) naive += trimmedMs(inFilm[i]);
  const arr = cardsBeforeClip || [];
  let cardsBefore = 0;
  let lead = 0;
  for (let i = 0; i < lim; i++) {
    if (!arr[i]) continue;
    cardsBefore++;
    // The card before clip 0 is the film's first element: one neighbouring cut, not two.
    lead += cardDurMs(xfadeMs, i === 0 ? cardCuts(0, 2, edge) : 2);
  }
  const cuts = lim + cardsBefore;
  return Math.max(0, lead + naive - cuts * xfadeMs);
}

/**
 * Telescoped on-screen width of one text card in film-time ms (#163). A card is a real
 * element in the xfade chain, so it loses one overlap to the following cut -- exactly like
 * a clip (none if it is the film's last element). Single source of this expression: every
 * film-mode playhead site MUST call this instead of re-deriving `cardDurMs - xfadeMs`.
 * Pass the same xfade value from clampedXfadeMs(inFilm, tc) and the card's `cuts`
 * (cardCuts). Equals the card length when no crossfade is active (xfadeMs === 0).
 */
export function cardRegionMs(xfadeMs: number, cuts = 2, isLastElement = false): number {
  return Math.max(0, cardDurMs(xfadeMs, cuts) - (isLastElement ? 0 : xfadeMs));
}
