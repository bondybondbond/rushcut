/**
 * Single authoritative sequence-time model for film-mode preview playback (#165).
 *
 * WHY THIS EXISTS
 * --------------
 * Film-mode playback in Trimmer + Sound historically kept TWO position clocks:
 * the real `<video>.currentTime` for clip playback, and a separate
 * `performance.now()`-anchored ticker for text-card hold regions. The hand-off
 * between them is where a whole bug cluster lived -- needle stepping backward
 * ~xfadeMs at every crossfade cut (#164), card-region double-traverse (#163),
 * Sound's duration/fade math ignoring card seconds (#160), seek-onto-card
 * diverging between the two screens (#166).
 *
 * The model here mirrors the render path's flat ordered `ClipItem` + `kind`
 * list (`.claude/rules/pipeline.md`) and the industry-standard edit-list model
 * (OpenTimelineIO / MLT / Remotion): ONE flat ordered list of items (clips +
 * cards), each with a half-open `[filmStartMs, filmEndMs)` span in sequence
 * space, plus a parallel non-telescoped `[naiveStartMs, naiveEndMs)` span that
 * backs pixel geometry / scrub-bar math. The `<video>` element becomes a slave:
 * its reported position is only ever a drift-correction INPUT, never the clock.
 *
 * CANONICAL UNIT: integer-ish milliseconds throughout (fractional ms tolerated
 * from `performance.now()` deltas). Seconds only appear at the `<video>` DOM
 * boundary in the calling components.
 *
 * All exports here are PURE -- no React, no DOM, no time source. That keeps the
 * whole model unit-testable in `sequenceClock.selftest.ts`
 * (`pnpm dlx tsx src/utils/sequenceClock.selftest.ts`).
 */
import type { Clip } from "@/types/project";
import type { PlacedCard } from "@/utils/buildJobConfig";
import type { TransitionConfig } from "@/utils/buildJobConfig";
import { CARD_DUR_MS, clampedXfadeMs, effectiveFilmMs, trimmedMs } from "@/utils/filmDuration";

export { CARD_DUR_MS };

// ---------------------------------------------------------------------------
// Sequence structure
// ---------------------------------------------------------------------------

export type SeqItemKind = "clip" | "card";

export interface SeqItem {
  kind: SeqItemKind;
  /** Index within the item's own kind: clip index in `inFilm`, or card ordinal. */
  index: number;
  /** Position in the flat `items` array. */
  segIndex: number;
  /** Telescoped (render-time) span -- half-open [filmStartMs, filmEndMs). */
  filmStartMs: number;
  filmEndMs: number;
  /** Non-telescoped span -- backs pixel geometry / naive scrub math. */
  naiveStartMs: number;
  naiveEndMs: number;
  /** Media (source-file) coordinates -- clips only. */
  sourceInMs?: number;
  sourceOutMs?: number;
  /** Backing data. */
  clip?: Clip;
  card?: PlacedCard;
}

export interface Sequence {
  items: SeqItem[];
  /** Telescoped, card-inclusive playback runtime (ms). Matches the strip ruler. */
  totalMs: number;
  /** Non-telescoped sum of item widths (ms). Backs naive px geometry. */
  naiveTotalMs: number;
  /** Per-cut crossfade overlap consumed at every seam (0 when no crossfade). */
  xfadeMs: number;
}

/**
 * Build the flat ordered item list for a film. Card placement matches the
 * StickyFilmStrip / seekFilmTo model exactly: a card with `beforeClipId === c.id`
 * sits immediately before clip `c`; a card with `beforeClipId === null` is the
 * trailing end card. At most one card per anchor (mirrors the strip's Map).
 *
 * Telescoping rule (identical to `StickyFilmStrip.tsx` `renderMsArr`): every
 * element but the LAST loses one `xfadeMs` off its tail to the crossfade into
 * the next element. `totalMs` therefore == the telescoped, card-inclusive
 * runtime -- NOT the display label value from `effectiveFilmMs`, which
 * additionally nets +100ms per open/close-to-black transition (a black-fade
 * artifact the preview does not traverse). Use `effectiveFilmMs` for the
 * runtime LABEL; use `Sequence.totalMs` for the playback CLOCK domain.
 */
