#!/usr/bin/env node
// #226 fixtures for the kit invariant hooks, run THROUGH the RushCut adapter. Offline, safe: any git state lives in a
// throwaway temp repo that the hook is pointed at via CLAUDE_PROJECT_DIR; nothing touches the real repo.
// Output: PASS/FAIL for behaviour we promise; KNOWN-LIMIT lines document what the kit hooks do NOT catch (reported, never patched).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const HOOKS = __dirname;
// These hooks are LOCAL-ONLY dev tooling (see CLAUDE.md "Invariant hooks"): on a clone that does not have them there is nothing to test.
// Nothing installed => SKIP (a clone without the local hooks). Partly installed => FAIL loudly, so a half-installed setup is never mistaken for a pass or a misleading failure.
const REQUIRED = ["kit-ps-adapter.cjs", "no-secret-commit.cjs", "dangerous-git.cjs", "protected-path-write.cjs", "protected-paths.txt", "secret-patterns.json"];
const MISSING = REQUIRED.filter((f) => !fs.existsSync(path.join(HOOKS, f)));
if (MISSING.length === REQUIRED.length) {
  console.log("SKIP  kit hooks are not installed in this checkout (local-only); nothing to verify");
  process.exit(0);
}
if (MISSING.length) {
  console.log("FAIL  partial install of the kit hooks, missing: " + MISSING.join(", "));
  process.exit(1);
}
// A literal AWS-style key in this tracked file would make the secret hook block committing it, so the fake key is assembled at runtime.
const FAKE_AWS_KEY = "AKI" + "AIOSFODNN7EXAMPLE";
const REPO = path.resolve(HOOKS, "..", "..");
const ADAPTER = path.join(HOOKS, "kit-ps-adapter.cjs");
let failed = 0;

function run(hookFile, payload, env = {}, viaAdapter = true, cwd) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const e = { ...process.env, ...env };
  if (env.CLAUDE_PROJECT_DIR === null) delete e.CLAUDE_PROJECT_DIR;
  const args = viaAdapter ? [ADAPTER, hookFile] : [path.join(HOOKS, hookFile)];
  const r = spawnSync(process.execPath, args, { input, env: e, encoding: "utf8", cwd });
  return { code: r.status, err: r.stderr || "" };
}
function check(name, got, wantBlock) {
  const blocked = got.code === 2;
  const ok = blocked === wantBlock;
  if (!ok) failed++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : ` (wanted ${wantBlock ? "block" : "allow"}, got exit ${got.code})`));
}
function limit(name, got, wantBlock) {
  const blocked = got.code === 2;
  if (wantBlock !== blocked) failed++; // a documented limit that drifts is a failure: re-read the plan
  console.log(`KNOWN-LIMIT  ${name}: ${blocked ? "BLOCKED" : "not blocked"} (${wantBlock === blocked ? "as documented" : "DIFFERS from documented behaviour -- re-read the plan"})`);
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
const ps = (command) => ({ tool_name: "PowerShell", tool_input: { command } });

// ---- dangerous-git
console.log("== dangerous-git");
const DG = "dangerous-git.cjs";
for (const [label, mk] of [["Bash", bash], ["PowerShell", ps]]) {
  check(`${label}: force push to main blocked`, run(DG, mk("git push --force origin main")), true);
  check(`${label}: -f push blocked`, run(DG, mk("git push -f origin feature")), true);
  check(`${label}: reset --hard blocked`, run(DG, mk("git reset --hard HEAD")), true);
  check(`${label}: filter-repo blocked`, run(DG, mk("git filter-repo --path x")), true);
  check(`${label}: ordinary push allowed`, run(DG, mk("git push origin main")), false);
  check(`${label}: status allowed`, run(DG, mk("git status")), false);
}
check("PowerShell syntax: 'cd x; git push --force origin main' blocked", run(DG, ps("cd C:/tmp/x; git push --force origin main")), true);
check("force-with-lease to non-default branch allowed", run(DG, bash("git push --force-with-lease origin feature")), false);
limit("phrase in text (issue body mentioning the destructive command)", run(DG, bash('gh issue comment 1 --body "never run git reset --hard here"')), true);
limit("a normal commit whose MESSAGE mentions a destructive command is BLOCKED (accepted friction, decision G: keep such text in a file or reword)", run(DG, bash('git ' + 'commit -m "docs: explain why git reset --hard is blocked"')), true);
limit("git -C dir push --force is NOT caught by the kit regex (documented)", run(DG, bash("git -C x push --force origin main")), false);
limit("ORDINARY refspec push 'git push origin HEAD:main' is BLOCKED by the kit regex (reviewer finding 2: a false block; owner uses 'git push origin main')", run(DG, bash("git push origin HEAD:main")), true);
limit("text 'Pushed: main' after a push is BLOCKED by the kit regex (false block)", run(DG, ps('git push origin main; Write-Host "Pushed: main"')), true);
limit("git clean -df",run(DG, bash("git clean -df")), false);
limit("+main refspec force push", run(DG, bash("git push origin +main")), false);
limit("single git branch -D x", run(DG, bash("git branch -D x")), false);
limit("delete remote branch git push origin :feature", run(DG, bash("git push origin :feature")), false);
limit("git checkout -- .", run(DG, bash("git checkout -- .")), false);
limit("git.exe push --force origin main", run(DG, bash("git.exe push --force origin main")), false);
limit("git -C dir reset --hard", run(DG, bash("git -C x reset --hard")), false);
limit("malformed stdin (K1: kit exits 0)", run(DG, "not json"), false);
check("non-shell tool (recovery tools) never blocked", run(DG, { tool_name: "TaskStop", tool_input: {} }), false);
check("ToolSearch never blocked", run(DG, { tool_name: "ToolSearch", tool_input: { query: "git reset --hard" } }), false);

// ---- no-secret-commit, with a throwaway repo as the project dir
console.log("== no-secret-commit");
const SC = "no-secret-commit.cjs";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rushcut-probe226-"));
const g = (...a) => execFileSync("git", a, { cwd: tmp, encoding: "utf8" });
g("init", "-q"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t");
fs.writeFileSync(path.join(tmp, "seed.txt"), "seed\n"); g("add", "."); g("commit", "-q", "-m", "seed");
// the kit hook reads secret-patterns.json from the PROJECT dir, so give the throwaway repo the real file (untracked, never staged)
fs.mkdirSync(path.join(tmp, ".claude", "hooks"), { recursive: true });
fs.copyFileSync(path.join(HOOKS, "secret-patterns.json"), path.join(tmp, ".claude", "hooks", "secret-patterns.json"));
const env = { CLAUDE_PROJECT_DIR: tmp, RUSHCUT_KIT_PROJECT_DIR_OVERRIDE: tmp };
const COMMIT = 'git ' + 'commit -m "x"';
function stage(rel, content) { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), content); g("add", "-f", "--", rel); }
function unstageAll() { g("reset", "-q"); for (const f of fs.readdirSync(tmp)) if (f !== ".git" && f !== "seed.txt" && f !== ".claude") fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); }

