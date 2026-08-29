/**
 * Standalone self-test for the #165 sequence-clock model. No unit-test runner
 * exists in this project (E2E-only, see package.json) -- run this directly:
 *
 *   pnpm exec tsx src/utils/sequenceClock.selftest.ts
 *
 * Exit 0 = all invariants hold, exit 1 = a failure (prints which). Mirrors the
 * pipeline's standalone `_test_*.py` convention and the sibling
 * `filmDuration.selftest.ts`.
 *
 * Covers #165 acceptance criteria AC1-AC6 plus the Gate 3 hardening rows:
 *   - round-trip filmToItem/itemToFilm (AC1, offset-bounded)
 *   - totalMs == effectiveFilmMs minus black-fade net, ALL transition configs (AC2)
 *   - needle monotonic non-decreasing across every boundary type, xfade in {0,1500}
 *     plus dip_to_black and shuffleBetween (AC3)
 *   - discriminated-union edge cases: card-at-0, back-to-back cards, past-end
 *     sentinel (AC4)
 *   - half-open: filmToItem(item.filmEndMs) returns the NEXT item (AC5)
 *   - naive<->telescoped geometry inverse round-trip (AC6)
 *   - zero-width item is never returned by filmToItem (Gate 3 F6/F7)
 *   - advanceSequenceClock: hidden span accrues 0, long stall re-anchors w/o jump
 *   - reconcile: 3 zones; NO backward seqTimeMs correction for |drift| < hardBack
 */
import type { Clip } from "@/types/project";
import type { PlacedCard } from "@/utils/buildJobConfig";
import type { TransitionConfig } from "@/utils/buildJobConfig";
import { CARD_DUR_MS, cardRegionMs, clampedXfadeMs, effectiveFilmMs } from "./filmDuration";
import {
  advanceSequenceClock,
  buildSequence,
  buildSequenceCore,
  filmToItem,
  filmToMedia,
  filmToNaive,
  itemToFilm,
  naiveToFilm,
  playbackTotalFromEffective,
  reconcile,
  SYNC_CONTRACT,
  type Sequence,
} from "./sequenceClock";

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
function card(id: string, beforeClipId: string | null): PlacedCard {
  return { id, text: id, subtitle: "", color: "#000000", animation: "none", beforeClipId };
}
function tcfg(over: Partial<TransitionConfig> = {}): TransitionConfig {
  return { between: "none", opening: "none", closing: "none", shuffleBetween: false, ...over };
}

const A = clip("a", 0, 10_000);
const B = clip("b", 2_000, 10_000); // trimmed 8000, non-zero in_ms
const C = clip("c", 0, 12_000);
const D = clip("d", 0, 6_000);