export function buildSequence(
  inFilm: Clip[],
  tc: TransitionConfig,
  placedCards: PlacedCard[],
): Sequence {
  return buildSequenceCore(inFilm, clampedXfadeMs(inFilm, tc), placedCards);
}

/**
 * The single canonical film-timeline resolver (#174 Phase D). `buildSequence`
 * above is the convenience entry that derives `xfadeMs` from a `TransitionConfig`;
 * `StickyFilmStrip` already holds the clamped overlap as a prop, so it calls this
 * core directly. Both entry points share the one telescoping / prefix-sum
 * implementation here -- given the same `xfadeMs` they produce byte-identical
 * geometry, so the strip ruler and the playback needle cannot geometrically
 * disagree. (Callers must pass `clampedXfadeMs(inFilm, tc)` for that `xfadeMs` --
 * `buildSequence` does; `StickyFilmStrip`'s parent passes it as `xfadeOverlapMs`.)
 *
 * `cards` need only carry `id` + `beforeClipId`; `color`/`text`/`subtitle` are
 * copied onto `SeqItem.card` when present but are never read for geometry.
 */
export function buildSequenceCore(
  inFilm: Clip[],
  xfadeMs: number,
  placedCards: PlacedCard[],
): Sequence {
  const cardBefore = new Map<string, PlacedCard>(
    placedCards.filter((c) => c.beforeClipId !== null).map((c) => [c.beforeClipId as string, c]),
  );
  const endCard = placedCards.find((c) => c.beforeClipId === null) ?? null;

  // 1. Flat native-width segment list (clips + cards interleaved).
  type Raw =
    | { kind: "clip"; nativeMs: number; clip: Clip; index: number }
    | { kind: "card"; nativeMs: number; card: PlacedCard };
  const raw: Raw[] = [];
  let cardOrdinal = 0;
  const cardOrdinalOf = new Map<PlacedCard, number>();
  inFilm.forEach((c, i) => {
    const here = cardBefore.get(c.id);
    if (here) {
      cardOrdinalOf.set(here, cardOrdinal++);
      raw.push({ kind: "card", nativeMs: CARD_DUR_MS, card: here });
    }
    raw.push({ kind: "clip", nativeMs: trimmedMs(c), clip: c, index: i });
  });
  if (endCard) {
    cardOrdinalOf.set(endCard, cardOrdinal++);
    raw.push({ kind: "card", nativeMs: CARD_DUR_MS, card: endCard });
  }

  // 2. Telescoped + naive prefix sums.
  const items: SeqItem[] = [];
  let filmCur = 0;
  let naiveCur = 0;
  raw.forEach((r, i) => {
    const isLast = i === raw.length - 1;
    const telescopedMs = Math.max(0, r.nativeMs - (isLast ? 0 : xfadeMs));
    const item: SeqItem = {
      kind: r.kind,
      index: r.kind === "clip" ? r.index : (cardOrdinalOf.get(r.card) ?? 0),
      segIndex: i,
      filmStartMs: filmCur,
      filmEndMs: filmCur + telescopedMs,
      naiveStartMs: naiveCur,
      naiveEndMs: naiveCur + r.nativeMs,
    };
    if (r.kind === "clip") {
      item.clip = r.clip;
      item.sourceInMs = r.clip.in_ms ?? 0;
      item.sourceOutMs = r.clip.out_ms ?? r.clip.duration_ms;
    } else {
      item.card = r.card;
    }
    items.push(item);
    filmCur += telescopedMs;
    naiveCur += r.nativeMs;
  });

  return { items, totalMs: filmCur, naiveTotalMs: naiveCur, xfadeMs };
}

// ---------------------------------------------------------------------------
// Pure position maps
// ---------------------------------------------------------------------------