check("message containing an AWS-style key blocked (Bash)", run(SC, bash('git ' + 'commit -m "' + FAKE_AWS_KEY + '"'), env), true);
check("message containing an AWS-style key blocked (PowerShell tool)", run(SC, ps('git ' + 'commit -m "' + FAKE_AWS_KEY + '"'), env), true);
check("clean staged file, clean message allowed", (() => { stage("docs/ok.md", "hello\n"); return run(SC, bash(COMMIT), env); })(), false);
check("clean staged file, clean message allowed (PowerShell tool variant)", (() => { stage("docs/ok2.md", "hello\n"); return run(SC, ps(COMMIT), env); })(), false);
unstageAll();
const GHP ="ghp_" + "a".repeat(36);
stage("src/a.ts", "const t = '" + GHP + "';\n");
check("staged GitHub token in content blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage(".env", "X=1\n");
check("staged .env blocked (migrated filename pattern)", run(SC, ps(COMMIT), env), true);
unstageAll();
stage(".env.local", "X=1\n");
check("staged .env.local blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage(".env.example", "X=\n");
check("staged .env.example allowed (deliberate narrowing vs old guard)", run(SC, bash(COMMIT), env), false);
unstageAll();
stage("config/credentials.json", "{}\n");
check("staged credentials.json blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage("keys/server.pem", "x\n");
check("staged .pem blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage("docs/note.md", "this prose mentions a credential and C:/clips and .env but stages no such file\n");
check("prose mentioning credential/.env allowed (anchored patterns, negative fixture)", run(SC, bash(COMMIT), env), false);
unstageAll();
// reviewer finding 1: shapes that have NO +++ header line (the old --name-only guard saw them). Patterns anchor on `diff --git ... b/<path>`.
stage(".env", "");
check("EMPTY new .env blocked (no +++ line exists)", run(SC, bash(COMMIT), env), true);
unstageAll();
stage("keys/credentials.der", Buffer.from([0, 1, 2, 0, 255, 0]));
check("BINARY credentials.der blocked (no +++ line exists)", run(SC, bash(COMMIT), env), true);
unstageAll();
fs.writeFileSync(path.join(tmp, "notes.txt"), "hello rename\n"); g("add", "notes.txt"); g("commit", "-q", "--no-verify", "-m", "notes");
g("mv", "notes.txt", ".env");
check("pure RENAME to .env blocked", run(SC, bash(COMMIT), env), true);
g("reset", "-q", "--hard");
stage("docs/\u00e9credential.txt", "x\n");
check("unicode/quoted-name credential file blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage("spike/tmp/a.txt", "x\n");
check("staged spike/tmp blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
stage("case/CREDENTIAL.txt", "x\n");
check("case-variant CREDENTIAL.txt blocked", run(SC, bash(COMMIT), env), true);
unstageAll();
// K5 scrub commit: a removed line that contains a token is still matched
fs.writeFileSync(path.join(tmp, "leak.txt"), "k=" + GHP + "\n"); g("add", "leak.txt"); g("commit", "-q", "--no-verify", "-m", "add");
fs.writeFileSync(path.join(tmp, "leak.txt"), "k=REMOVED\n"); g("add", "leak.txt");
limit("K5 scrub commit (removal diff still contains the old token)", run(SC, bash(COMMIT), env), true);
unstageAll(); g("reset", "-q", "--hard");
limit("CASE: 'GIT commit' with a fake key in the message is NOT scanned (kit detects the command case-sensitively; the retired guard and Gate 4 were case-insensitive). Documented limit, upstream report, not patched here.", run(SC, bash('GIT ' + 'commit -m "' + FAKE_AWS_KEY + '"'), env), false);
limit("K4 -F file message (not scanned)", run(SC, bash('git ' + 'commit -F msg.txt'), env), false);
limit("phrase in text with no secret (e.g. issue body) is scanned but allowed", run(SC, bash('gh issue comment 1 --body "run git ' + 'commit -m done"'), env), false);
check("non-shell tool never blocked", run(SC, { tool_name: "TaskStop", tool_input: {} }, env), false);
limit("malformed stdin (K1: kit exits 0)", run(SC, "", env), false);
fs.rmSync(tmp, { recursive: true, force: true });

// ---- protected-path-write against the REAL list, evaluating paths only (nothing is written)
console.log("== protected-path-write");
const PP = "protected-path-write.cjs";
const P = (f, tool = "Write") => ({ tool_name: tool, tool_input: { file_path: f } });
const penv = { CLAUDE_PROJECT_DIR: REPO };
check("write into lambda/ blocked", run(PP, P(path.join(REPO, "lambda", "x.py")), penv), true);
check("edit into docs/archive/ blocked", run(PP, P(path.join(REPO, "docs", "archive", "a.md"), "Edit"), penv), true);
check("MultiEdit into lambda/ blocked", run(PP, P(path.join(REPO, "lambda", "y.py"), "MultiEdit"), penv), true);
check("src/ edit allowed", run(PP, P(path.join(REPO, "src", "a.ts")), penv), false);
check("docs/DESIGN.md allowed", run(PP, P(path.join(REPO, "docs", "DESIGN.md")), penv), false);
check("backslash path into lambda/ blocked", run(PP, P(REPO.replace(/\//g, "\\") + "\\lambda\\z.py"), penv), true);
check("'..' segment resolving into lambda/ blocked", run(PP, P(path.join(REPO, "src", "..", "lambda", "q.py")), penv), true);
check("adapter defaults CLAUDE_PROJECT_DIR when unset (non-root cwd)", run(PP, P(path.join(REPO, "lambda", "x.py")), { CLAUDE_PROJECT_DIR: null }, true, path.join(REPO, "src")), true);
limit("K2: kit hook run DIRECTLY with CLAUDE_PROJECT_DIR unset and non-root cwd silently no-ops", run(PP, P("lambda/x.py"), { CLAUDE_PROJECT_DIR: null }, false, path.join(REPO, "src")), false);
limit("case variant LAMBDA/x", run(PP, P(path.join(REPO, "LAMBDA", "x.py")), penv), false);
check("SET-BUT-WRONG CLAUDE_PROJECT_DIR (a subfolder) is overridden by the adapter: lambda/ still blocked", run(PP, P(path.join(REPO, "lambda", "x.py")), { CLAUDE_PROJECT_DIR: path.join(REPO, "src") }), true);
check("non-edit tool never blocked", run(PP, { tool_name: "TaskStop", tool_input: {} }, penv), false);
limit("malformed stdin (K1: kit exits 0)", run(PP, "{", penv), false);

// ---- recovery tools (cancel / inspect / recover) must never be touched by any kit hook; also the kit files stay byte-identical
console.log("== recovery tools and kit-file integrity");
for (const hook of ["no-secret-commit.cjs", "dangerous-git.cjs", "protected-path-write.cjs"]) {
  for (const tool of ["TaskStop", "ToolSearch", "ListAgents", "AskUserQuestion", "Skill"]) {
    check(`${hook} never blocks recovery tool ${tool}`, run(hook, { tool_name: tool, tool_input: { skill: "rushcut-dev-plan", query: "git reset --hard" } }, { CLAUDE_PROJECT_DIR: REPO }), false);
  }
  const KIT_DIR = "C:/apps/ai-dev-kit/adapters/claude-code/hooks";
  if (fs.existsSync(path.join(KIT_DIR, hook))) {
    const h = (f) => require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    check(`${hook} is byte-identical to the kit copy`, { code: h(path.join(HOOKS, hook)) === h(path.join(KIT_DIR, hook)) ? 0 : 2 }, false);
  } else console.log(`SKIP  kit dir not present; ${hook} byte-identity not checked`);
}
// NOTE (decision G, owner-approved "measure first, accept documented friction"): the two dangerous-git false blocks pinned above
// ('HEAD:main', 'Pushed: main') are ACCEPTED, documented friction -- not desired behaviour.
console.log(failed ? `\n${failed} FAILED` : "\nall promised behaviours PASS");
process.exit(failed ? 1 : 0);