// --- AC2: totalMs matches the strip's telescoped total, ALL transition configs
// AC2 has two halves:
//   (a) buildSequence.totalMs ALWAYS equals an independent recomputation of the
//       StickyFilmStrip renderMsArr telescoped sum -- the "needle matches ruler"
//       contract (holds for every n, including n<2 where clampedXfadeMs is 0).
//   (b) for n>=2 with cards anchored in-film, that also equals
//       effectiveFilmMs minus the +100ms/black-fade net. (n<2 is skipped here:
//       effectiveFilmMs's own inline xfade calc telescopes card seams even at
//       n==1, while clampedXfadeMs -- what the strip AND every playhead caller
//       use -- guards `inFilm.length < 2` to 0. That pre-existing latent
//       divergence is out of #165's scope; buildSequence deliberately follows
//       the strip / clampedXfadeMs so the needle can never disagree with the
//       ruler the user is looking at.)
{
  // Independent strip-total recompute (mirrors StickyFilmStrip renderMsArr).
  function stripTotal(film: Clip[], tc: TransitionConfig, cards: PlacedCard[]): number {
    const seq = buildSequence(film, tc, cards); // reuse item native widths + xfade
    const nativeArr = seq.items.map((it) =>
      it.kind === "card" ? CARD_DUR_MS : (it.naiveEndMs - it.naiveStartMs),
    );
    return nativeArr.reduce(
      (sum, m, i) => sum + Math.max(0, m - (i < nativeArr.length - 1 ? seq.xfadeMs : 0)),
      0,
    );
  }

  const cases: Array<{ film: Clip[]; cards: PlacedCard[] }> = [
    { film: [A, B, C], cards: [] },
    { film: [A, B, C], cards: [card("k1", "b")] },
    { film: [A, B, C], cards: [card("k0", "a"), card("k1", "b"), card("kE", null)] },
    { film: [A, B, C, D], cards: [card("k2", "c")] },
    { film: [A], cards: [] },
    { film: [A], cards: [card("k0", "a"), card("kE", null)] },
  ];
  const transitions: TransitionConfig[] = [
    tcfg(),
    tcfg({ between: "crossfade" }),
    tcfg({ between: "dip_to_black" }),
    tcfg({ shuffleBetween: true }),
    tcfg({ between: "crossfade", opening: "dip_to_black", closing: "dip_to_black" }),
    tcfg({ opening: "dip_to_black" }),
  ];
  for (const { film, cards } of cases) {
    for (const tc of transitions) {
      const seq = buildSequence(film, tc, cards);
      const label = `n=${film.length} cards=${cards.length} ${tc.between}/${tc.opening}/${tc.closing}${tc.shuffleBetween ? "/shuffle" : ""}`;
      check(
        `AC2a totalMs == strip telescoped sum (${label})`,
        Math.abs(seq.totalMs - stripTotal(film, tc, cards)) < 1e-6,
        `seq.totalMs=${seq.totalMs} stripTotal=${stripTotal(film, tc, cards)}`,
      );
      const last = seq.items[seq.items.length - 1];
      check(
        `AC2  totalMs == last item filmEndMs (${label})`,
        !last || Math.abs(last.filmEndMs - seq.totalMs) < 1e-6,
      );
      if (film.length >= 2) {
        const expected = playbackTotalFromEffective(film, tc, cards);
        check(
          `AC2b totalMs == effectiveFilmMs - blackNet (${label})`,
          Math.abs(seq.totalMs - expected) < 1e-6,
          `seq.totalMs=${seq.totalMs} expected=${expected} effectiveFilmMs=${effectiveFilmMs(film, tc, cards.length)}`,
        );
      }
    }
  }
}

// --- AC1: round-trip filmToItem <-> itemToFilm, offset-bounded ---------------
{
  const seq = buildSequence([A, B, C, D], tcfg({ between: "crossfade" }), [
    card("k1", "b"),
    card("kE", null),
  ]);
  for (const it of seq.items) {
    const width = it.filmEndMs - it.filmStartMs;
    if (width <= 0) continue;
    for (const frac of [0, 0.001, 0.5, 0.999]) {
      const localMs = frac * width;
      const filmMs = itemToFilm(seq, it.kind, it.index, localMs);
      const back = filmToItem(seq, filmMs);
      check(
        `AC1 round-trip seg ${it.segIndex} (${it.kind}#${it.index}) frac ${frac}`,
        back.kind === it.kind && back.index === it.index &&
          Math.abs(back.localMs - localMs) < 1e-6,
        `filmMs=${filmMs} -> ${back.kind}#${back.index}+${back.localMs} (want ${it.kind}#${it.index}+${localMs})`,
      );
    }
  }
}

// --- AC5: half-open -- filmToItem(item.filmEndMs) returns the NEXT item -------
{
  const seq = buildSequence([A, B, C], tcfg({ between: "crossfade" }), [card("k1", "b")]);
  for (let i = 0; i < seq.items.length - 1; i++) {
    const it = seq.items[i];
    if (it.filmEndMs <= it.filmStartMs) continue;
    // find next non-zero-width item
    let next = i + 1;
    while (next < seq.items.length && seq.items[next].filmEndMs <= seq.items[next].filmStartMs) next++;
    if (next >= seq.items.length) continue;
    const at = filmToItem(seq, it.filmEndMs);
    check(
      `AC5 half-open boundary at seg ${i} -> next seg ${next}`,
      at.segIndex === seq.items[next].segIndex && at.localMs === 0,
      `got seg ${at.segIndex}+${at.localMs}`,
    );
  }
}

