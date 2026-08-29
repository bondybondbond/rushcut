/**
 * Standalone self-test for #184's `orderedCardRuns` -- THE single resolver for
 * card order/count per anchor. No unit-test runner exists in this project
 * (E2E-only, see package.json) -- run directly:
 *
 *   pnpm exec tsx src/utils/orderedCardRuns.selftest.ts
 *
 * Exit 0 = all invariants hold, exit 1 = a failure (prints which). Mirrors the
 * sibling `sequenceClock.selftest.ts` / `filmDuration.selftest.ts` convention.
 *
 * Covers the Gate 3 #3 matrix: N=0, N=1, N=2 at null (end), N=2 at one non-null
 * anchor, multiple interleaved anchors, empty inFilm, delete-one-of-many, plus
 * the "NEVER sort the run" and orphaned-anchor->end invariants.
 */
import { orderedCardRuns, type PlacedCard } from "./buildJobConfig";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed++;
    console.log(`  FAIL- ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}
function card(id: string, beforeClipId: string | null): PlacedCard {
  return { id, text: id, subtitle: "", color: "#000000", animation: "none", beforeClipId };
}
const ids = (arr: { id: string }[]) => arr.map((c) => c.id).join(",");

// N=0
{
  const r = orderedCardRuns([], ["a", "b"]);
  check("N=0: before empty", r.before.size === 0);
  check("N=0: end empty", r.end.length === 0);
}

// N=1 before a clip
{
  const r = orderedCardRuns([card("c1", "b")], ["a", "b"]);
  check("N=1 before: run for b", ids(r.before.get("b") ?? []) === "c1");
  check("N=1 before: end empty", r.end.length === 0);
}

// N=1 at end (null)
{
  const r = orderedCardRuns([card("c1", null)], ["a", "b"]);
  check("N=1 end: end has c1", ids(r.end) === "c1");
  check("N=1 end: before empty", r.before.size === 0);
}

// N=2 at end -- persisted order preserved, NOT sorted
{
  const r = orderedCardRuns([card("z", null), card("a", null)], ["a", "b"]);
  check("N=2 end: persisted order z,a (no sort)", ids(r.end) === "z,a", ids(r.end));
}

// N=2 at one non-null anchor -- persisted order
{
  const r = orderedCardRuns([card("c2", "b"), card("c1", "b")], ["a", "b"]);
  check("N=2 same anchor: order c2,c1", ids(r.before.get("b") ?? []) === "c2,c1");
}

// Multiple interleaved anchors -- each run independent, global order kept
{
  const cards = [card("x1", "a"), card("e1", null), card("x2", "a"), card("y1", "b"), card("e2", null)];
  const r = orderedCardRuns(cards, ["a", "b"]);
  check("interleaved: run a = x1,x2", ids(r.before.get("a") ?? []) === "x1,x2");
  check("interleaved: run b = y1", ids(r.before.get("b") ?? []) === "y1");
  check("interleaved: end = e1,e2", ids(r.end) === "e1,e2");
}

// Empty inFilm -- everything falls to end (no valid anchors)
{
  const r = orderedCardRuns([card("c1", "a"), card("c2", null)], []);
  check("empty inFilm: all to end, order kept", ids(r.end) === "c1,c2");
  check("empty inFilm: before empty", r.before.size === 0);
}

// Orphaned anchor (clip deleted) -> end, keeping global order
{
  const r = orderedCardRuns([card("g", "gone"), card("h", "b")], ["a", "b"]);
  check("orphan anchor -> end", ids(r.end) === "g");
  check("orphan: valid anchor still bucketed", ids(r.before.get("b") ?? []) === "h");
}

// delete-one-of-many: removing the FIRST of two at an anchor leaves the second in place
{
  const before = [card("k1", "b"), card("k2", "b")];
  const afterDelete = before.filter((c) => c.id !== "k1");
  const r = orderedCardRuns(afterDelete, ["a", "b"]);
  check("delete first of two: k2 remains, alone", ids(r.before.get("b") ?? []) === "k2");
}

// total count invariant: every input card lands in exactly one bucket
{
  const cards = [card("a1", "a"), card("a2", "a"), card("n1", null), card("orph", "x")];
  const r = orderedCardRuns(cards, ["a", "b"]);
  const total = [...r.before.values()].reduce((s, run) => s + run.length, 0) + r.end.length;
  check("count invariant: sum of runs == input length", total === cards.length, `${total} != ${cards.length}`);
}

if (failed > 0) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall orderedCardRuns invariants hold");
