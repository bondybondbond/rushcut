#!/usr/bin/env node
// PreToolUse hook: hard gate ensuring Skill(rushcut-wrapup) is never invoked without a real,
// provable rushcut-pp-consultant sign-off having actually run in this session -- CLAUDE.md
// already states this rule in prose ("Skill(rushcut-wrapup) is a hard gate... may never be
// invoked without a prior rushcut-pp-consultant sign-off"), but nothing mechanically enforced it
// until now. Session-wide (not anchored to an active rushcut-dev-plan session), because
// docs-only/probe/investigation sessions that never triggered dev-plan still require sign-off
// per the same CLAUDE.md rule.
//
// Search evidence is deliberately NOT required here (per the corrected gate design: gates 3&4 --
// plan approval, wrap-readiness -- require approval to exist, not that search happened; search is
// gates 1&2's job, enforced by enforce-pp-plan-gates.js instead). This hook checks that the MOST
// RECENT completed rushcut-pp-consultant spawn in this session's transcript rendered a VERDICT of
// specifically APPROVE -- not just any marker (fixed 2026-07-23 per this agent's own Round 4
// review: presence-only checking let a stale or unrelated round's marker, or an unresolved
// OBJECTION, satisfy a gate whose entire point is requiring actual approval of the latest round).
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

if (toolName !== "Skill" || toolInput.skill !== "rushcut-wrapup" || !transcriptPath) {
  process.exit(0);
}

let lines;
try {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  lines = raw.length ? raw.split("\n").filter(Boolean) : [];
} catch {
  process.exit(0); // fail open -- can't read the transcript, don't block on a guess
}

const CONSULTANT = "rushcut-pp-consultant";
const consultantSpawns = findAgentSpawnsSince(lines, -1, CONSULTANT);

// Value AND recency matter, not just marker presence (rushcut-pp-consultant's own Round 4
// review, 2026-07-23): a stale early-round marker, or an unrelated round's OBJECTION/APPROVE,
// must not satisfy "sign-off" -- only the LATEST completed round's verdict counts, and it must
// actually be APPROVE.
const hasSignoff = latestVerdict(lines, consultantSpawns) === "APPROVE";

if (hasSignoff) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): Skill(rushcut-wrapup) requires a prior rushcut-pp-consultant sign-off on ` +
        `this session's outcome, per CLAUDE.md. The most recent completed rushcut-pp-consultant spawn in this ` +
        `transcript did not render "VERDICT: APPROVE" (either no spawn yet, no marker, or the latest verdict ` +
        `was OBJECTION/DECLINE-OUT-OF-SCOPE). Spawn rushcut-pp-consultant (Round 4 -- wrap-readiness, or the ` +
        `probe/investigation equivalent), resolve any objection, and ensure its final response ends with ` +
        `"VERDICT: APPROVE".`,
    },
  })
);