export interface ItemPosition {
  kind: SeqItemKind;
  /** Index within the item's own kind. */
  index: number;
  /** Position in the flat `items` array. */
  segIndex: number;
  /** Elapsed ms inside the resolved item (telescoped domain), >= 0. */
  localMs: number;
  /** True when `filmMs` was at/past the end of the sequence (clamped). */
  atEnd: boolean;
}

/**
 * Map a telescoped film-time to the item that owns it.
 *
 * HALF-OPEN: a film-time exactly on a boundary (`item.filmEndMs`) belongs to the
 * NEXT item, never the one ending there.
 *
 * ZERO-WIDTH INVARIANT (#165 Gate 3 F6/F7): a card telescoped to
 * `CARD_DUR_MS - xfadeMs`, or a pathological zero-trim clip, can produce
 * `filmStartMs === filmEndMs`. Such items are kept in `seq.items` for index
 * alignment but are NEVER returned here -- a sub-frame item that never gets a
 * playhead is not a bug, it is a segment with no screen time.
 *
 * PAST-END SENTINEL: `filmMs >= totalMs` (or no non-zero-width item matches)
 * resolves to the last non-zero-width item, `localMs` = its full width,
 * `atEnd: true`. Never throws, never returns null.
 */
export function filmToItem(seq: Sequence, filmMs: number): ItemPosition {
  const t = Math.max(0, Math.min(filmMs, seq.totalMs));
  for (const it of seq.items) {
    if (it.filmEndMs <= it.filmStartMs) continue; // zero-width -> skip
    if (t < it.filmEndMs) {
      return {
        kind: it.kind,
        index: it.index,
        segIndex: it.segIndex,
        localMs: Math.max(0, t - it.filmStartMs),
        atEnd: false,
      };
    }
  }
  // Past the last non-zero-width item -> clamp-to-last-end sentinel.
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const it = seq.items[i];
    if (it.filmEndMs > it.filmStartMs) {
      return {
        kind: it.kind,
        index: it.index,
        segIndex: it.segIndex,
        localMs: it.filmEndMs - it.filmStartMs,
        atEnd: true,
      };
    }
  }
  // Degenerate: no real items at all.
  return { kind: "clip", index: 0, segIndex: 0, localMs: 0, atEnd: true };
}

/**
 * Inverse of `filmToItem`: telescoped film-time at `localMs` into the item of
 * `kind` with `index`. `localMs` is clamped to the item's telescoped width.
 * Returns 0 if no such item exists (degenerate film).
 */
export function itemToFilm(
  seq: Sequence,
  kind: SeqItemKind,
  index: number,
  localMs: number,
): number {
  const it = seq.items.find((x) => x.kind === kind && x.index === index);
  if (!it) return 0;
  const width = it.filmEndMs - it.filmStartMs;
  return it.filmStartMs + Math.max(0, Math.min(localMs, width));
}

export type MediaPosition =
  | { kind: "clip"; clipIndex: number; mediaMs: number; atEnd: boolean }
  | { kind: "card"; cardIndex: number; cardLocalMs: number; atEnd: boolean };

/**
 * Map a telescoped film-time to what the `<video>` (or card overlay) should show.
 * For a clip, media time maps 1:1 from the within-item offset onto the source
 * file: `mediaMs = sourceInMs + localMs`, clamped to `sourceOutMs`. This matches
 * the long-standing `seekToMs = in_ms + offsetInClip` rule in seekFilmTo.
 */
export function filmToMedia(seq: Sequence, filmMs: number): MediaPosition {
  const pos = filmToItem(seq, filmMs);
  const it = seq.items[pos.segIndex];
  if (pos.kind === "card" || !it || it.kind !== "clip") {
    return { kind: "card", cardIndex: pos.index, cardLocalMs: pos.localMs, atEnd: pos.atEnd };
  }
  const sIn = it.sourceInMs ?? 0;
  const sOut = it.sourceOutMs ?? sIn + pos.localMs;
  return {
    kind: "clip",
    clipIndex: pos.index,
    mediaMs: Math.max(sIn, Math.min(sIn + pos.localMs, sOut)),
    atEnd: pos.atEnd,
  };
}

