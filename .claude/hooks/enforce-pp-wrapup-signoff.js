#!/usr/bin/env node
// PreToolUse hook: hard gate ensuring `git commit` is never run without a real, provable
// rushcut-cpo Gate 4 (wrap-readiness) sign-off having actually happened in this session.
//
// Rewritten 2026-07-24 (issue #156, CPO/Consultant/CC redesign). Blocking point moved from
// Skill(rushcut-wrapup) entry to `git commit` specifically -- flagged in the #156 blueprint as
// "the single highest-risk change to get wrong." Rationale: rushcut-wrapup's own steps (0 through
// 5, cleanup/docs/backlog-harvest) are useful and safe to run even before Gate 4 approves --
// blocking the Skill call itself would have stopped LEARNINGS.md updates, backlog-harvest, and
// docs work that have nothing to do with whether the delivered code meets the bar. What actually
// needs to wait for Gate 4 is the irreversible step: committing (and by extension pushing) the
// work. This coexists with, and does not replace, rushcut-wrapup's own Step 0.3 gate (acceptance
// criteria sign-off) and its Step 6 gate-check language ("do not run this step if Step 0.3 has
// any unresolved fail row") -- those check a DIFFERENT precondition (did the acceptance criteria
// actually get verified) than this hook (did CPO approve the finished result against
// PRD-DEV.md/speed-goal.md/quality-goal.md). Both are independent preconditions on the same
// Step 6, not competing mechanisms.
//
// Session-wide (not anchored to an active rushcut-dev-plan session), because docs-only/probe/
// investigation sessions that never triggered dev-plan can still reach a `git commit` call and
// still need sign-off per the same standing rule.
//
// Search evidence is deliberately NOT required here -- Gate 4 is CPO's wrap-readiness judgment
// call (optionally backed by Consultant WebSearch on request), not a search-proof gate the way
// Gate 2/3 are (those are enforce-pp-plan-gates.js's job). This hook checks that the MOST RECENT
// completed rushcut-cpo spawn in this session's transcript rendered a VERDICT of specifically
// APPROVE -- not just any marker. Value and recency both matter, not presence alone (a stale or
// unrelated round's marker, or an unresolved OBJECTION, must not satisfy a gate whose entire point
// is requiring actual approval of the latest round).
//
// Critical, hard-learned distinction (do not weaken): "completed" is proven ONLY via the
// structured toolUseResult/queue-operation completion machinery in lib/transcript.js -- never by
// scanning raw conversation text for phrases. A background-task notification or subagent relay
// must NEVER be treated as a human trigger or an approval by itself; only a real Agent-tool
// spawn's own resolved result counts. This is the same failure class as the still-open #153 bug
// (enforce-skill-gate.js false-triggering on notification text) -- this hook is built to not
// repeat it.

const fs = require("fs");
const { findAgentSpawnsSince, latestVerdict } = require("./lib/transcript");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let data = {};
try {
  const raw = readStdin();
  data = raw ? JSON.parse(raw) : {};
} catch {
  data = {};
}

const toolName = String(data.tool_name ?? "");
const toolInput = data.tool_input || {};
const transcriptPath = data.transcript_path;

// Matches `git commit` in either a Bash or PowerShell command string -- both tools are used in
// this codebase for git operations (see CLAUDE.md's PowerShell-for-WSL guidance). A commit
// wrapped in a heredoc, chained with `&&`, or preceded by `cd`/`Set-Location` still contains the
// literal substring `git commit` somewhere in the command text.
const GIT_COMMIT_RE = /\bgit\s+commit\b/i;
const GATED_TOOLS = new Set(["Bash", "PowerShell"]);

if (!GATED_TOOLS.has(toolName) || !transcriptPath) {
  process.exit(0);
}

const command = String(toolInput.command || "");
if (!GIT_COMMIT_RE.test(command)) {
  process.exit(0);
}

let lines;
try {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  lines = raw.length ? raw.split("\n").filter(Boolean) : [];
} catch {
  process.exit(0); // fail open -- can't read the transcript, don't block on a guess
}

const CPO = "rushcut-cpo";
const cpoSpawns = findAgentSpawnsSince(lines, -1, CPO);

// Value AND recency matter, not just marker presence: a stale early-round marker, or an
// unrelated round's OBJECTION/APPROVE, must not satisfy "sign-off" -- only the LATEST completed
// round's verdict counts, and it must actually be APPROVE.
const hasSignoff = latestVerdict(lines, cpoSpawns) === "APPROVE";

if (hasSignoff) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): \`git commit\` requires a prior rushcut-cpo Gate 4 (wrap-readiness) sign-off ` +
        `on this session's outcome, per CLAUDE.md and docs/agent_plan.md. The most recent completed rushcut-cpo ` +
        `spawn in this transcript did not render "VERDICT: APPROVE" (either no spawn yet, no marker, or the ` +
        `latest verdict was OBJECTION/DECLINE-OUT-OF-SCOPE). Spawn rushcut-cpo (Gate 4 -- wrap-readiness), ` +
        `resolve any objection, and ensure its final response ends with "VERDICT: APPROVE" before committing.`,
    },
  })
);