// --- AC4: discriminated-union edge cases ------------------------------------
{
  // card at position 0
  const s0 = buildSequence([A, B], tcfg(), [card("k0", "a")]);
  check("AC4 card-at-0: first item is a card", s0.items[0].kind === "card" && s0.items[0].index === 0);
  check("AC4 card-at-0: filmToItem(0) resolves the card", filmToItem(s0, 0).kind === "card");

  // back-to-back cards (before A and before B, with B immediately after A)
  const sBB = buildSequence([A, B], tcfg(), [card("k0", "a"), card("k1", "b")]);
  const kinds = sBB.items.map((x) => `${x.kind}#${x.index}`).join(",");
  check("AC4 back-to-back cards: order card,clip,card,clip", kinds === "card#0,clip#0,card#1,clip#1", kinds);
  for (let t = 0; t <= sBB.totalMs; t += 250) {
    const p = filmToItem(sBB, t);
    check(`AC4 back-to-back cards: filmToItem(${t}) no throw + in range`, p.segIndex >= 0 && p.segIndex < sBB.items.length, "", );
  }

  // past-end sentinel
  const sE = buildSequence([A, B, C], tcfg({ between: "crossfade" }), []);
  const past = filmToItem(sE, sE.totalMs + 5_000);
  const lastNZ = [...sE.items].reverse().find((x) => x.filmEndMs > x.filmStartMs)!;
  check(
    "AC4 past-end sentinel: clamps to last non-zero-width item, atEnd",
    past.atEnd === true && past.segIndex === lastNZ.segIndex &&
      Math.abs(past.localMs - (lastNZ.filmEndMs - lastNZ.filmStartMs)) < 1e-6,
    `got seg ${past.segIndex}+${past.localMs} atEnd=${past.atEnd}`,
  );
  check("AC4 filmToItem(totalMs) also atEnd sentinel", filmToItem(sE, sE.totalMs).atEnd === true);
}

// --- Gate 3 F6/F7: zero-width item never returned --------------------------
{
  // A card whose telescoped width collapses to 0: CARD_DUR_MS (3000) with an
  // xfade clamp that reaches 3000 needs a clip <= 6000... use a 1000ms clip so
  // xfade clamps to 500; not zero. Force zero via a zero-trim clip instead:
  const Z = clip("z", 5_000, 5_000); // trimmed 0
  const seq = buildSequence([A, Z, C], tcfg({ between: "crossfade" }), []);
  const zItem = seq.items.find((x) => x.kind === "clip" && x.index === 1)!;
  check("F6 zero-trim clip is zero-width", zItem.filmEndMs - zItem.filmStartMs <= 0, `w=${zItem.filmEndMs - zItem.filmStartMs}`);
  let everReturnedZero = false;
  for (let t = 0; t <= seq.totalMs; t += 50) {
    if (filmToItem(seq, t).segIndex === zItem.segIndex) everReturnedZero = true;
  }
  check("F6 filmToItem never resolves to the zero-width item", !everReturnedZero);
}

// --- AC3: needle monotonic across every boundary type ----------------------
{
  function monotonic(label: string, seq: Sequence) {
    let prev = -Infinity;
    let worst = "";
    let ok = true;
    // walk the whole sequence at fine resolution incl. exact boundaries
    const samples: number[] = [];
    for (let t = 0; t <= seq.totalMs; t += 37) samples.push(t);
    for (const it of seq.items) {
      samples.push(it.filmStartMs, it.filmEndMs, it.filmEndMs - 0.001, it.filmEndMs + 0.001);
    }
    samples.sort((a, b) => a - b);
    for (const t of samples) {
      const clamped = Math.max(0, Math.min(t, seq.totalMs));
      const p = filmToItem(seq, clamped);
      // reconstruct an absolute needle film-time from the resolved item
      const abs = itemToFilm(seq, p.kind, p.index, p.localMs);
      if (abs < prev - 1e-6) {
        ok = false;
        worst = `t=${t.toFixed(1)} abs=${abs.toFixed(1)} < prev=${prev.toFixed(1)}`;
        break;
      }
      prev = abs;
    }
    check(`AC3 monotonic - ${label}`, ok, worst);
  }
  const configs: Array<[string, TransitionConfig, PlacedCard[]]> = [
    ["clip->clip xfade=0", tcfg(), []],
    ["clip->clip crossfade", tcfg({ between: "crossfade" }), []],
    ["clip->clip dip_to_black", tcfg({ between: "dip_to_black" }), []],
    ["clip->clip shuffleBetween", tcfg({ shuffleBetween: true }), []],
    ["mid-roll card, xfade=0", tcfg(), [card("k1", "b")]],
    ["mid-roll card, crossfade", tcfg({ between: "crossfade" }), [card("k1", "b")]],
    ["open+mid+end cards, crossfade", tcfg({ between: "crossfade" }), [card("k0", "a"), card("k1", "b"), card("kE", null)]],
    ["open/close-to-black seams", tcfg({ between: "crossfade", opening: "dip_to_black", closing: "dip_to_black" }), [card("k1", "b")]],
  ];
  for (const [label, tc, cards] of configs) monotonic(label, buildSequence([A, B, C, D], tc, cards));
}

