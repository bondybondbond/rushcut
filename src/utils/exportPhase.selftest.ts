/**
 * Standalone self-test for exportPhase.ts (#267). Run:  pnpm exec tsx src/utils/exportPhase.selftest.ts
 * Exit 0 = all hold, 1 = a failure.
 */
import { phaseOf } from "./exportPhase";

let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${name}`); else { failed++; console.log(`  FAIL- ${name}`); }
}

// Every stage string pipeline/render.py sends.
check("Preparing clips -> Prepare", phaseOf("Preparing clips") === 0);
check("Preparing clips with detail -> Prepare", phaseOf("Preparing clips... | 3 of 12 done - Encoded clip 3 of 12") === 0);
check("Trimming clips with detail -> Prepare", phaseOf("Trimming clips... | 0 of 12 done - Started clip 4 of 12") === 0);
check("zoom -> Process", phaseOf("zoom") === 1);
check("cards -> Process", phaseOf("cards") === 1);
check("Rendering -> Process", phaseOf("Rendering") === 1);
check("Mixing music -> Finish", phaseOf("Mixing music") === 2);
// Negative cases: must NOT move the bar.
check("unknown stage -> null", phaseOf("Something new") === null);
check("empty stage -> null", phaseOf("") === null);
check("a detail that merely mentions a stage word does not match", phaseOf("Something new | Rendering") === null);
// Monotonic fold used by the screen, over the cache-hit sequence (no Process stage at all).
const fold = (stages: string[]) => stages.reduce((cur, s) => { const p = phaseOf(s); return p == null ? cur : Math.max(cur, p); }, -1);
check("cache hit: Preparing clips then Mixing music ends at Finish", fold(["Preparing clips", "Mixing music"]) === 2);
check("nothing seen yet stays -1", fold([]) === -1);
check("an unknown stage after Process does not reset it", fold(["Rendering", "Something new"]) === 1);
check("a late Prepare-looking stage never moves it back", fold(["Rendering", "Trimming clips..."]) === 1);

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all exportPhase checks passed");
