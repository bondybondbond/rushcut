#!/usr/bin/env node
// PreToolUse hook: the actual enforcement boundary for the skill-trigger rule. Runs before
// EVERY tool call. If enforce-skill-trigger.js (UserPromptSubmit) armed the gate for this
// session, every tool call except Skill/AskUserQuestion is denied until the matching Skill
// is invoked. UserPromptSubmit alone only injects a suggestion the model can ignore at the
// point it picks a tool -- this hook is what makes the rule actually deterministic.
//
// Fail-open: see lib/skill-gate.js isExpired() -- a stuck/buggy gate auto-clears after
// 10 minutes or 5 denied attempts, so this can never permanently block a session.

const fs = require("fs");
const gate = require("./lib/skill-gate");

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

const sessionId = String(data.session_id ?? "unknown");
const toolName = String(data.tool_name ?? "");

const EXEMPT_TOOLS = new Set(["Skill", "AskUserQuestion"]);

const pending = gate.read(sessionId);

if (!pending) {
  process.exit(0);
}

if (toolName === "Skill") {
  const invokedSkill = data.tool_input && data.tool_input.skill;
  if (invokedSkill === pending.skill) {
    gate.clear(sessionId);
  }
  process.exit(0);
}

if (EXEMPT_TOOLS.has(toolName)) {
  process.exit(0);
}

if (gate.isExpired(pending)) {
  gate.clear(sessionId);
  process.exit(0);
}

gate.bumpAttempt(sessionId, pending);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): the user's message matched a hard-enforced trigger phrase for ` +
        `the "${pending.skill}" skill. You must call the Skill tool with skill: "${pending.skill}" ` +
        `before "${toolName}" or any other tool will be permitted this turn.`,
    },
  })
);
