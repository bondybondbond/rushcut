#!/usr/bin/env node
// Regression test for lib/secret-guard.js's forbiddenHits() matcher. No CI runs this
// automatically (this project has no .github/workflows) -- run manually after touching
// secret-guard.js or guard-secret-commit.js:
//   node .claude/hooks/test-secret-guard.js

const assert = require("assert");
const { forbiddenHits } = require("./lib/secret-guard");

const CASES = [
  // [path, expectFlagged]
  [".env", true],
  [".env.local", true],
  ["spike/tmp/scratch.py", true],
  ["spike/output_v2.mp4", true],
  ["C:\\clips\\raw.mp4", true],
  ["notes/credentials-backup.json", true],
  ["keys/rushcut-private-key.pem", true],
  ["src/components/Foo.tsx", false],
  ["docs/DESIGN.md", false],
  ["pipeline/render.py", false],
  [".env.example", true], // matches .env(.[\w.-]+)? -- intentional: err toward blocking, unstage manually if wanted
];

let failures = 0;
for (const [path, expectFlagged] of CASES) {
  const hits = forbiddenHits([path]);
  const flagged = hits.length > 0;
  try {
    assert.strictEqual(flagged, expectFlagged, `${path}: expected flagged=${expectFlagged}, got ${flagged}`);
    console.log(`PASS  ${path} (flagged=${flagged})`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures}/${CASES.length} cases failed`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} cases passed`);
