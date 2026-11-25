/**
 * Standalone self-test for the surviving `filmDuration.ts` helpers. No unit-test
 * runner exists in this project (E2E-only, see package.json) -- run this directly:
 *
 *   pnpm exec tsx src/utils/filmDuration.selftest.ts
 *
 * Exit 0 = all invariants hold, exit 1 = a failure (prints which).
 *
 * #284: transition lengths are per cut. `resolveCuts` is held to the same table as the
 * pipeline (pipeline/fixtures/cut_cases.json, also run by pipeline/_test_cuts.py), then the
 * film layout / runtime label built on it, and `clipRegionStartMs` (Trimmer clip nav and
 * Arrange's static playhead).
 */
import { readFileSync } from "node:fs";
import type { Clip } from "@/types/project";
import type { PlacedCard, TransitionConfig } from "@/utils/buildJobConfig";
import { cardDurMs, effectiveFilmMs, layoutFilm, resolveCuts, CARD_VISIBLE_MS, CARD_PLAIN_MS, XFADE_DUR_MS } from "./filmDuration";
import { buildSequence, clipRegionStartMs } from "./sequenceClock";

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

const tc = (over: Partial<TransitionConfig> = {}): TransitionConfig =>
  ({ between: "none", opening: "none", closing: "none", shuffleBetween: false, ...over });
const card = (id: string, beforeClipId: string | null): PlacedCard =>
  ({ id, text: id, subtitle: "", color: "#000000", animation: "none", beforeClipId });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// --- #284: the shared pipeline/renderer table -------------------------------
interface Case {
  name: string; fps: string; between: boolean; open: boolean; close: boolean;
  elements: (number | null)[];
  expect: { open: number | "full"; between: (number | "full")[]; close: number | "full" };
}
const table = JSON.parse(
  readFileSync(new URL("../../pipeline/fixtures/cut_cases.json", import.meta.url), "utf8"),
) as { cases: Case[] };
check("shared table is not empty", table.cases.length >= 19, String(table.cases.length));
for (const c of table.cases) {
  const [num, den] = c.fps.split("/");
  const fps = Number(num) / Number(den ?? 1);
  const ms = (v: number | "full") => (v === "full" ? XFADE_DUR_MS : (v * 1000) / fps);
  const p = resolveCuts(c.elements, c.between, c.open, c.close, fps);
  const got = [p.openMs, ...p.betweenMs, p.closeMs];
  const want = [ms(c.expect.open), ...c.expect.between.map(ms), ms(c.expect.close)];
  check(`shared table: ${c.name}`, got.length === want.length && got.every((g, i) => near(g, want[i])),
    `got=${got.map((v) => v.toFixed(2))} want=${want.map((v) => v.toFixed(2))}`);
}

// --- card length: its own two cuts (#190/#284) ------------------------------
check("no transition: card stays 3000ms", cardDurMs(0, 0, false) === CARD_PLAIN_MS);
check("interior card between long clips is 4500ms", cardDurMs(XFADE_DUR_MS, XFADE_DUR_MS, true) === 4500);
check("first card (one cut) is 3000ms", cardDurMs(0, XFADE_DUR_MS, true) === 3000);
check("card keeps the same visible time between unequal cuts",
  cardDurMs(400, XFADE_DUR_MS, true) - 400 - XFADE_DUR_MS === CARD_VISIBLE_MS);

// --- long clips: same timing as before #284 ---------------------------------
{
  const x = tc({ between: "crossfade" });
  check("all >= 4.5s: every cut 1500", layoutFilm(film, x, []).elements.slice(0, -1).every((e) => e.fadeOutMs === 1500));
  check("all >= 4.5s: runtime = naive - 3 x 1500", effectiveFilmMs(film, x, []) === 36_000 - 4_500);
  check("all >= 4.5s with opening card + open/close: 36000 + 4500 - 4 x 1500 + 200",
    effectiveFilmMs(film, tc({ between: "crossfade", opening: "crossfade", closing: "crossfade" }), [card("k", "a")])
      === 36_000 + 4_500 - 6_000 + 200);
}

// --- one short clip changes only its own two cuts ---------------------------
{
  const S = clip("s", 0, 2_302);
  const l = layoutFilm([A, S, C, D], tc({ between: "crossfade" }), []);
  const short = (17 * 1000 * 1001) / 30000;
  const outs = l.elements.map((e) => e.fadeOutMs);
  check("short clip: only the cuts beside it shorten",
    near(outs[0], short) && near(outs[1], short) && outs[2] === 1500 && outs[3] === 0, String(outs));
  check("short clip keeps >= half of itself", l.elements[1].nativeMs - 2 * short >= 2_302 / 2);
  check("runtime subtracts each cut's own length",
    near(effectiveFilmMs([A, S, C, D], tc({ between: "crossfade" }), []), 30_302 - 2 * short - 1500));
  const tiny = layoutFilm([A, clip("t", 0, 400), C], tc({ between: "crossfade" }), []);
  check("a 0.4s clip gets hard cuts", tiny.elements[0].fadeOutMs === 0 && tiny.elements[1].fadeOutMs === 0);
  const opened = layoutFilm([clip("f", 0, 300), C], tc({ opening: "dip_to_black" }), []);
  check("a 0.3s first clip drops the opening fade (no +100ms)",
    opened.openMs === 0 && effectiveFilmMs([clip("f", 0, 300), C], tc({ opening: "dip_to_black" }), []) === 12_300);
}

// --- clipRegionStartMs: card-region start, monotonic ------------------------
for (const t of [tc(), tc({ between: "crossfade" })]) {
  for (const cards of [[], [card("1", "b")], [card("0", "a"), card("1", "b"), card("3", "d")], [card("1", "b"), card("2", "b")]]) {
    const seq = buildSequence(film, t, cards);
    let prev = -Infinity;
    let ok = true;
    for (let i = 0; i < film.length; i++) {
      const at = clipRegionStartMs(seq, i);
      const first = seq.items.find((x) => x.filmStartMs === at);
      const anchored = cards.some((k) => k.beforeClipId === film[i].id);
      if (at < prev || !first || first.kind !== (anchored ? "card" : "clip")) ok = false;
      prev = at;
    }
    check(`clipRegionStartMs monotonic + enters on the card (${t.between}, ${cards.map((k) => k.id).join("")})`,
      ok && clipRegionStartMs(seq, 0) === 0);
  }
}

if (failed > 0) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall filmDuration helper invariants hold");