// --- AC6: naive <-> telescoped geometry inverse round-trip -----------------
{
  const seq = buildSequence([A, B, C, D], tcfg({ between: "crossfade" }), [card("k1", "b"), card("kE", null)]);
  for (let f = 0; f <= seq.totalMs; f += 91) {
    const n = filmToNaive(seq, f);
    const back = naiveToFilm(seq, n);
    check(
      `AC6 film->naive->film round-trip @ ${f}`,
      Math.abs(back - f) < 1e-3,
      `f=${f} naive=${n.toFixed(2)} back=${back.toFixed(2)}`,
    );
  }
  check("AC6 naive domain endpoint maps to totalMs", Math.abs(naiveToFilm(seq, seq.naiveTotalMs) - seq.totalMs) < 1e-6);
}

// --- filmToMedia: clip media maps 1:1 from within-item offset --------------
{
  const seq = buildSequence([A, B, C], tcfg({ between: "crossfade" }), [card("k1", "b")]);
  const bItem = seq.items.find((x) => x.kind === "clip" && x.index === 1)!;
  const mid = bItem.filmStartMs + 1000;
  const m = filmToMedia(seq, mid);
  check(
    "filmToMedia: within clip B, mediaMs = in_ms + localMs",
    m.kind === "clip" && m.clipIndex === 1 && Math.abs(m.mediaMs - ((B.in_ms ?? 0) + 1000)) < 1e-6,
    JSON.stringify(m),
  );
  const cardItem = seq.items.find((x) => x.kind === "card")!;
  const cm = filmToMedia(seq, cardItem.filmStartMs + 500);
  check("filmToMedia: within a card -> {kind:'card'}", cm.kind === "card" && cm.cardIndex === 0);
}

// --- advanceSequenceClock: lifecycle / stall behaviour --------------------
{
  const TOTAL = 60_000;
  const opts = (over: Partial<Parameters<typeof advanceSequenceClock>[2]> = {}) => ({
    visible: true,
    isPlaying: true,
    totalMs: TOTAL,
    ...over,
  });

  // normal accrual
  let s = { seqTimeMs: 1000, lastSampleMs: 100 };
  s = advanceSequenceClock(s, 116, opts());
  check("clock: normal 16ms tick accrues", Math.abs(s.seqTimeMs - 1016) < 1e-6 && s.lastSampleMs === 116);

  // hidden span accrues NOTHING (re-anchor only)
  s = { seqTimeMs: 5000, lastSampleMs: 1000 };
  s = advanceSequenceClock(s, 250_000, opts({ visible: false }));
  check("clock: hidden span accrues 0, re-anchors lastSampleMs", s.seqTimeMs === 5000 && s.lastSampleMs === 250_000);
  // resume: first visible tick after the gap does NOT integrate the gap
  s = advanceSequenceClock(s, 250_016, opts());
  check("clock: resume after hidden gap continues from where it paused", Math.abs(s.seqTimeMs - 5016) < 1e-6);

  // long stall (OS sleep) with dt > stallMs re-anchors without jump
  s = { seqTimeMs: 8000, lastSampleMs: 1000 };
  s = advanceSequenceClock(s, 5_000_000, opts());
  check("clock: dt > stallMs (500) re-anchors, NO jump", s.seqTimeMs === 8000 && s.lastSampleMs === 5_000_000);

  // negative dt (clock went backwards) is ignored
  s = { seqTimeMs: 3000, lastSampleMs: 10_000 };
  s = advanceSequenceClock(s, 9_000, opts());
  check("clock: negative dt ignored", s.seqTimeMs === 3000 && s.lastSampleMs === 9_000);

  // not playing -> re-anchor, no accrual
  s = { seqTimeMs: 4000, lastSampleMs: 1000 };
  s = advanceSequenceClock(s, 1_400, opts({ isPlaying: false }));
  check("clock: paused accrues 0", s.seqTimeMs === 4000 && s.lastSampleMs === 1_400);

  // clamp to [0, totalMs]
  s = { seqTimeMs: TOTAL - 10, lastSampleMs: 0 };
  s = advanceSequenceClock(s, 400, opts());
  check("clock: clamps to totalMs", s.seqTimeMs === TOTAL);
}