/**
 * Media (source-file ms) inside clip `clipIndex` -> telescoped film-time.
 * The seam-safe inverse of `filmToMedia` for the drift-correction path: given
 * what frame the `<video>` is actually presenting, where is that on the clock.
 * `mediaMs` outside the clip's [sourceInMs, sourceOutMs] is clamped.
 */
export function mediaToFilm(seq: Sequence, clipIndex: number, mediaMs: number): number {
  const it = seq.items.find((x) => x.kind === "clip" && x.index === clipIndex);
  if (!it) return 0;
  const sIn = it.sourceInMs ?? 0;
  const sOut = it.sourceOutMs ?? sIn;
  const local = Math.max(0, Math.min(mediaMs, sOut) - sIn);
  const width = it.filmEndMs - it.filmStartMs;
  return it.filmStartMs + Math.min(local, width > 0 ? width : local);
}

// ---------------------------------------------------------------------------
// Naive <-> telescoped geometry (pixel / scrub-bar domain)
// ---------------------------------------------------------------------------

/** Telescoped film-time -> non-telescoped (naive) time, within the owning item. */
export function filmToNaive(seq: Sequence, filmMs: number): number {
  const t = Math.max(0, Math.min(filmMs, seq.totalMs));
  for (const it of seq.items) {
    if (it.filmEndMs <= it.filmStartMs) continue;
    if (t < it.filmEndMs) {
      const frac = (t - it.filmStartMs) / (it.filmEndMs - it.filmStartMs);
      return it.naiveStartMs + frac * (it.naiveEndMs - it.naiveStartMs);
    }
  }
  return seq.naiveTotalMs;
}

/** Non-telescoped (naive) time -> telescoped film-time, within the owning item. */
export function naiveToFilm(seq: Sequence, naiveMs: number): number {
  const n = Math.max(0, Math.min(naiveMs, seq.naiveTotalMs));
  for (const it of seq.items) {
    if (it.naiveEndMs <= it.naiveStartMs) continue;
    if (n < it.naiveEndMs) {
      const frac = (n - it.naiveStartMs) / (it.naiveEndMs - it.naiveStartMs);
      return it.filmStartMs + frac * (it.filmEndMs - it.filmStartMs);
    }
  }
  return seq.totalMs;
}

// ---------------------------------------------------------------------------
// Free-running clock accrual (pure)
// ---------------------------------------------------------------------------

export interface ClockState {
  /** Authoritative sequence position in ms. */
  seqTimeMs: number;
  /** `nowMs` of the last accrual sample (a `performance.now()` reading). */
  lastSampleMs: number;
}

export interface AdvanceOpts {
  visible: boolean;
  isPlaying: boolean;
  totalMs: number;
  /** Deltas larger than this are treated as a stall / clock jump, never accrued. */
  stallMs?: number;
}

/**
 * Advance the free-running clock by wall-clock elapsed since the last sample.
 *
 * The clock is `performance.now()`-driven; rAF is only the SAMPLING tick. This
 * function is what governs background / hidden / OS-sleep behaviour (#165 Gate 3
 * F16/F18/F19; Gate 2: "A Tale of Two Clocks" -- rAF reads the authoritative
 * clock, it does not integrate its own delta). On a Tauri/WebView2 desktop app
 * the user alt-tabs and sleeps the machine, and a naive `seqTimeMs += dt` would
 * turn a 5-minute background gap into a 5-minute playback jump (Chrome for
 * Developers: rAF stops entirely while hidden; on resume the first delta is huge
 * and must be discarded, not integrated).
 *
 *  - not playing OR not visible  -> re-anchor `lastSampleMs`, accrue NOTHING
 *  - dt < 0 (clock went backwards) or dt > stallMs -> re-anchor, accrue NOTHING
 *  - otherwise                    -> `seqTimeMs += dt`, clamped to [0, totalMs]
 *
 * Re-anchoring (not accruing) on resume means playback continues from exactly
 * where it paused -- never a catch-up jump. Callers that want the picture to be
 * authoritative after a long background gap should additionally re-seat
 * `seqTimeMs` from the media element via `mediaToFilm` on `visibilitychange`.
 */
