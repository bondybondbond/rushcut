// Shared trigger-phrase list + matcher, used by both enforce-skill-trigger.js
// (UserPromptSubmit, soft hint) and enforce-skill-gate.js (PreToolUse, hard block).

const DEV_PLAN_TRIGGERS = [
  "dev plan",
  "new batch",
  "lets start",
  "let's start",
  "i want to build",
  "i want to fix",
  "plan this",
  "plan the next batch",
];

const WRAPUP_TRIGGERS = [
  "wrap up",
  "wrapup",
  "project wrapup",
  "close off the session",
  "end the session",
  "lets wrap",
  "let's wrap",
  "do the wrapup",
  "commit and wrap",
];

function detectSkill(text) {
  const lower = String(text ?? "").toLowerCase();
  if (DEV_PLAN_TRIGGERS.some((p) => lower.includes(p))) return "rushcut-dev-plan";
  if (WRAPUP_TRIGGERS.some((p) => lower.includes(p))) return "rushcut-wrapup";
  return null;
}

module.exports = { detectSkill, DEV_PLAN_TRIGGERS, WRAPUP_TRIGGERS };
