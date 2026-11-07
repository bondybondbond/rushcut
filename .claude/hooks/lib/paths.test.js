"use strict";
// Tests for lib/paths.js (#216 Step 2). Run: node .claude/hooks/lib/paths.test.js
// Synthetic temp trees only (no real repo, no real user names, no network). Cases that need an OS
// capability (junction/symlink/hard-link creation, the \\localhost\X$ admin share) are SKIPPED WITH A
// PRINTED REASON, never silently passed; set RUSHCUT_PATHS_STRICT=1 to make any skip a failure (the
// maintainer's machine supports all of them, so strict mode is the release check).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  FROZEN_EXEMPT_FILES,
  CLASSIFY_BUDGET_MS,
  DEADLINE_MS,
  RETRY_ATTEMPTS,
  RETRY_DELAY_MS,
  isExemptRel,
  msysToWin,
  classifyTarget,
  classifyViaChild,
  decide,
  evaluateEditCall,
} = require("./paths");

if (process.platform !== "win32") {
  console.log("SKIP all: these tests exercise Windows path semantics");
  process.exit(0);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const skippedNames = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}\n  ${err.message}`);
  }
}
function skip(name, reason) {
  skipped++;
  skippedNames.push(name);
  console.log(`SKIP: ${name} -- ${reason}`);
}

// ---------------------------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------------------------
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "rushcut-paths-test-")));
const repo = path.join(base, "repo");
const outside = path.join(base, "outside");
const evil = path.join(base, "repo-evil");
for (const d of [
  repo,
  path.join(repo, "docs"),
  path.join(repo, "src", "components", "docs"),
  path.join(repo, ".claude", "skills", "a"),
  path.join(repo, ".claude", "skills.evil"),
  path.join(repo, ".claude", "hooks", "lib"),
  path.join(repo, ".claude", "rules"),
  path.join(repo, "a"),
  outside,
  evil,
]) {
  fs.mkdirSync(d, { recursive: true });
}
fs.writeFileSync(path.join(repo, "CLAUDE.md"), "x");
fs.writeFileSync(path.join(repo, "src", "CLAUDE.md"), "x");
fs.writeFileSync(path.join(repo, "a", ".gitignore"), "x");
fs.writeFileSync(path.join(repo, ".gitignore"), "x");
fs.writeFileSync(path.join(repo, "docs", "x.md"), "x");
const R = (...p) => path.join(repo, ...p);
const classify = (filePath, extra = {}) => classifyTarget({ filePath, cwd: repo, repoRoot: repo, ...extra });
const kindOf = (filePath, extra) => classify(filePath, extra).kind;

// Junctions need no privilege on Windows; a failure is reported as a skip.
function tryLink(target, linkPath, type = "junction") {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (e) {
    return false;
  }
}
const strict = process.env.RUSHCUT_PATHS_STRICT === "1";

// ---------------------------------------------------------------------------------------------
// Inside / outside / exemptions (real filesystem, synthetic tree)
// ---------------------------------------------------------------------------------------------
const CASES = [
  ["non-exempt source file that does not exist yet", R("src", "App.tsx"), "repo-protected"],
  ["deep nonexistent path", R("src", "x", "y", "z", "q.ts"), "repo-protected"],
  ["docs/x.md is exempt", R("docs", "x.md"), "repo-exempt"],
  ["a new file under docs/ is exempt", R("docs", "new", "deeper", "n.md"), "repo-exempt"],
  ["root CLAUDE.md is exempt", R("CLAUDE.md"), "repo-exempt"],
  ["root .gitignore is exempt", R(".gitignore"), "repo-exempt"],
  ["a frozen hook file is exempt", R(".claude", "hooks", "enforce-pp-plan-gates.js"), "repo-exempt"],
  ["the new lib/paths.js is exempt", R(".claude", "hooks", "lib", "paths.js"), "repo-exempt"],
  ["the new lib/paths.test.js is exempt", R(".claude", "hooks", "lib", "paths.test.js"), "repo-exempt"],
  [".claude/settings.json is exempt", R(".claude", "settings.json"), "repo-exempt"],
  [".claude/skills/a/SKILL.md is exempt", R(".claude", "skills", "a", "SKILL.md"), "repo-exempt"],
  ["src/CLAUDE.md is NOT exempt (nested look-alike)", R("src", "CLAUDE.md"), "repo-protected"],
  ["a/.gitignore is NOT exempt (nested look-alike)", R("a", ".gitignore"), "repo-protected"],
  ["src/components/docs/X.tsx is NOT exempt (substring look-alike)", R("src", "components", "docs", "X.tsx"), "repo-protected"],
  [".claude/skills.evil/x is NOT exempt (prefix look-alike)", R(".claude", "skills.evil", "x"), "repo-protected"],
  [".claude/rules/e2e.md is NOT exempt", R(".claude", "rules", "e2e.md"), "repo-protected"],
  ["the repo root itself is not exempt", repo, "repo-protected"],
  ["the docs directory itself is not an exempt FILE", R("docs"), "repo-protected"],
  ["a hook file NOT on the frozen list is protected", R(".claude", "hooks", "test-gate-hooks.js"), "repo-protected"],
  ["outside file", path.join(outside, "f.txt"), "outside"],
  ["SIBLING-PREFIX trap: repo-evil is outside repo", path.join(evil, "x.ts"), "outside"],
  ["`..` that stays inside (src/../docs/x.md) is exempt", R("src", "..", "docs", "x.md"), "repo-exempt"],
  ["`..` that leaves docs (docs/../src/x.ts) is protected", R("docs", "..", "src", "x.ts"), "repo-protected"],
  ["`..` that escapes the repo is outside", R("..", "outside", "x.txt"), "outside"],
  ["`..` through the sibling-prefix dir is outside", R("..", "repo-evil", "x.ts"), "outside"],
  ["mixed slashes", R("docs", "x.md").replace(/\\/g, "/"), "repo-exempt"],
  ["lower-case drive letter", R("docs", "x.md").replace(/^[A-Za-z]/, (c) => c.toLowerCase()), "repo-exempt"],
  ["UPPER-CASE path segments (case-insensitive file system)", R("DOCS", "x.md").toUpperCase().replace(/^[A-Za-z]:/, (m) => m), "repo-exempt"],
  ["device-namespace prefix \\\\?\\X:", "\\\\?\\" + R("docs", "x.md"), "repo-exempt"],
];
for (const [label, p, expected] of CASES) {
  test(`classify: ${label}`, () => {
    const r = classify(p);
    assert.strictEqual(r.kind, expected, JSON.stringify(r));
  });
}
test("classify: a relative path resolves against cwd", () => {
  assert.strictEqual(classifyTarget({ filePath: "docs\\x.md", cwd: repo, repoRoot: repo }).kind, "repo-exempt");
  assert.strictEqual(classifyTarget({ filePath: "src\\App.tsx", cwd: repo, repoRoot: repo }).kind, "repo-protected");
  assert.strictEqual(classifyTarget({ filePath: "..\\..\\outside\\f.txt", cwd: R("src"), repoRoot: repo }).kind, "outside");
  // a cwd INSIDE a sub-directory: the CPO-reported 'cwd=src-tauri' shape
  assert.strictEqual(classifyTarget({ filePath: "..\\docs\\x.md", cwd: R("src"), repoRoot: repo }).kind, "repo-exempt");
});
test("classify: an MSYS-form cwd (/c/...) is understood for relative paths", () => {
  const drive = repo[0].toLowerCase();
  const msysCwd = "/" + drive + repo.slice(2).replace(/\\/g, "/");
  assert.strictEqual(classifyTarget({ filePath: "docs/x.md", cwd: msysCwd, repoRoot: repo }).kind, "repo-exempt");
  assert.strictEqual(classifyTarget({ filePath: "src/App.tsx", cwd: msysCwd, repoRoot: repo }).kind, "repo-protected");
});
test("classify: Git-Bash /c/... and /mnt/c/... forms of a repo path are INSIDE (the Write tool accepts /c/...)", () => {
  const drive = repo[0].toLowerCase();
  const rest = repo.slice(2).replace(/\\/g, "/");
  assert.strictEqual(msysToWin("/" + drive + rest + "/docs/x.md"), repo[0].toUpperCase() + ":" + (rest + "/docs/x.md").replace(/\//g, "\\"));
  assert.strictEqual(kindOf("/" + drive + rest + "/src/App.tsx"), "repo-protected");
  assert.strictEqual(kindOf("/" + drive + rest + "/docs/x.md"), "repo-exempt");
  assert.strictEqual(kindOf("/mnt/" + drive + rest + "/src/App.tsx"), "repo-protected");
  assert.strictEqual(kindOf("/" + drive + rest.replace(/repo$/, "") + "outside/f.txt"), "outside");
});
test("classify: unresolvable inputs", () => {
  for (const [label, p, cwd] of [
    ["empty", "", repo],
    ["whitespace", "   ", repo],
    ["NUL", R("src", "a\0b.ts"), repo],
    ["relative without cwd", "src\\a.ts", undefined],
    ["undefined", undefined, repo],
    ["number", 42, repo],
    ["device path", "\\\\.\\pipe\\x", repo],
    ["wsl$", "\\\\wsl$\\Ubuntu\\home\\x", repo],
    ["wsl.localhost", "\\\\wsl.localhost\\Ubuntu\\mnt\\c\\x", repo],
    ["wsl.localhost with forward slashes", "//wsl.localhost/Ubuntu/mnt/c/x", repo],
    ["alternate data stream on a file", R("src", "a.ts:hidden"), repo],
    ["alternate data stream on a directory component", R("src::$INDEX_ALLOCATION", "a.ts"), repo],
    ["colon in a middle component", R("sr:c", "a.ts"), repo],
  ]) {
    const r = classifyTarget({ filePath: p, cwd, repoRoot: repo });
    assert.strictEqual(r.kind, "unresolvable", `${label}: ${JSON.stringify(r)}`);
    assert.ok(r.reason, `${label}: a reason is given`);
  }
});

// --- junctions / symlinks ---------------------------------------------------------------------
const linkOut = R("link-out");
const linkIn = path.join(outside, "link-in");
const evilDocs = R("docs", "evil");
const dangling = R("dangling");
const outsideDocsLink = path.join(outside, "to-docs");
const gone = path.join(base, "gone-target");
{
  fs.mkdirSync(path.join(outside, "target-dir"), { recursive: true });
  const okOut = tryLink(outside, linkOut);
  const okIn = tryLink(R("src"), linkIn);
  const okEvil = tryLink(R("src"), evilDocs);
  const okDocsLink = tryLink(R("docs"), outsideDocsLink);
  fs.mkdirSync(gone, { recursive: true });
  const okDangling = tryLink(gone, dangling);
  if (okDangling) fs.rmdirSync(gone);
  if (okOut) {
    test("classify: a junction INSIDE the repo pointing OUT is outside", () => {
      assert.strictEqual(kindOf(path.join(linkOut, "x.txt")), "outside");
    });
  } else skip("junction out of the repo", "junction creation failed");
  if (okIn) {
    test("classify: a junction OUTSIDE the repo pointing IN is inside (and gated)", () => {
      assert.strictEqual(kindOf(path.join(linkIn, "a.ts")), "repo-protected");
    });
  } else skip("junction into the repo", "junction creation failed");
  if (okEvil) {
    test("classify: docs/evil -> src junction is gated, NOT exempt (exemption is by canonical path)", () => {
      const r = classify(path.join(evilDocs, "a.ts"));
      assert.strictEqual(r.kind, "repo-protected", JSON.stringify(r));
    });
  } else skip("docs/evil junction", "junction creation failed");
  if (okDocsLink) {
    test("classify: a junction outside the repo to docs/ resolves to the canonical docs path and is exempt", () => {
      assert.strictEqual(kindOf(path.join(outsideDocsLink, "x.md")), "repo-exempt");
    });
  } else skip("junction to docs", "junction creation failed");
  if (okDangling) {
    test("classify: a dangling junction is unresolvable", () => {
      const r = classify(path.join(dangling, "x.txt"));
      assert.strictEqual(r.kind, "unresolvable", JSON.stringify(r));
    });
  } else skip("dangling junction", "junction creation failed");
  if (okOut) {
    test("classify: an inner junction OUT reached through a repo-prefixed path is outside (realpath chain, not the text chain)", () => {
      const viaDotDot = path.join(repo, "docs", "..", "link-out", "q.txt");
      assert.strictEqual(kindOf(viaDotDot), "outside");
    });
  }
}
test("classify: a hard link to a protected file placed in docs/ is NOT exempt", () => {
  const protectedFile = R("src", "protected.ts");
  fs.writeFileSync(protectedFile, "x");
  const hl = R("docs", "hardlinked.md");
  try {
    fs.linkSync(protectedFile, hl);
  } catch {
    skip("hard link in docs/", "hard link creation failed");
    return;
  }
  assert.strictEqual(kindOf(hl), "repo-protected");
  assert.strictEqual(kindOf(R("docs", "x.md")), "repo-exempt", "control: an ordinary docs file is still exempt");
});

// --- UNC admin-share alias (real) --------------------------------------------------------------
const drive = repo[0].toUpperCase();
const uncRepo = "\\\\localhost\\" + drive + "$" + repo.slice(2);
let uncAvailable = false;
try {
  fs.statSync(uncRepo);
  uncAvailable = true;
} catch {
  uncAvailable = false;
}
if (uncAvailable) {
  test("classify: the \\\\localhost\\X$ alias of a repo path is INSIDE and gated (identity, not text)", () => {
    assert.strictEqual(kindOf(uncRepo + "\\src\\App.tsx"), "repo-protected");
  });
  test("classify: the \\\\localhost\\X$ alias of docs/x.md is inside but NOT exempt (alias is not under the canonical root text)", () => {
    const r = classify(uncRepo + "\\docs\\x.md");
    assert.strictEqual(r.kind, "repo-protected", JSON.stringify(r));
    assert.strictEqual(r.canonicalRel, null);
  });
  if (fs.existsSync(linkOut)) {
    test("classify: UNC alias + an inner junction OUT is outside", () => {
      assert.strictEqual(kindOf(uncRepo + "\\link-out\\q.txt"), "outside");
    });
  }
  test("classify: UNC alias of the OUTSIDE tree is outside; the sibling-prefix dir via UNC is outside", () => {
    assert.strictEqual(kindOf("\\\\localhost\\" + drive + "$" + outside.slice(2) + "\\f.txt"), "outside");
    assert.strictEqual(kindOf("\\\\localhost\\" + drive + "$" + evil.slice(2) + "\\x.ts"), "outside");
  });
} else {
  skip("UNC admin-share alias (real)", "\\\\localhost\\" + drive + "$ is not reachable on this machine");
  if (strict) {
    test("STRICT: the UNC admin-share alias must be reachable on the maintainer's machine", () => assert.fail("not reachable"));
  }
}

// ---------------------------------------------------------------------------------------------
// Injected filesystem: the branches that need an alias or an OS state a test machine may lack
// ---------------------------------------------------------------------------------------------
function fakeFs({ ids = {}, real = {}, errors = {}, links = [] }) {
  const lc = (p) => String(p).toLowerCase();
  const idMap = new Map(Object.entries(ids).map(([k, v]) => [lc(k), v]));
  const errMap = new Map(Object.entries(errors).map(([k, v]) => [lc(k), v]));
  const realMap = new Map(Object.entries(real).map(([k, v]) => [lc(k), v]));
  const linkSet = new Set(links.map(lc));
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    stat(p) {
      if (errMap.has(lc(p))) throw err(errMap.get(lc(p)));
      if (idMap.has(lc(p))) {
        const [dev, ino] = idMap.get(lc(p)).split(":");
        return { dev: BigInt(dev), ino: BigInt(ino), nlink: 1n, isDirectory: () => true };
      }
      throw err("ENOENT");
    },
    lstat(p) {
      if (linkSet.has(lc(p))) return {};
      throw err("ENOENT");
    },
    realpath(p) {
      if (realMap.has(lc(p))) return realMap.get(lc(p));
      if (idMap.has(lc(p))) return p;
      throw err("ENOENT");
    },
  };
}
test("classify (injected fs): UNC text that differs from the canonical root but has the SAME identity is inside and NOT exempt", () => {
  const f = fakeFs({
    ids: { "C:\\fake\\repo": "1:100", "\\\\alias\\share\\fake\\repo": "1:100", "\\\\alias\\share\\fake\\repo\\src": "1:200", "\\\\alias\\share\\fake\\repo\\docs": "1:300", "C:\\fake": "1:1", "C:\\": "1:0" },
  });
  const a = classifyTarget({ filePath: "\\\\alias\\share\\fake\\repo\\src\\a.ts", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f });
  assert.strictEqual(a.kind, "repo-protected");
  assert.strictEqual(a.canonicalRel, null);
  const b = classifyTarget({ filePath: "\\\\alias\\share\\fake\\repo\\docs\\x.md", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f });
  assert.strictEqual(b.kind, "repo-protected", "docs via the alias must be gated, not exempt");
});
test("classify (injected fs): a non-ENOENT stat error (EPERM) on a path with no repo ancestor is OUTSIDE, not a universal deny", () => {
  const f = fakeFs({ ids: { "C:\\fake\\repo": "1:100", "C:\\other": "9:1", "C:\\": "1:0" }, errors: { "C:\\other\\locked\\f.txt": "EPERM", "C:\\other\\locked": "EPERM" } });
  const r = classifyTarget({ filePath: "C:\\other\\locked\\f.txt", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f });
  assert.strictEqual(r.kind, "outside", JSON.stringify(r));
});
test("classify (injected fs): a link loop (ELOOP) is unresolvable; a missing drive with no existing ancestor is outside", () => {
  const f = fakeFs({ ids: { "C:\\fake\\repo": "1:100", "C:\\": "1:0" }, errors: { "C:\\fake\\repo\\loop": "ELOOP" } });
  assert.strictEqual(classifyTarget({ filePath: "C:\\fake\\repo\\loop\\x", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f }).kind, "unresolvable");
  assert.strictEqual(classifyTarget({ filePath: "Z:\\nowhere\\x.txt", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f }).kind, "outside");
});
test("classify (injected fs): trailing-dot and 8.3 style names that the OS cannot open resolve to their existing ancestor and are outside/gated by that ancestor", () => {
  const f = fakeFs({ ids: { "C:\\fake\\repo": "1:100", "C:\\fake": "1:1", "C:\\": "1:0" } });
  assert.strictEqual(classifyTarget({ filePath: "C:\\fake\\repo.\\src\\x", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f }).kind, "outside");
  assert.strictEqual(classifyTarget({ filePath: "C:\\fake\\REPO~1\\src\\x", cwd: "C:\\", repoRoot: "C:\\fake\\repo", fs: f }).kind, "outside");
});

// ---------------------------------------------------------------------------------------------
// Exemption table
// ---------------------------------------------------------------------------------------------
test("isExemptRel: the frozen list is exactly the agreed twelve files", () => {
  assert.strictEqual(FROZEN_EXEMPT_FILES.length, 12);
  for (const f of FROZEN_EXEMPT_FILES) assert.ok(isExemptRel(f), f);
});
test("isExemptRel: prefixes need a whole segment and something below them", () => {
  assert.strictEqual(isExemptRel("docs/x.md"), true);
  assert.strictEqual(isExemptRel(".claude/skills/a/SKILL.md"), true);
  for (const p of ["docs", "docs/", "documents/x.md", "docs2/x.md", ".claude/skills", ".claude/skills.evil/x", "src/docs/x.md", "x/claude.md", "a/.gitignore", ".claude/rules/e2e.md", ""]) {
    assert.strictEqual(isExemptRel(p), false, JSON.stringify(p));
  }
});

// ---------------------------------------------------------------------------------------------
// decide(): the full table
// ---------------------------------------------------------------------------------------------
const S = (o) => ({ tool: "Edit", inlineFallback: false, transcript: "readable", devPlanActive: true, wrapupPassed: false, classification: null, gatesProven: false, pendingSpawn: false, deadlineExceeded: false, ...o });
const DECIDE_TABLE = [
  ["a non-gated tool is always allowed", S({ tool: "Bash" }), "allow", "not-gated-tool"],
  ["Write is gated like Edit", S({ tool: "Write", classification: "repo-protected" }), "deny", "gates-unproven"],
  ["NotebookEdit is not covered (documented)", S({ tool: "NotebookEdit", classification: "repo-protected" }), "allow", "not-gated-tool"],
  ["inline fallback allows before anything else", S({ inlineFallback: true, transcript: "unreadable" }), "allow", "inline-fallback"],
  ["readable transcript + no dev-plan: inert, no classification needed", S({ devPlanActive: false }), "allow", "inert-session"],
  ["readable transcript + wrapup passed: inert", S({ wrapupPassed: true }), "allow", "inert-session"],
  ["unreadable transcript is NEVER inert: classification is needed", S({ transcript: "unreadable", devPlanActive: false }), "need-classification", "needs-classification"],
  ["active dev-plan, classification not yet computed", S({}), "need-classification", "needs-classification"],
  ["outside -> allow", S({ classification: "outside" }), "allow", "outside"],
  ["outside -> allow even with an unreadable transcript", S({ classification: "outside", transcript: "unreadable" }), "allow", "outside"],
  ["repo-exempt -> allow even with an unreadable transcript", S({ classification: "repo-exempt", transcript: "unreadable" }), "allow", "repo-exempt"],
  ["protected + unreadable transcript -> deny (every session)", S({ classification: "repo-protected", transcript: "unreadable", devPlanActive: false }), "deny", "transcript-unreadable"],
  ["unresolvable + unreadable transcript -> deny", S({ classification: "unresolvable", transcript: "unreadable" }), "deny", "transcript-unreadable"],
  ["protected + gates proven -> allow", S({ classification: "repo-protected", gatesProven: true }), "allow", "gates-proven"],
  ["unresolvable + active dev-plan + gates proven -> ALLOW (a timeout is not an unconditional deny)", S({ classification: "unresolvable", gatesProven: true }), "allow", "gates-proven"],
  ["unresolvable + active dev-plan + gates unproven -> deny", S({ classification: "unresolvable" }), "deny", "gates-unproven"],
  ["unresolvable + no dev-plan + readable -> allow without classification", S({ classification: "unresolvable", devPlanActive: false }), "allow", "inert-session"],
  ["protected + unproven + pending spawn -> deny with the pending reason", S({ classification: "repo-protected", pendingSpawn: true }), "deny", "gates-unproven-pending-spawn"],
  ["deadline exceeded + protected -> deny even if gates would be proven", S({ classification: "repo-protected", gatesProven: true, deadlineExceeded: true }), "deny", "deadline"],
  ["deadline exceeded + outside -> still allow", S({ classification: "outside", deadlineExceeded: true }), "allow", "outside"],
  ["deadline exceeded + exempt -> still allow", S({ classification: "repo-exempt", deadlineExceeded: true }), "allow", "repo-exempt"],
];
for (const [label, state, action, reason] of DECIDE_TABLE) {
  test(`decide: ${label}`, () => {
    const d = decide(state);
    assert.deepStrictEqual({ action: d.action, reason: d.reason }, { action, reason });
  });
}

// ---------------------------------------------------------------------------------------------
// classifyViaChild: the hard budget, the validator, spawn failure
// ---------------------------------------------------------------------------------------------
test("classifyViaChild: the real child agrees with classifyTarget", () => {
  const a = classifyViaChild({ filePath: R("docs", "x.md"), cwd: repo, repoRoot: repo });
  assert.strictEqual(a.kind, "repo-exempt");
  const b = classifyViaChild({ filePath: R("src", "q.ts"), cwd: repo, repoRoot: repo });
  assert.strictEqual(b.kind, "repo-protected");
  const c = classifyViaChild({ filePath: path.join(outside, "f.txt"), cwd: repo, repoRoot: repo });
  assert.strictEqual(c.kind, "outside");
});
test("classifyViaChild: a slow child is killed at the budget and reported as unresolvable (no network involved)", () => {
  const t0 = Date.now();
  const r = classifyViaChild({ filePath: "x", cwd: repo, repoRoot: repo, budgetMs: 300, childArgs: ["-e", "setTimeout(function(){},8000)"] });
  const dt = Date.now() - t0;
  assert.strictEqual(r.kind, "unresolvable");
  assert.match(r.reason, /timed out/);
  assert.ok(dt < 3000, "returned at the budget, not after the child's 8 s: " + dt + " ms");
});
const CHILD_FAILURES = [
  ["exit 0 with empty stdout", ["-e", ""], /no valid output/],
  ["exit 0 with non-JSON stdout", ["-e", "process.stdout.write('hello')"], /no valid output/],
  ["exit 0 with a JSON object of the wrong schema", ["-e", "process.stdout.write(JSON.stringify({kind:'weird'}))"], /unexpected schema/],
  ["exit 0 with JSON null", ["-e", "process.stdout.write('null')"], /unexpected schema/],
  ["non-zero exit", ["-e", "process.exit(3)"], /failed \(status 3/],
];
for (const [label, childArgs, re] of CHILD_FAILURES) {
  test(`classifyViaChild: ${label} -> unresolvable`, () => {
    const r = classifyViaChild({ filePath: "x", cwd: repo, repoRoot: repo, childArgs });
    assert.strictEqual(r.kind, "unresolvable");
    assert.match(r.reason, re);
  });
}
test("classifyViaChild: spawn ENOENT, a signal, and a throwing spawn -> unresolvable", () => {
  assert.strictEqual(classifyViaChild({ filePath: "x", repoRoot: repo, spawn: () => ({ error: Object.assign(new Error("x"), { code: "ENOENT" }) }) }).kind, "unresolvable");
  assert.strictEqual(classifyViaChild({ filePath: "x", repoRoot: repo, spawn: () => ({ status: null, signal: "SIGKILL", stdout: "" }) }).kind, "unresolvable");
  assert.strictEqual(classifyViaChild({ filePath: "x", repoRoot: repo, spawn: () => { throw Object.assign(new Error("boom"), { code: "EPERM" }); } }).kind, "unresolvable");
});

// ---------------------------------------------------------------------------------------------
// evaluateEditCall: ordering, retry, subagents, deadline (all I/O injected; no wall clock)
// ---------------------------------------------------------------------------------------------
const SKILL_LINES_ACTIVE = ["A"]; // marker lines; the injected findLastMatchingSkillCall interprets them
function makeDeps(over = {}) {
  const log = { reads: [], retries: 0, sleeps: [], classifies: [], gateEvals: 0 };
  let clock = 0;
  const deps = {
    repoRoot: repo,
    now: () => clock,
    advance: (ms) => (clock += ms),
    parentTranscriptPath: (p) => (typeof p === "string" ? p.replace(/[\\/]subagents[\\/]agent-[A-Za-z0-9]+\.jsonl$/, ".jsonl") : p),
    readTranscriptLines: (p) => {
      log.reads.push(p);
      return deps._transcript(p);
    },
    readTranscriptWithRetry: ({ path: p, attempts, delayMs, sleep }) => {
      log.retries++;
      for (let i = 1; i <= attempts; i++) {
        const r = deps._transcript(p);
        if (r.ok) return { ...r, attempts: i };
        if (i < attempts) sleep(delayMs);
      }
      return { ok: false, code: "ENOENT", attempts };
    },
    findLastMatchingSkillCall: (lines, name) => lines.findIndex((l) => l === (name === "rushcut-dev-plan" ? "DEVPLAN" : "WRAPUP")),
    classify: (a) => {
      log.classifies.push(a);
      return deps._classification(a);
    },
    sleep: (ms) => {
      log.sleeps.push(ms);
      clock += ms;
    },
    evaluateGates: (lines, p, o) => {
      log.gateEvals++;
      return deps._gates(lines, p, o);
    },
    _transcript: () => ({ ok: true, lines: ["DEVPLAN"] }),
    _classification: () => ({ kind: "repo-protected" }),
    _gates: () => ({ proven: false, pending: 0, text: "BLOCKED (hook-enforced): gates missing" }),
    ...over,
  };
  return { deps, log };
}
const EDIT = (over = {}) => ({ tool_name: "Edit", tool_input: { file_path: R("src", "a.ts") }, transcript_path: path.join(base, "sess.jsonl"), cwd: repo, ...over });

test("evaluateEditCall: readable transcript with no dev-plan call -> allow and the classification child is NEVER spawned", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: true, lines: ["hello"] }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, r: r.reason, c: log.classifies.length, g: log.gateEvals }, { a: "allow", r: "inert-session", c: 0, g: 0 });
});
test("evaluateEditCall: wrapup already passed -> inert (no child)", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: true, lines: ["DEVPLAN", "WRAPUP"] }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, c: log.classifies.length }, { a: "allow", c: 0 });
});
test("evaluateEditCall: a readable transcript is read ONCE (no retry)", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: true, lines: ["hello"] }) });
  evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ reads: log.reads.length, retries: log.retries }, { reads: 1, retries: 0 });
});
test("evaluateEditCall: unreadable transcript, protected target -> deny after the bounded retry, in a session that never used dev-plan", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: false, code: "ENOENT" }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.strictEqual(r.action, "deny");
  assert.strictEqual(r.reason, "transcript-unreadable");
  assert.match(r.message, /could not be read/);
  assert.match(r.message, /restart the session|edit by hand/);
  assert.deepStrictEqual(log.sleeps, [RETRY_DELAY_MS, RETRY_DELAY_MS], "3 attempts => 2 sleeps of 150 ms");
});
test("evaluateEditCall: unreadable transcript with an EXEMPT or OUTSIDE target -> allow", () => {
  for (const kind of ["repo-exempt", "outside"]) {
    const { deps } = makeDeps({ _transcript: () => ({ ok: false, code: "EBUSY" }), _classification: () => ({ kind }) });
    assert.strictEqual(evaluateEditCall(EDIT(), deps).action, "allow", kind);
  }
});
test("evaluateEditCall: a MISSING transcript_path field is treated exactly like an unreadable transcript", () => {
  const { deps } = makeDeps({ _transcript: (p) => (p ? { ok: true, lines: ["DEVPLAN"] } : { ok: false, code: "NO_PATH" }) });
  const r = evaluateEditCall(EDIT({ transcript_path: undefined }), deps);
  assert.deepStrictEqual({ a: r.action, r: r.reason }, { a: "deny", r: "transcript-unreadable" });
});
test("evaluateEditCall: the transcript becoming readable during the retry proceeds normally", () => {
  let n = 0;
  const { deps } = makeDeps({ _transcript: () => (++n < 3 ? { ok: false, code: "ENOENT" } : { ok: true, lines: ["hello"] }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, r: r.reason }, { a: "allow", r: "inert-session" });
});
test("evaluateEditCall: classification timeout (unresolvable) + active dev-plan + UNPROVEN gates -> deny, naming the classification problem", () => {
  const { deps } = makeDeps({ _classification: () => ({ kind: "unresolvable", reason: "path classification timed out (slow or unreachable filesystem)" }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.strictEqual(r.action, "deny");
  assert.match(r.message, /gates missing/);
  assert.match(r.message, /could not be classified/);
});
test("evaluateEditCall: classification timeout + active dev-plan + PROVEN gates -> ALLOW", () => {
  const { deps } = makeDeps({ _classification: () => ({ kind: "unresolvable", reason: "timed out" }), _gates: () => ({ proven: true, pending: 0, text: "" }) });
  assert.strictEqual(evaluateEditCall(EDIT(), deps).action, "allow");
});
test("evaluateEditCall: classification timeout on docs/x.md during an unproven dev-plan -> DENY (docs is not exempt while classification is down)", () => {
  const { deps } = makeDeps({ _classification: () => ({ kind: "unresolvable", reason: "timed out" }) });
  const r = evaluateEditCall(EDIT({ tool_input: { file_path: R("docs", "x.md") } }), deps);
  assert.strictEqual(r.action, "deny");
});
test("evaluateEditCall: outside and exempt targets pass with an active, unproven dev-plan", () => {
  for (const kind of ["outside", "repo-exempt"]) {
    const { deps, log } = makeDeps({ _classification: () => ({ kind }) });
    assert.strictEqual(evaluateEditCall(EDIT(), deps).action, "allow", kind);
    assert.strictEqual(log.gateEvals, 0, "the gates are not even evaluated");
  }
});
test("evaluateEditCall: the self-deadline (injected clock) denies a protected edit even if gates would be proven", () => {
  const { deps } = makeDeps({ _gates: () => ({ proven: true, pending: 0, text: "" }) });
  deps._classification = () => {
    deps.advance(DEADLINE_MS + 1);
    return { kind: "repo-protected" };
  };
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, r: r.reason }, { a: "deny", r: "deadline" });
  assert.match(r.message, /hook deadline exceeded/);
});
test("evaluateEditCall: the deadline never blocks outside/exempt targets", () => {
  const { deps } = makeDeps({});
  deps._classification = () => {
    deps.advance(DEADLINE_MS + 1);
    return { kind: "outside" };
  };
  assert.strictEqual(evaluateEditCall(EDIT(), deps).action, "allow");
});
test("evaluateEditCall: a pending (no visible completion) spawn gets a bounded re-read and then passes if the completion appears", () => {
  let evals = 0;
  const { deps, log } = makeDeps({ _gates: () => (++evals < 3 ? { proven: false, pending: 1, text: "gates missing; spawn has no visible completion yet" } : { proven: true, pending: 0, text: "" }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, sleeps: log.sleeps.length }, { a: "allow", sleeps: 2 });
});
test("evaluateEditCall: a pending spawn that never completes denies with the pending reason after at most 3 polls", () => {
  const { deps, log } = makeDeps({ _gates: () => ({ proven: false, pending: 2, text: "BLOCKED (hook-enforced): spawn has no visible completion yet" }) });
  const r = evaluateEditCall(EDIT(), deps);
  assert.deepStrictEqual({ a: r.action, r: r.reason }, { a: "deny", r: "gates-unproven-pending-spawn" });
  assert.ok(log.sleeps.length <= RETRY_ATTEMPTS);
});
test("evaluateEditCall: unproven gates with NO pending spawn do not poll (no wasted latency)", () => {
  const { deps, log } = makeDeps({});
  evaluateEditCall(EDIT(), deps);
  assert.strictEqual(log.sleeps.length, 0);
});
test("evaluateEditCall: a hook call from inside a SUBAGENT whose transcript_path is the agent file reads the PARENT session transcript", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: true, lines: ["hello"] }) });
  evaluateEditCall(EDIT({ transcript_path: path.join(base, "projects", "sess1", "subagents", "agent-abc123.jsonl"), agent_id: "abc123" }), deps);
  assert.deepStrictEqual(log.reads, [path.join(base, "projects", "sess1.jsonl")]);
});
test("evaluateEditCall: the agent-file shape is mapped to the parent even when agent_id is ABSENT (no bypass)", () => {
  const { deps, log } = makeDeps({ _transcript: () => ({ ok: true, lines: ["hello"] }) });
  evaluateEditCall(EDIT({ transcript_path: path.join(base, "projects", "sess1", "subagents", "agent-abc123.jsonl") }), deps);
  assert.deepStrictEqual(log.reads, [path.join(base, "projects", "sess1.jsonl")]);
});
test("evaluateEditCall: denial text for a subagent call says to return to the orchestrating session", () => {
  const { deps } = makeDeps({ _transcript: () => ({ ok: false, code: "ENOENT" }) });
  const r = evaluateEditCall(EDIT({ agent_id: "abc123" }), deps);
  assert.match(r.message, /Return to the orchestrating session/);
});
test("evaluateEditCall: non-Edit/Write tools are ignored (documented coverage: Edit and Write only)", () => {
  for (const tool of ["Bash", "PowerShell", "NotebookEdit", "MultiEdit", "Read"]) {
    const { deps, log } = makeDeps({});
    assert.strictEqual(evaluateEditCall({ tool_name: tool, tool_input: { file_path: R("src", "a.ts") } }, deps).action, "allow", tool);
    assert.strictEqual(log.reads.length, 0);
  }
});
test("constants: retry sleeps + classification budget + a start-up allowance fit under the self-deadline, which is under the 5 s registered timeout", () => {
  assert.strictEqual(RETRY_ATTEMPTS, 3);
  assert.strictEqual(RETRY_DELAY_MS, 150);
  assert.strictEqual(CLASSIFY_BUDGET_MS, 1500);
  assert.strictEqual(DEADLINE_MS, 3500);
  assert.ok((RETRY_ATTEMPTS - 1) * RETRY_DELAY_MS + CLASSIFY_BUDGET_MS + 100 < DEADLINE_MS);
  assert.ok(DEADLINE_MS < 5000);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped${skipped ? " (" + skippedNames.join("; ") + ")" : ""}`);
try {
  fs.rmSync(base, { recursive: true, force: true });
} catch {
  /* junction targets are inside base; best effort */
}
if (strict && skipped > 0) {
  console.log("STRICT: skipped tests are failures");
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
