#!/usr/bin/env node
// PreToolUse hook: hard gate ensuring rushcut-dev-plan's Gate 2 (competitor/context research) and
// Gate 3 (plan + traps, ChatGPT, CPO verdict) checkpoints actually happened -- with PROOF (real
// tool_use evidence read from a subagent's own transcript, plus a structural VERDICT marker in the
// CPO's relayed result), not just "the agent was spawned" or a self-reported claim.
//
// Shape (issue #156, CPO/Consultant/CC 3-role model; docs/agent_plan.md):
//   Gate 1 (JTBD) -- CPO only, no search, enforced separately by enforce-cpo-gate1-spawn.js.
//   Gate 2 (competitor/context) -- rushcut-pp-consultant, Claude WebSearch only, >=3 distinct
//     PRODUCTIVE queries spanning >=2 evidence types (see countWebSearchDiversity in lib/transcript.js).
//   Gate 3 (plan + traps) -- rushcut-pp-consultant, ONE ChatGPT Project spawn, TWO sequential
//     queries (breadth then depth), findings mapped to the plan and written to a scratch file;
//     rushcut-cpo then reads that file and renders the actual VERDICT.
// It re-derives proof from the transcript on every call; it does not trust prose in an agent file or a
// narrative claim by the orchestrator.
//
// WHAT IT GATES (#216 Step 2): the Edit and Write tools ONLY. Bash/PowerShell writes, NotebookEdit and any
// other tool are NOT covered -- this hook does not protect all file modifications, and "exempt" does not
// mean "approved". Within Edit/Write the scope is the REPOSITORY (lib/paths.js classifies by file identity):
//   outside the repo (the owner's unrelated files, %TEMP% scratch, everything under ~/.claude) -> not acted on;
//   repo-exempt (frozen meta-tooling files, `docs/**`, `.claude/skills/**`, anchored at the repo root) -> allowed;
//   repo-protected (everything else) and unresolvable -> needs: (a) a completed rushcut-pp-consultant spawn
//   proving Gate 2, (b) one proving Gate 3 (both ChatGPT cycles, or the documented Chrome-unavailable
//   fallback), (c) the MOST RECENT completed rushcut-cpo spawn rendering "VERDICT: APPROVE".
// A session with no active dev-plan skill call (or after rushcut-wrapup) is inert for this hook.
// "Complete" for a spawn never means "succeeded": the gates stay safe because they need tool-call evidence
// AND a final-line VERDICT. Background spawns are complete only on STRUCTURED evidence (lib/transcript.js).
//
// Enforcement limits of the plan-gate hook (#216): (1) HOOK CANNOT RUN OR CANNOT FINISH - enforcement is impossible
// and this is an infrastructure failure, not a policy. The hooks are registered as `node .claude/hooks/<file>.js`,
// a path relative to the session's working directory, so when the cwd is not the repo root node cannot find the file
// and Claude Code treats the exit as non-blocking (27 of 125 local transcripts show this; tracked in #218).
// The same holds when the hook file itself fails before its try/catch (a syntax error, node absent), when the hook
// hangs synchronously (including inside a module load), because the self-deadline only runs at decision points and
// cannot interrupt it, and when the harness cancels it at its 5 s registered timeout (a timed-out PreToolUse hook
// does not block); the hook's own 3.5 s self-deadline exists to deny BEFORE that point where it can. (2) A hook that
// STARTS but cannot load a module or throws FAILS CLOSED for protected Edit/Write, except exactly five repair files
// (`enforce-pp-plan-gates.js`, `lib/paths.js`, `lib/paths.test.js`, `lib/transcript.js`, `lib/transcript.test.js`) and
// paths that are LEXICALLY outside the repo (no filesystem resolution). That lexical allow is a narrowly scoped
// recovery compromise, NOT proof that a path is outside the repo: a junction, 8.3 name or other filesystem alias that
// points into the repo but looks external can pass in this degraded state, so module failure does NOT provide complete
// path protection. (3) A classification timeout (1.5 s) or an unclassifiable path is treated as a protected repo
// path: only the five repair files stay exempt, so `docs/**` is NOT exempt for that call. When the transcript is
// readable, it is denied only while a dev-plan session is active, wrapup has not passed and its gates are unproven,
// and allowed otherwise. An unreadable or missing transcript denies a protected edit in every session, and so does
// the 3.5 s self-deadline. Exempt and outside paths still pass.
//
// Flow: not Edit/Write -> allow; inline repair-file fallback (string equality, before any module load) -> allow;
// one transcript read (a FAILED read is retried 3 x 150 ms; a missing transcript_path counts as unreadable);
// readable + no active dev-plan -> allow with no classification; otherwise classify in a CHILD process with a
// hard 1.5 s budget (a worker thread cannot be abandoned) and decide per lib/paths.js decide().

