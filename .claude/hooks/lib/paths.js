"use strict";
// Path classification + the decision table for the plan-gate hook (#216 Step 2).
//
// WHY THIS FILE EXISTS. enforce-pp-plan-gates.js used to gate EVERY Edit/Write wherever the file was
// (so session scratch in %TEMP% and the session-close MEMORY.md write were blocked) and decided which
// files were exempt by SUBSTRING (`src/components/docs/X.tsx` and a nested `CLAUDE.md` were exempt).
// Here the hook's scope becomes the repository: a path is classified by what it really IS on disk.
//
//   outside          not in the repo (the owner's unrelated files, %TEMP% scratch, everything under ~/.claude)
//                    -> this hook does not act on it. (~/.claude governance protection is #217's job.)
//   repo-exempt      in the repo AND on a frozen exemption (meta-tooling files, `docs/**`, `.claude/skills/**`),
//                    matched ANCHORED at the repo root on a clean canonical path
//   repo-protected   in the repo, not exempt -> needs the gates
//   unresolvable     could not be classified safely (see below) -> treated as repo-protected
//
// HOW. A path is INSIDE the repo iff some directory on the real-path chain of its nearest existing
// ancestor has the same FILE IDENTITY (volume + file index) as the repo root. Identity, not text:
// on Windows `\\localhost\c$\apps\repo` has the same identity as `C:\apps\repo` while realpath.native
// returns the UNC text unchanged, so a prefix comparison would call it outside. Junctions and
// symlinks are followed by stat, so a link out of the repo is "outside" and a link into it from
// elsewhere is "inside". An exemption is granted only when the canonical text ALSO sits under the
// canonical repo root by whole segments; inside-by-identity but not-under-the-text (the UNC alias)
// is inside and NOT exempt, i.e. gated (fail closed).
//
// BOUNDED WORK. Classification can touch a slow or unreachable filesystem (an unreachable UNC name
// blocked a stat for up to 42 s), so the hook runs it in a CHILD process with a hard budget and kills
// it (a worker thread cannot be abandoned: the process cannot exit while the syscall is blocked).
//
// This file is git-tracked: it requires node builtins and ./transcript only (never a local-only file).

const fs = require("fs");
const path = require("path");

const GATED_TOOLS = new Set(["Edit", "Write"]);
// Frozen exact files (meta-tooling and root config). The SET is unchanged from the previous hook apart
// from the two new lib files; only the MATCHING is anchored now. Lower-case, forward slashes, repo-relative.
const FROZEN_EXEMPT_FILES = [
  ".claude/agents/rushcut-cpo.md",
  ".claude/agents/rushcut-pp-consultant.md",
  ".claude/hooks/enforce-cpo-gate1-spawn.js",
  ".claude/hooks/enforce-pp-plan-gates.js",
  ".claude/hooks/enforce-pp-wrapup-signoff.js",
  ".claude/hooks/lib/transcript.js",
  ".claude/hooks/lib/transcript.test.js",
  ".claude/hooks/lib/paths.js",
  ".claude/hooks/lib/paths.test.js",
  ".claude/settings.json",
  ".gitignore",
  "claude.md",
];
const EXEMPT_PREFIXES = ["docs/", ".claude/skills/"];

const CLASSIFY_BUDGET_MS = 1500; // hard budget for the classification child
const DEADLINE_MS = 3500; // hook self-deadline; the registered hook timeout is 5 s and a timed-out PreToolUse hook does NOT block
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 150;

function isExemptRel(relLowerSlash) {
  if (typeof relLowerSlash !== "string" || !relLowerSlash) return false;
  if (FROZEN_EXEMPT_FILES.includes(relLowerSlash)) return true;
  return EXEMPT_PREFIXES.some((p) => relLowerSlash.startsWith(p) && relLowerSlash.length > p.length);
}

