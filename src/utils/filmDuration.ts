import type { Clip } from "@/types/project";
import { orderedCardRuns, type PlacedCard, type TransitionConfig } from "@/utils/buildJobConfig";

// Transition timing of the finished film, mirrored from pipeline/transitions.py. The ONE place
// the renderer decides how long each cut is (#284); every screen reads layoutFilm().
// SYNC: transitions.py XFADE_DUR / KEEP_OWN_S / FADE_FLOOR_FRAMES / CARD_VISIBLE_S /
// CARD_PLAIN_S / resolve_cuts() / card_duration_s(). Both sides are held to
// pipeline/fixtures/cut_cases.json.

/** The longest any single cut can be, in ms. */
export const XFADE_DUR_MS = 1500;
/** Every element keeps min(this, half itself) of its own, outside any fade (#284). */
export const KEEP_OWN_MS = 1500;
/** A fade shorter than this many output frames becomes a hard cut (#284). */
export const FADE_FLOOR_FRAMES = 6;
// #190: with a between-clips transition a card is CARD_VISIBLE_MS + its own two cuts; with
// none it is CARD_PLAIN_MS.
export const CARD_VISIBLE_MS = 1500;
export const CARD_PLAIN_MS = 3000;
/** The renderer does not know the output frame rate, so it plans on DJI's 29.97. For footage
 *  at another rate a shortened cut can differ from the export by a frame or two, and a clip
 *  near the hard-cut floor can preview a short fade where the export cuts. */
export const PREVIEW_FPS = 30000 / 1001;

/** Length in seconds of the file the render trims a clip to: whole frames, rounded UP. The
 *  render plans its cuts from that file's length, so the preview must too. */
export function renderedClipS(trimMs: number): number {
  return Math.ceil((trimMs / 1000) * PREVIEW_FPS - 1e-6) / PREVIEW_FPS;
}

/** Transition length of every cut of one film in ms; 0 = hard cut / no fade. */
export interface CutPlan {
  openMs: number;
  /** betweenMs[i] joins element i and element i+1. */
  betweenMs: number[];
  closeMs: number;
}

/**
 * Port of transitions.py resolve_cuts(). `lengthsS` = SECONDS of every element (clips and
 * cards) in film order; null = a card whose length derives from its cuts, so it never limits
 * them. An element keeps min(1.5 s, half itself); the rest is split equally over the sides
 * that fade. A cut takes the smaller of what its two elements allow, at most 1.5 s;
 * shortened cuts are whole frames, and under the floor they become 0.
 */
export function resolveCuts(
  lengthsS: readonly (number | null)[],
  betweenOn: boolean,
  openOn: boolean,
  closeOn: boolean,
  fps: number = PREVIEW_FPS,
): CutPlan {
  const n = lengthsS.length;
  if (n === 0) return { openMs: 0, betweenMs: [], closeMs: 0 };
  const keepS = KEEP_OWN_MS / 1000;
  const fullS = XFADE_DUR_MS / 1000;
  const fullFrames = fullS * fps;
  const keepFrames = Math.ceil(keepS * fps - 1e-9);

  /** Frames element i allows on each of its fading sides; null = no limit. */
  const sideLimit = (i: number): number | null => {
    const d = lengthsS[i];
    if (d === null) return null;
    const sides = Number(i === 0 ? openOn : betweenOn) + Number(i === n - 1 ? closeOn : betweenOn);
    // Long enough for full-length fades on every side (half a frame of tolerance).
    if (sides === 0 || d + 0.5 / fps >= keepS + sides * fullS) return null;
    const frames = Math.floor(d * fps + 0.5);
    const keep = Math.min(keepFrames, Math.floor((frames + 1) / 2));
    return Math.floor(Math.max(frames - keep, 0) / sides);
  };

  const cut = (...elements: number[]): number => {
    const limits = elements.map(sideLimit).filter((v): v is number => v !== null);
    if (limits.length === 0 || Math.min(...limits) >= fullFrames) return XFADE_DUR_MS;
    const frames = Math.min(...limits);
    return frames >= FADE_FLOOR_FRAMES ? (frames * 1000) / fps : 0;
  };

  return {
    openMs: openOn ? cut(0) : 0,
    betweenMs: Array.from({ length: n - 1 }, (_, i) => (betweenOn ? cut(i, i + 1) : 0)),
    closeMs: closeOn ? cut(n - 1) : 0,
  };
}

