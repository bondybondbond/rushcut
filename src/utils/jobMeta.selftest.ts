/**
 * Standalone self-test for `formatFileSize` (#145). Run directly:
 *
 *   pnpm exec tsx src/utils/jobMeta.selftest.ts
 *
 * Exit 0 = all hold, exit 1 = a failure (prints which).
 */
import { formatFileSize } from "./jobMeta";

let failed = 0;
function eq(bytes: number, want: string) {
  const got = formatFileSize(bytes);
  if (got === want) console.log(`ok   ${bytes} -> ${got}`);
  else {
    failed++;
    console.log(`FAIL ${bytes} -> ${got} (want ${want})`);
  }
}

// #145: small outputs never read "0 MB"
eq(0, "0 KB");
eq(350_000, "350 KB");
eq(499_999, "500 KB");
eq(850_000, "850 KB");
eq(999_499, "999 KB");
// cutover lands on "1 MB", never "1000 KB"
eq(999_500, "1 MB");
eq(999_999, "1 MB");
// unchanged behaviour
eq(1_000_000, "1 MB");
eq(1_200_000, "1 MB");
eq(48_400_000, "48 MB");
eq(999_000_000, "999 MB");
eq(1_000_000_000, "1.0 GB");
eq(2_345_000_000, "2.3 GB");

if (failed) {
  console.log(`${failed} failure(s)`);
  process.exit(1);
}
console.log("all ok");