// --- reconcile: three zones + no-backward-correction invariant ------------
{
  // ignore zone
  check("reconcile: |drift| < 40 -> no-op", (() => {
    const r = reconcile(10_000, 10_030);
    return r.seqTimeMs === undefined && r.playbackRate === 1;
  })());

  // media ahead -> snap clock FORWARD (monotonic, always allowed)
  check("reconcile: media ahead by >=250 -> snap forward", (() => {
    const r = reconcile(10_000, 10_400);
    return r.seqTimeMs === 10_400 && r.playbackRate === 1;
  })());

  // media badly stalled (clock ahead by >= hardBack 600) -> backward snap accepted
  check("reconcile: media stalled, drift >= 600 -> backward snap", (() => {
    const r = reconcile(10_700, 10_000);
    return r.seqTimeMs === 10_000;
  })());

  // gentle zone: NO seqTimeMs correction, only a bounded playbackRate
  for (const [seqT, mediaT] of [[10_000, 9_950], [10_000, 10_120], [10_000, 9_700], [10_000, 10_180]] as const) {
    const r = reconcile(seqT, mediaT);
    const drift = seqT - mediaT;
    check(
      `reconcile: gentle zone drift=${drift} -> no seqTimeMs, rate in [0.94,1.06]`,
      r.seqTimeMs === undefined && r.playbackRate >= 0.94 && r.playbackRate <= 1.06,
      JSON.stringify(r),
    );
  }

  // INVARIANT: for any drift with |drift| < hardBack, reconcile never returns a
  // seqTimeMs that is LESS than the current clock (no backstep in the normal range).
  let anyBackstep = false;
  for (let drift = -599; drift < 600; drift += 7) {
    const seqT = 20_000;
    const r = reconcile(seqT, seqT - drift);
    if (r.seqTimeMs !== undefined && r.seqTimeMs < seqT - 1e-6) anyBackstep = true;
  }
  check("reconcile: NO backward seqTimeMs correction for |drift| < hardBack (#164 signature)", !anyBackstep);
}

// --- #174 Phase D: buildSequenceCore == buildSequence, one resolver ---------
{
  const cases: Array<[Clip[], TransitionConfig, PlacedCard[]]> = [
    [[A, B, C], tcfg({ between: "crossfade" }), [card("k1", "b")]],
    [[A, B, C, D], tcfg({ between: "crossfade" }), [card("k0", "a"), card("k1", "b"), card("kE", null)]],
    [[A, B], tcfg(), []],
    [[A], tcfg({ between: "crossfade" }), [card("kE", null)]],
  ];
  for (const [film, tc, cards] of cases) {
    const viaWrapper = buildSequence(film, tc, cards);
    const viaCore = buildSequenceCore(film, clampedXfadeMs(film, tc), cards);
    const label = `n=${film.length} cards=${cards.length} ${tc.between}`;
    check(
      `Phase D: buildSequenceCore geometry identical to buildSequence (${label})`,
      JSON.stringify(viaCore.items.map((i) => [i.filmStartMs, i.filmEndMs, i.naiveStartMs, i.naiveEndMs, i.kind, i.index])) ===
        JSON.stringify(viaWrapper.items.map((i) => [i.filmStartMs, i.filmEndMs, i.naiveStartMs, i.naiveEndMs, i.kind, i.index])) &&
        viaCore.totalMs === viaWrapper.totalMs &&
        viaCore.naiveTotalMs === viaWrapper.naiveTotalMs &&
        viaCore.xfadeMs === viaWrapper.xfadeMs,
    );
  }
}

// --- #174 / #160: music fade-out anchor counts mid-roll card seconds --------
// The Sound Master tab anchors the fade at `filmSeq.totalMs - fadeMs`. A film
// with a mid-roll card must have that anchor sit exactly `cardRegionMs` later
// than the same film without the card -- i.e. the card's on-screen seconds ARE
// part of the total the fade is measured back from (the #160 bug was Sound using
// a naive raw-clip sum that omitted them).
{
  const FADE_MS = 2_000;
  const tc = tcfg({ between: "crossfade" });
  const xf = clampedXfadeMs([A, B, C], tc);
  const noCard = buildSequence([A, B, C], tc, []);
  const withCard = buildSequence([A, B, C], tc, [card("k1", "b")]);
  const anchorNoCard = noCard.totalMs - FADE_MS;
  const anchorWithCard = withCard.totalMs - FADE_MS;
  check(
    "#160 fade anchor shifts later by exactly cardRegionMs when a mid-roll card is present",
    Math.abs((anchorWithCard - anchorNoCard) - cardRegionMs(xf)) < 1e-6,
    `delta=${anchorWithCard - anchorNoCard} cardRegionMs=${cardRegionMs(xf)}`,
  );
  check(
    "#160 fade anchor is inside (0, totalMs) for the carded film",
    anchorWithCard > 0 && anchorWithCard < withCard.totalMs,
    `anchor=${anchorWithCard} totalMs=${withCard.totalMs}`,
  );
}