"use strict";
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GATED_TOOLS = new Set(["Edit", "Write"]);
// The five files needed to REPAIR this very hook. Compared by plain string equality against
// path.join(REPO_ROOT, rel) -- no fs, no module -- so a broken classifier can never lock out its own repair.
const INLINE_FALLBACK_FILES = [
  ".claude/hooks/enforce-pp-plan-gates.js",
  ".claude/hooks/lib/paths.js",
  ".claude/hooks/lib/paths.test.js",
  ".claude/hooks/lib/transcript.js",
  ".claude/hooks/lib/transcript.test.js",
];

function denyAndExit(reason) {
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  try {
    fs.writeSync(1, out);
  } catch {
    process.stdout.write(out);
  }
  process.exit(0);
}

function absoluteFor(data) {
  const fp = data && data.tool_input && data.tool_input.file_path;
  if (typeof fp !== "string" || !fp || fp.includes("\0")) return null;
  if (/^[A-Za-z]:[\\/]/.test(fp)) return path.win32.resolve(fp);
  if (typeof data.cwd === "string" && data.cwd && /^[A-Za-z]:[\\/]/.test(data.cwd) && !/^[\\/]/.test(fp) && !/^[A-Za-z]:/.test(fp)) return path.win32.resolve(data.cwd, fp);
  return null;
}
function isInlineFallback(data) {
  const abs = absoluteFor(data);
  if (!abs) return false;
  const a = abs.toLowerCase();
  return INLINE_FALLBACK_FILES.some((rel) => a === path.win32.join(REPO_ROOT, rel).toLowerCase());
}
// Degraded mode only: text comparison, whole path segments, case-folded. NO filesystem resolution.
function lexicallyOutside(data) {
  const fp = data && data.tool_input && data.tool_input.file_path;
  if (typeof fp !== "string" || !/^[A-Za-z]:[\\/]/.test(fp) || fp.includes("\0")) return false;
  const norm = fp.replace(/\//g, "\\");
  if (norm.split("\\").includes("..")) return false;
  if (norm.slice(2).includes(":")) return false;
  const a = norm.toLowerCase().replace(/\\+$/, "");
  const r = REPO_ROOT.toLowerCase().replace(/\\+$/, "");
  return !(a === r || a.startsWith(r + "\\"));
}

let input = {};
try {
  const raw = fs.readFileSync(0, "utf8");
  input = raw ? JSON.parse(raw) : {};
} catch {
  input = {};
}

function degraded(err) {
  const tool = String((input && input.tool_name) ?? "");
  if (!GATED_TOOLS.has(tool)) process.exit(0);
  if (isInlineFallback(input) || lexicallyOutside(input)) process.exit(0);
  denyAndExit(
    `BLOCKED (hook-enforced): the plan-gate hook failed to run correctly (${String((err && err.message) || err).slice(0, 200)}), so this protected ` +
      `Edit/Write cannot be verified (fail closed). The five repair files (.claude/hooks/enforce-pp-plan-gates.js, lib/paths.js, lib/paths.test.js, ` +
      `lib/transcript.js, lib/transcript.test.js) and paths clearly outside the repo are still allowed; repair the failing module first. ` +
      `Non-edit tools still work.`
  );
}
process.on("uncaughtException", degraded);

// --- Gate evidence (unchanged rules; completion now comes from lib/transcript.js structured evidence) ---------------------
const CONSULTANT = "rushcut-pp-consultant";
const CPO = "rushcut-cpo";
const MIN_WEBSEARCH_QUERIES = 3;
const MIN_SOURCE_TYPES = 2;

function evaluateGates(T, lines, transcriptPath, opts) {
  const skillIdx = T.findLastMatchingSkillCall(lines, "rushcut-dev-plan");
  const withResolved = (type) =>
    T.findAgentSpawnsSince(lines, skillIdx, type).map((s) => ({ ...s, type, resolved: T.resolveAgentSpawn(lines, s, transcriptPath) }));
  const consultantSpawns = withResolved(CONSULTANT);
  const cpoSpawns = withResolved(CPO);

  // Gate 2: any completed Consultant spawn proving >=3 distinct productive WebSearch queries spanning >=2 evidence types.
  let gate2Satisfied = false;
  for (const spawn of consultantSpawns) {
    if (!spawn.resolved || !spawn.resolved.complete) continue;
    const { count, sourceTypes } = T.countWebSearchDiversity(transcriptPath, spawn.resolved.agentId);
    if (count >= MIN_WEBSEARCH_QUERIES && sourceTypes.size >= MIN_SOURCE_TYPES) {
      gate2Satisfied = true;
      break;
    }
  }

  // Gate 3: both ChatGPT query cycles with matching issue numbers, or the documented Chrome-unavailable fallback.
  let gate3Satisfied = false;
  let gate3IssueMismatch = null;
  for (const spawn of consultantSpawns) {
    if (!spawn.resolved || !spawn.resolved.complete) continue;
    const { provenGates, issueNumbers, triedBlocked } = T.countGateCycles(transcriptPath, spawn.resolved.agentId);
    if (provenGates.has("breadth") && provenGates.has("depth")) {
      if (issueNumbers.breadth && issueNumbers.depth && issueNumbers.breadth === issueNumbers.depth) {
        gate3Satisfied = true;
        break;
      }
      gate3IssueMismatch = { breadth: issueNumbers.breadth, depth: issueNumbers.depth };
      continue;
    }
    if (triedBlocked) {
      gate3Satisfied = true;
      break;
    }
  }

  // CPO's VERDICT is the actual approval; value AND recency matter (latest completed round, APPROVE specifically).
  const cpoApproved = T.latestVerdict(lines, cpoSpawns, transcriptPath) === "APPROVE";

  const missing = [];
  if (!gate2Satisfied) {
    missing.push(
      `Gate 2 (competitor/context research): no completed rushcut-pp-consultant spawn proves >=${MIN_WEBSEARCH_QUERIES} ` +
        `distinct productive WebSearch queries spanning >=${MIN_SOURCE_TYPES} evidence types. Spawn rushcut-pp-consultant to run Gate 2 ` +
        `before editing implementation files.`
    );
  }
  if (!gate3Satisfied && gate3IssueMismatch) {
    missing.push(
      `Gate 3 (plan + traps): both the breadth and depth ChatGPT query cycles were proven, but their captured ` +
        `GitHub issue numbers do not correlate (breadth tagged issue #${gate3IssueMismatch.breadth ?? "<none>"}, ` +
        `depth tagged issue #${gate3IssueMismatch.depth ?? "<none>"}) -- both must reference the SAME issue, and ` +
        `neither may be missing. Re-run Gate 3 with both queries opening on "GitHub issue #<N>: " for this issue.`
    );
  } else if (!gate3Satisfied) {
    missing.push(
      `Gate 3 (plan + traps): no completed rushcut-pp-consultant spawn proves both the breadth and depth ChatGPT ` +
        `query cycles (a fingerprinted query typed on chatgpt.com, an actual submit transition, and a genuinely new ` +
        `post-submit read -- not just any browser tool call), and no genuine tried-and-blocked Chrome-unavailable ` +
        `case was found either. Spawn rushcut-pp-consultant to run Gate 3 before editing implementation files.`
    );
  }
  if (!cpoApproved) {
    missing.push(
      `Gate 3 sign-off: the most recent completed rushcut-cpo spawn since dev-plan start did not render ` +
        `"VERDICT: APPROVE" (either no spawn yet, no marker, or the latest verdict was OBJECTION/DECLINE-OUT-OF-SCOPE). ` +
        `Spawn rushcut-cpo to read Consultant's Gate 3 findings-mapping file and render a verdict ending in ` +
        `"VERDICT: APPROVE" before editing implementation files.`
    );
  }
  if (missing.length === 0) return { proven: true, pending: 0, text: "" };

  const pendingSpawns = [...consultantSpawns, ...cpoSpawns].filter((s) => s.resolved && !s.resolved.complete);
  let text =
    `BLOCKED (hook-enforced): rushcut-dev-plan requires provable grounding + plan-approval before ` +
    `implementation edits, per .claude/skills/rushcut-dev-plan/SKILL.md. Missing: ${missing.join(" | ")} ` +
    `(Note: tool-call evidence is a floor, not a ceiling -- it proves real interaction happened, not that it was thorough.)`;
  if (pendingSpawns.length) {
    const kinds = [...new Set(pendingSpawns.map((s) => s.type))].join(", ");
    text =
      `BLOCKED (hook-enforced): cannot verify yet -- ${pendingSpawns.length} spawn(s) (${kinds}) since the dev-plan start have no visible completion yet. ` +
      `Wait for the spawn's completion notification and retry; if it was killed, re-spawn it. Unproven so far: ${missing.join(" | ")}`;
  }
  if (opts && opts.isSubagent) {
    text += " (This call came from a subagent: return to the orchestrating session; a subagent cannot spawn the consultant.)";
  }
  return { proven: false, pending: pendingSpawns.length, text };
}

function main() {
  const tool = String((input && input.tool_name) ?? "");
  if (!GATED_TOOLS.has(tool)) return;
  if (isInlineFallback(input)) return;
  // Loaded only now, inside the try/catch: a missing or throwing module is a DEGRADED-mode event, not a crash.
  const T = require("./lib/transcript");
  const P = require("./lib/paths");
  const result = P.evaluateEditCall(input, {
    repoRoot: REPO_ROOT,
    evaluateGates: (lines, transcriptPath, opts) => evaluateGates(T, lines, transcriptPath, opts),
  });
  if (result.action === "deny") denyAndExit(result.message || `BLOCKED (hook-enforced): ${result.reason}`);
}

try {
  main();
} catch (e) {
  degraded(e);
}
