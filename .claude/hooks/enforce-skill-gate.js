#!/usr/bin/env node
// PreToolUse hook: the real enforcement boundary, and fully self-contained. Runs before every
// tool call and independently re-derives "is a skill trigger currently pending" by reading
// transcript_path directly (provided in every hook payload) -- no shared state file with
// UserPromptSubmit, which removes the cross-hook write/read race an earlier file-based version
// of this gate had (see docs/LEARNINGS.md). Fails open on any transcript read/parse error, and
// naturally "expires" the moment the user's next message doesn't re-trigger -- no separate
// attempts/time-based expiry bookkeeping needed, unlike the old design.

const fs = require("fs");
const { detectSkill } = require("./lib/trigger-match");
const { findLastHumanMessage, hasMatchingSkillCallSince } = require("./lib/transcript");

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
const transcriptPath = data.transcript_path;

const EXEMPT_TOOLS = new Set(["Skill", "AskUserQuestion"]);

if (EXEMPT_TOOLS.has(toolName) || !transcriptPath) {
  process.exit(0);
}

const last = findLastHumanMessage(transcriptPath);
if (!last) {
  process.exit(0); // couldn't read/parse transcript, or no human message yet -- fail open
}

const skill = detectSkill(last.text);
if (!skill) {
  process.exit(0); // most recent human message didn't contain a trigger phrase
}

if (hasMatchingSkillCallSince(last.lines, last.index, skill)) {
  process.exit(0); // already satisfied for this turn
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): the user's most recent message matched a hard-enforced ` +
        `trigger phrase for the "${skill}" skill. Call the Skill tool with skill: "${skill}" ` +
        `before "${toolName}" or any other tool will be permitted.`,
    },
  })
);