// --- #174 Gate 3 finding #10: SYNC_CONTRACT + anti-oscillation -------------
{
  // The contract's own shape: a backward snap must be far out of reach of an
  // ordinary forward correction, and the dead-band must clear currentTime's ~2ms
  // reduced precision by a wide margin.
  check(
    "SYNC_CONTRACT: HARD_BACK_MS > 2x FWD_SNAP_MS (a seam can never trigger a backstep)",
    SYNC_CONTRACT.HARD_BACK_MS > 2 * SYNC_CONTRACT.FWD_SNAP_MS,
  );
  check("SYNC_CONTRACT: DEAD_BAND_MS clears currentTime precision noise", SYNC_CONTRACT.DEAD_BAND_MS >= 20);

  // reconcile() actually uses the contract values as its defaults.
  check(
    "SYNC_CONTRACT: reconcile defaults are the contract values",
    // media ahead by exactly FWD_SNAP -> forward snap; one ms less -> gentle
    reconcile(0, SYNC_CONTRACT.FWD_SNAP_MS).seqTimeMs === SYNC_CONTRACT.FWD_SNAP_MS &&
      reconcile(0, SYNC_CONTRACT.FWD_SNAP_MS - 1).seqTimeMs === undefined &&
      // clock ahead of stalled media by exactly HARD_BACK -> backward snap; one ms less -> gentle
      reconcile(SYNC_CONTRACT.HARD_BACK_MS, 0).seqTimeMs === 0 &&
      reconcile(SYNC_CONTRACT.HARD_BACK_MS - 1, 0).seqTimeMs === undefined,
  );

  // ANTI-OSCILLATION 1: nothing in the entire gentle band [-(FWD_SNAP-1) .. (HARD_BACK-1)]
  // ever returns a seqTimeMs -- only a playbackRate nudge. So a correction in this
  // range can never be "undone" by an opposite snap on the next tick.
  {
    let snaps = 0;
    for (let drift = -(SYNC_CONTRACT.FWD_SNAP_MS - 1); drift <= SYNC_CONTRACT.HARD_BACK_MS - 1; drift += 3) {
      if (reconcile(20_000, 20_000 - drift).seqTimeMs !== undefined) snaps++;
    }
    check("anti-oscillation: gentle band never snaps (neither direction)", snaps === 0, `snaps=${snaps}`);
  }

  // ANTI-OSCILLATION 2: a hard snap always lands the clock exactly on the media,
  // so drift becomes 0 and the very next reconcile is a no-op. One snap can never
  // be immediately followed by an opposite-direction snap -> no ping-pong.
  {
    const fwd = reconcile(10_000, 10_400); // media ahead 400 -> forward snap
    const afterFwd = reconcile(fwd.seqTimeMs!, 10_400);
    check(
      "anti-oscillation: tick after a forward snap is a no-op",
      afterFwd.seqTimeMs === undefined && afterFwd.playbackRate === 1,
    );
    const back = reconcile(11_000, 10_000); // clock ahead 1000 -> backward snap
    const afterBack = reconcile(back.seqTimeMs!, 10_000);
    check(
      "anti-oscillation: tick after a backward snap is a no-op",
      afterBack.seqTimeMs === undefined && afterBack.playbackRate === 1,
    );
  }

  // ANTI-OSCILLATION 3: a drift series straddling +/-DEAD_BAND_MS (the value most
  // likely to chatter) never snaps.
  {
    const drifts = [39, -39, 40, -40, 41, -41, 38, -42, 42, -38];
    let anySnap = false;
    for (const d of drifts) if (reconcile(30_000, 30_000 - d).seqTimeMs !== undefined) anySnap = true;
    check("anti-oscillation: dead-band-edge drift series never snaps", !anySnap);
  }
}

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall sequence-clock invariants hold");
