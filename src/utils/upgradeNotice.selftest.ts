/**
 * Self-test for upgradeNotice.ts (#236). Run: pnpm exec tsx src/utils/upgradeNotice.selftest.ts
 * Exit 0 = ok, 1 = failure.
 */
import { upgradeNoticeText } from "./upgradeNotice";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

check("empty list shows nothing", upgradeNoticeText([]) === null);
// CPO wrap-readiness: when EVERY clip is listed there is no "rest of the film" to compare with.
check("no comparison to the rest of the film", !/rest of your film/.test(upgradeNoticeText(["a"])!));
const one = upgradeNoticeText(["DJI_0012"])!;
check("one clip is singular and named", one.startsWith("1 clip will") && one.includes("DJI_0012") && one.includes("prepare it fully"), one);
const three = upgradeNoticeText(["a", "b", "c"])!;
check("three clips named, no 'more'", three.includes("a, b, c") && !three.includes("more"), three);
const five = upgradeNoticeText(["a", "b", "c", "d", "e"])!;
check("five clips: three named + 'and 2 more'", five.includes("a, b, c and 2 more") && five.startsWith("5 clips will"), five);
for (const t of [one, three, five]) {
  check("no technical words", !/proxy|encod|upgrad|working copy|2160|QP|low-disk/i.test(t), t);
  check("says rendering still works", t.includes("You can still render now"));
}
process.exit(failed ? 1 : 0);