export function advanceSequenceClock(
  state: ClockState,
  nowMs: number,
  opts: AdvanceOpts,
): ClockState {
  const stall = opts.stallMs ?? 500;
  if (!opts.isPlaying || !opts.visible) {
    return { seqTimeMs: state.seqTimeMs, lastSampleMs: nowMs };
  }
  const dt = nowMs - state.lastSampleMs;
  if (dt < 0 || dt > stall) {
    return { seqTimeMs: state.seqTimeMs, lastSampleMs: nowMs };
  }
  const next = state.seqTimeMs + dt;
  const clamped = next < 0 ? 0 : next > opts.totalMs ? opts.totalMs : next;
  return { seqTimeMs: clamped, lastSampleMs: nowMs };
}

// ---------------------------------------------------------------------------
// Clock <-> media reconciliation (pure)
// ---------------------------------------------------------------------------

/**
 * SYNC CONTRACT (#174 Gate 3, finding #10) -- the quantitative sync guarantee the
 * film-mode needle upholds, made explicit so it is testable rather than implicit
 * in `reconcile`'s default args. These are the values `reconcile` has shipped with
 * since #165 Phase A+B; naming them here freezes them as a contract and lets both
 * `sequenceClock.selftest.ts` and the film-mode WDIO spec assert against them.
 *
 *  DEAD_BAND_MS   below this |drift| the needle is left alone (must stay well
 *                 above HTMLMediaElement.currentTime's ~2ms reduced precision so
 *                 precision noise alone never triggers a correction).
 *  FWD_SNAP_MS    media is AHEAD of the clock by at least this -> hard-snap the
 *                 clock FORWARD to the media (always monotonic, always safe).
 *  HARD_BACK_MS   clock is AHEAD of a badly-stalled media by at least this -> the
 *                 only condition under which a BACKWARD clock correction is
 *                 accepted. Deliberately >2x FWD_SNAP so an ordinary crossfade
 *                 seam or a slow decode can never yank the needle backward -- the
 *                 exact #164 signature this whole migration exists to kill.
 *  MAX_RATE       max deviation of the gentle-zone playbackRate nudge from 1.0.
 *  MAX_SNAPS_PER_MIN  budget for hard snaps (either direction) over a minute of
 *                 continuous playback. The 3-zone design structurally cannot
 *                 ping-pong at a boundary -- a forward snap needs drift <= -250ms,
 *                 a backward snap needs drift >= +600ms, and the 40..600ms band
 *                 in between only ever nudges playbackRate, never snaps -- so a
 *                 healthy playthrough sits far under this. A run that exceeds it
 *                 means reconcile is fighting something (a stuck decoder, a second
 *                 needle writer) and the WDIO spec fails loudly rather than
 *                 shipping a visibly juddering needle.
 */
export const SYNC_CONTRACT = {
  DEAD_BAND_MS: 40,
  FWD_SNAP_MS: 250,
  HARD_BACK_MS: 600,
  MAX_RATE: 0.06,
  MAX_SNAPS_PER_MIN: 20,
} as const;

export interface ReconcileResult {
  /** When set, hard-snap the clock to this value. */
  seqTimeMs?: number;
  /** Desired `<video>.playbackRate` -- 1 when no gentle correction is needed. */
  playbackRate: number;
}

export interface ReconcileOpts {
  /** |drift| below this: do nothing. */
  ignoreMs?: number;
  /** |drift| at/above this: media is ahead -> jump clock forward. */
  snapMs?: number;
  /**
   * drift at/above this (clock ahead, media badly stalled): accept a BACKWARD
   * clock correction. Deliberately well above `snapMs` so an ordinary crossfade
   * seam or a slow decode never yanks the needle backward -- the exact #164
   * failure signature this whole issue exists to kill.
   */
  hardBackMs?: number;
  /** Max deviation of the gentle-zone playbackRate from 1.0. */
  maxRate?: number;
}