// --- interpretations of the input string ------------------------------------------------------
// The file tools accept Git-Bash style paths (`/c/Users/x` is written to C:\Users\x - verified for Write),
// so the same string is evaluated under every interpretation the tools may use and the target is
// treated as INSIDE if ANY interpretation is inside.
function msysToWin(p) {
  let m = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (!m) return null;
  return m[1].toUpperCase() + ":\\" + (m[2] || "").replace(/\//g, "\\");
}

function defaultFs() {
  return {
    stat: (p) => fs.statSync(p, { bigint: true }),
    lstat: (p) => fs.lstatSync(p),
    realpath: (p) => fs.realpathSync.native(p),
  };
}
const idOf = (st) => String(st.dev) + ":" + String(st.ino);

// Returns an array of candidate absolute Windows paths, or { unresolvable: reason }.
function candidatesFor(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath.trim()) return { unresolvable: "empty path" };
  if (filePath.includes("\0")) return { unresolvable: "path contains NUL" };
  const norm = filePath.replace(/\//g, "\\");
  if (/^\\\\\.(\\|$)/.test(norm)) return { unresolvable: "device path (\\\\.\\...)" };
  if (/^\\\\wsl(\$|\.localhost)(\\|$)/i.test(norm)) return { unresolvable: "WSL network path (\\\\wsl$ or \\\\wsl.localhost)" };
  const out = [];
  const cwdWin = typeof cwd === "string" && cwd ? msysToWin(cwd) || cwd : null;
  const isAbs = path.win32.isAbsolute(filePath) && /^([A-Za-z]:[\\/]|[\\/]{2})/.test(filePath);
  if (isAbs) {
    out.push(path.win32.resolve(filePath));
  } else if (cwdWin) {
    out.push(path.win32.resolve(cwdWin, filePath));
  } else if (!msysToWin(filePath)) {
    return { unresolvable: "relative path without a working directory" };
  }
  const m = msysToWin(filePath);
  if (m) out.push(path.win32.resolve(m));
  // alternate data streams: a ':' in any component after the root (including on directories)
  for (const cand of out) {
    const root = path.win32.parse(cand).root;
    const rest = cand.slice(root.length);
    if (rest.split("\\").some((c) => c.includes(":"))) return { unresolvable: "alternate data stream or ':' in a path component" };
  }
  return out;
}

function classifyOne(P, repoRootId, rootCanon, fsI) {
  let cur = P;
  let st = null;
  for (;;) {
    try {
      st = fsI.stat(cur);
      break;
    } catch (e) {
      const code = e && e.code;
      if (code === "ELOOP") return { kind: "unresolvable", reason: "link loop at " + cur };
      if (code === "ENOENT" || code === "ENOTDIR") {
        let linkExists = false;
        try {
          fsI.lstat(cur);
          linkExists = true;
        } catch {
          /* really absent: walk up */
        }
        if (linkExists) return { kind: "unresolvable", reason: "dangling link at " + cur };
      }
      // any other stat error (EACCES, EPERM, UNKNOWN, ...): walk up to an ancestor we CAN stat
    }
    const parent = path.win32.dirname(cur);
    if (parent === cur) return { kind: "outside", reason: "no existing ancestor" };
    cur = parent;
  }
  let R;
  try {
    R = fsI.realpath(cur);
  } catch (e) {
    return { kind: "unresolvable", reason: "realpath failed (" + ((e && e.code) || "ERR") + ") at " + cur };
  }
  // identity walk over the parents of the REAL path
  let inside = false;
  for (let d = R; ; ) {
    try {
      if (idOf(fsI.stat(d)) === repoRootId) {
        inside = true;
        break;
      }
    } catch {
      /* an unreadable ancestor cannot be the repo root; keep walking */
    }
    const p = path.win32.dirname(d);
    if (p === d) break;
    d = p;
  }
  if (!inside) return { kind: "outside", reason: "not under the repo root" };
  const remaining = path.win32.relative(cur, P);
  const canonText = remaining ? path.win32.join(R, remaining) : R;
  const rel = path.win32.relative(rootCanon, canonText);
  const underRoot = rel === "" || (!(rel === ".." || rel.startsWith("..\\")) && !path.win32.isAbsolute(rel));
  if (!underRoot) return { kind: "repo-protected", canonicalRel: null, reason: "inside the repo by identity but not under the canonical root text (alias): not exempt" };
  const canonicalRel = rel.replace(/\\/g, "/");
  let exempt = isExemptRel(canonicalRel.toLowerCase());
  if (exempt && cur === P && st && !st.isDirectory() && Number(st.nlink) > 1) exempt = false; // a hard link may alias a protected file
  return { kind: exempt ? "repo-exempt" : "repo-protected", canonicalRel };
}

// classifyTarget({ filePath, cwd, repoRoot, fs? }) -> { kind, canonicalRel?, reason? }
function classifyTarget({ filePath, cwd, repoRoot, fs: fsImpl } = {}) {
  const fsI = fsImpl || defaultFs();
  const cands = candidatesFor(filePath, cwd);
  if (!Array.isArray(cands)) return { kind: "unresolvable", reason: cands.unresolvable };
  if (!cands.length) return { kind: "unresolvable", reason: "no interpretation" };
  const rootCanon = fsI.realpath(repoRoot);
  const repoRootId = idOf(fsI.stat(rootCanon));
  const results = cands.map((c) => classifyOne(c, repoRootId, rootCanon, fsI));
  const bad = results.find((r) => r.kind === "unresolvable");
  if (bad) return bad;
  const prot = results.find((r) => r.kind === "repo-protected");
  if (prot) return prot;
  const ex = results.find((r) => r.kind === "repo-exempt");
  if (ex) return ex;
  return results[0];
}

// --- the bounded child -----------------------------------------------------------------------
const KINDS = new Set(["outside", "repo-exempt", "repo-protected", "unresolvable"]);
function classifyViaChild({ filePath, cwd, repoRoot, budgetMs = CLASSIFY_BUDGET_MS, spawn, childArgs } = {}) {
  const spawnSync = spawn || require("child_process").spawnSync;
  const args = childArgs || [__filename, "--classify"];
  let r;
  try {
    r = spawnSync(process.execPath, args, {
      input: JSON.stringify({ filePath, cwd, repoRoot }),
      timeout: budgetMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: 65536,
      encoding: "utf8",
    });
  } catch (e) {
    return { kind: "unresolvable", reason: "classification child could not be started (" + ((e && e.code) || "ERR") + ")" };
  }
  if (!r || r.error) {
    const code = r && r.error && r.error.code;
    return { kind: "unresolvable", reason: code === "ETIMEDOUT" ? "path classification timed out (slow or unreachable filesystem)" : "classification child error (" + (code || "unknown") + ")" };
  }
  if (r.status !== 0 || r.signal !== null) return { kind: "unresolvable", reason: "classification child failed (status " + r.status + ", signal " + r.signal + ")" };
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return { kind: "unresolvable", reason: "classification child produced no valid output" };
  }
  if (!out || typeof out !== "object" || !KINDS.has(out.kind)) return { kind: "unresolvable", reason: "classification child returned an unexpected schema" };
  return { kind: out.kind, canonicalRel: typeof out.canonicalRel === "string" ? out.canonicalRel : null, reason: typeof out.reason === "string" ? out.reason : undefined };
}