/** Length of a text card in ms (#190/#284): CARD_VISIBLE_MS + its own two cuts, or
 *  CARD_PLAIN_MS when no between-clips transition is active. */
export function cardDurMs(inMs: number, outMs: number, betweenOn: boolean): number {
  return betweenOn ? CARD_VISIBLE_MS + inMs + outMs : CARD_PLAIN_MS;
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

export interface FilmElement {
  kind: "clip" | "card";
  /** Index within the element's own kind (clip index in `inFilm`, or card ordinal). */
  index: number;
  clip?: Clip;
  card?: PlacedCard;
  /** Played (input) length. */
  nativeMs: number;
  /** Overlap with the previous element (0 for the first). */
  fadeInMs: number;
  /** Overlap with the next element (0 for the last): what the element loses on the ruler. */
  fadeOutMs: number;
}

export interface FilmLayout {
  elements: FilmElement[];
  /** Fade from black into the first element; 0 = none. */
  openMs: number;
  /** Fade to black after the last element; 0 = none. */
  closeMs: number;
}

/**
 * Clips and cards in film order with the length of every cut. Card order comes from
 * `orderedCardRuns` -- the one resolver every interleaving consumer shares (#184): cards sit
 * before their anchor clip; null / orphaned anchors form the trailing run.
 */
export function layoutFilm(inFilm: Clip[], tc: TransitionConfig, placedCards: PlacedCard[]): FilmLayout {
  const betweenOn = tc.between !== "none" || tc.shuffleBetween;
  const openOn = !!tc.opening && tc.opening !== "none";
  const closeOn = !!tc.closing && tc.closing !== "none";
  const runs = orderedCardRuns(placedCards, inFilm.map((c) => c.id));

  const elements: FilmElement[] = [];
  let cardOrdinal = 0;
  const pushCards = (run: PlacedCard[] | undefined) => {
    for (const card of run ?? []) {
      elements.push({ kind: "card", index: cardOrdinal++, card, nativeMs: 0, fadeInMs: 0, fadeOutMs: 0 });
    }
  };
  inFilm.forEach((clip, index) => {
    pushCards(runs.before.get(clip.id));
    elements.push({ kind: "clip", index, clip, nativeMs: trimmedMs(clip), fadeInMs: 0, fadeOutMs: 0 });
  });
  pushCards(runs.end);

  const cuts = resolveCuts(
    elements.map((e) => (e.kind === "clip" ? renderedClipS(e.nativeMs) : betweenOn ? null : CARD_PLAIN_MS / 1000)),
    betweenOn,
    openOn,
    closeOn,
  );
  elements.forEach((e, i) => {
    e.fadeInMs = i > 0 ? cuts.betweenMs[i - 1] : 0;
    e.fadeOutMs = i < elements.length - 1 ? cuts.betweenMs[i] : 0;
    if (e.kind === "card") {
      e.nativeMs = cardDurMs(
        i === 0 ? cuts.openMs : e.fadeInMs,
        i === elements.length - 1 ? cuts.closeMs : e.fadeOutMs,
        betweenOn,
      );
    }
  });
  return { elements, openMs: cuts.openMs, closeMs: cuts.closeMs };
}

/** Net film time each active fade from / to black adds in the render. */
export const BLACK_FADE_NET_MS = 100;

/**
 * Effective DISPLAYED runtime after subtracting every cut's overlap -- mirrors the pipeline
 * telescoping math (#62/#63/#284). This is the value shown to the user as the film runtime,
 * NOT the absolute rendered-file duration (backend/music truth is get_duration(output)).
 * Text cards are real elements of the same chain; each fade to/from black nets +0.1 s.
 */
export function effectiveFilmMs(inFilm: Clip[], tc: TransitionConfig, placedCards: PlacedCard[] = []): number {
  // Guard: no footage clips -> just the card seconds (an all-empty manifest errors in
  // start_job anyway, so this is purely defensive).
  if (inFilm.length === 0) return placedCards.length * CARD_PLAIN_MS;
  const { elements, openMs, closeMs } = layoutFilm(inFilm, tc, placedCards);
  let total = elements.reduce((sum, e) => sum + e.nativeMs - e.fadeOutMs, 0);
  if (openMs > 0) total += BLACK_FADE_NET_MS;
  if (closeMs > 0) total += BLACK_FADE_NET_MS;
  return Math.max(0, total);
}