/**
 * Decide how to reconcile the authoritative clock against what the `<video>` is
 * actually presenting (`mediaFilmMs`, derived via `mediaToFilm`).
 *
 * Three zones (#165 Gate 3 F9/F12 -- replaces the naive snap-only policy):
 *   |drift| < ignoreMs                  -> no-op
 *   drift <= -snapMs (media ahead)      -> hard-snap clock FORWARD to media (monotonic, always safe)
 *   drift >=  hardBackMs (media stalled)-> hard-snap clock BACKWARD to media (rare, correctness > smoothness)
 *   otherwise                           -> gentle: nudge `<video>.playbackRate` toward closing drift
 *
 * INVARIANT (asserted in the selftest): for `drift < hardBackMs` this NEVER
 * returns a `seqTimeMs` -- i.e. inside the normal operating range the clock is
 * only ever corrected by speeding/slowing the media, never stepped backward.
 *
 * IMPLEMENTATION GUIDANCE (Gate 2: web.dev "Tale of Two Clocks", O'Reilly Web
 * Audio, WICG video-rvfc#62): the dead-band + snap is the load-bearing part; the
 * gentle `playbackRate` zone is a refinement, not a requirement. A caller MAY
 * ignore `playbackRate` entirely and treat the gentle zone as a no-op (pure
 * snap-on-threshold, ~40ms dead-band, ~1-frame) if rate nudging proves
 * visibly/audibly jarring on its media graph. `playbackRate` MUST NOT be applied
 * to an `<audio>` element (cosmetic-sync pitch shift) -- it is a `<video>`-only
 * lever, and for the Sound tab the needle should simply be snapped.
 *
 * The caller should invoke this at ~10Hz (throttled), NOT once per rAF frame.
 */
export function reconcile(
  seqTimeMs: number,
  mediaFilmMs: number,
  opts: ReconcileOpts = {},
): ReconcileResult {
  const IGNORE = opts.ignoreMs ?? SYNC_CONTRACT.DEAD_BAND_MS;
  const SNAP = opts.snapMs ?? SYNC_CONTRACT.FWD_SNAP_MS;
  const HARD_BACK = opts.hardBackMs ?? SYNC_CONTRACT.HARD_BACK_MS;
  const MAX_RATE = opts.maxRate ?? SYNC_CONTRACT.MAX_RATE;

  const drift = seqTimeMs - mediaFilmMs; // > 0 : clock ahead of picture
  const abs = Math.abs(drift);

  if (abs < IGNORE) return { playbackRate: 1 };
  if (drift <= -SNAP) return { seqTimeMs: mediaFilmMs, playbackRate: 1 };
  if (drift >= HARD_BACK) return { seqTimeMs: mediaFilmMs, playbackRate: 1 };

  // Gentle zone: clock ahead -> speed video up (>1) so the picture catches the
  // needle; clock behind -> slow the video down (<1). Bounded to +/- maxRate.
  const rate = 1 + Math.max(-1, Math.min(1, drift / SNAP)) * MAX_RATE;
  return { playbackRate: rate };
}

// ---------------------------------------------------------------------------
// Cross-check helper
// ---------------------------------------------------------------------------

/**
 * The display-label runtime (`effectiveFilmMs`) minus the black-fade net that
 * the preview does not traverse == the playback-clock `totalMs`. Exposed so the
 * selftest can pin the relationship across every transition config without
 * re-encoding the +100ms rule.
 */
export function playbackTotalFromEffective(
  inFilm: Clip[],
  tc: TransitionConfig,
  placedCards: PlacedCard[],
): number {
  const black =
    (tc.opening && tc.opening !== "none" ? 100 : 0) +
    (tc.closing && tc.closing !== "none" ? 100 : 0);
  return effectiveFilmMs(inFilm, tc, placedCards.length) - black;
}