// --- the decision table ----------------------------------------------------------------------
// Pure: every input is an already-computed fact. `classification` is null until it has been computed;
// decide() answers "need-classification" when the answer depends on it. Protected = repo-protected or
// unresolvable.
function decide(s) {
  if (!GATED_TOOLS.has(s.tool)) return { action: "allow", reason: "not-gated-tool" };
  if (s.inlineFallback) return { action: "allow", reason: "inline-fallback" };
  if (s.transcript === "readable" && (!s.devPlanActive || s.wrapupPassed)) return { action: "allow", reason: "inert-session" };
  if (s.classification === null || s.classification === undefined) return { action: "need-classification", reason: "needs-classification" };
  if (s.classification === "outside") return { action: "allow", reason: "outside" };
  if (s.classification === "repo-exempt") return { action: "allow", reason: "repo-exempt" };
  if (s.deadlineExceeded) return { action: "deny", reason: "deadline" };
  if (s.transcript !== "readable") return { action: "deny", reason: "transcript-unreadable" };
  if (s.gatesProven) return { action: "allow", reason: "gates-proven" };
  return { action: "deny", reason: s.pendingSpawn ? "gates-unproven-pending-spawn" : "gates-unproven" };
}

// --- orchestration (all I/O injectable so the ordering and deadline are testable in-process) ----
function defaultDeps() {
  const T = require("./transcript");
  return {
    now: () => Date.now(),
    parentTranscriptPath: T.parentTranscriptPath,
    readTranscriptLines: T.readTranscriptLines,
    readTranscriptWithRetry: T.readTranscriptWithRetry,
    findLastMatchingSkillCall: T.findLastMatchingSkillCall,
    classify: classifyViaChild,
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

function recoveryText(isSubagent) {
  return isSubagent
    ? "Return to the orchestrating session; do not retry from the subagent."
    : "Retry in a moment; if it persists, restart the session or make this edit by hand. Exempt paths (docs/**, CLAUDE.md, the gate's own files), paths outside the repo, and non-edit tools still work.";
}

// evaluateEditCall(data, deps) -> { action: "allow"|"deny", reason, message? }
//   deps.repoRoot (required), deps.evaluateGates(lines, transcriptPath, { isSubagent }) -> { proven, text, pending }
function evaluateEditCall(data, deps) {
  const d = Object.assign(defaultDeps(), deps || {});
  const t0 = d.now();
  const elapsed = () => d.now() - t0;
  const tool = String((data && data.tool_name) ?? "");
  if (!GATED_TOOLS.has(tool)) return { action: "allow", reason: "not-gated-tool" };
  const isSubagent = !!(data && typeof data.agent_id === "string" && data.agent_id);
  const tpath = d.parentTranscriptPath(data.transcript_path);
  const filePath = data.tool_input && data.tool_input.file_path;

  const sessionIsActive = (lines) => {
    const skillIdx = d.findLastMatchingSkillCall(lines, "rushcut-dev-plan");
    return skillIdx !== -1 && !(d.findLastMatchingSkillCall(lines, "rushcut-wrapup") > skillIdx);
  };

  // 1. one read; a FAILED read is retried (bounded) because the transcript is written asynchronously.
  let read = d.readTranscriptLines(tpath);
  let attempts = 1;
  if (!read.ok) {
    const rr = d.readTranscriptWithRetry({ path: tpath, attempts: RETRY_ATTEMPTS, delayMs: RETRY_DELAY_MS, sleep: d.sleep });
    read = rr;
    attempts = rr.attempts;
  }
  const lines = read.ok ? read.lines : null;
  if (lines && !sessionIsActive(lines)) return { action: "allow", reason: "inert-session" };

  // 2. classify (child, bounded) only when the answer depends on it
  const cls = d.classify({ filePath, cwd: data.cwd, repoRoot: d.repoRoot });
  const base = { tool, inlineFallback: false, transcript: lines ? "readable" : "unreadable", devPlanActive: true, wrapupPassed: false, classification: cls.kind };
  const early = decide({ ...base, deadlineExceeded: elapsed() > DEADLINE_MS, gatesProven: false });
  if (early.action === "allow") return early;
  if (early.reason === "deadline") return { ...early, message: `BLOCKED (hook-enforced): hook deadline exceeded (${elapsed()} ms of ${DEADLINE_MS} ms) before this protected edit could be verified. ${recoveryText(isSubagent)}` };
  if (early.reason === "transcript-unreadable") {
    return {
      ...early,
      message: `BLOCKED (hook-enforced): the session transcript could not be read (${read.code || "unknown"}) after ${attempts} attempt(s), so this protected edit cannot be verified. ${recoveryText(isSubagent)}`,
    };
  }

  // 3. the gates (readable transcript, active dev-plan session, protected target)
  let g = d.evaluateGates(lines, tpath, { isSubagent });
  let polls = 0;
  while (!g.proven && g.pending > 0 && polls < RETRY_ATTEMPTS && elapsed() < DEADLINE_MS - 500) {
    // a consultant/CPO spawn has no visible completion yet: the transcript may simply lag
    d.sleep(RETRY_DELAY_MS);
    polls++;
    const again = d.readTranscriptLines(tpath);
    if (again.ok) g = d.evaluateGates(again.lines, tpath, { isSubagent });
  }
  const final = decide({ ...base, deadlineExceeded: false, gatesProven: g.proven, pendingSpawn: g.pending > 0 });
  if (final.action === "allow") return final;
  const note = cls.kind === "unresolvable" ? ` (Note: the target path could not be classified -- ${cls.reason} -- so it is treated as a protected repo path.)` : "";
  return { ...final, message: g.text + note };
}

// --- CLI: `node paths.js --classify` (stdin JSON {filePath, cwd, repoRoot}) -> stdout JSON ---------
if (require.main === module && process.argv[2] === "--classify") {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(classifyTarget(input)));
    process.exit(0);
  } catch {
    process.exit(2);
  }
}

module.exports = {
  GATED_TOOLS,
  FROZEN_EXEMPT_FILES,
  EXEMPT_PREFIXES,
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
};
