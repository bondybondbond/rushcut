#!/usr/bin/env node
// UserPromptSubmit hook: deterministically forces Skill invocation when the user's message
// contains a rushcut-dev-plan or rushcut-wrapup trigger phrase. A memory file cannot guarantee
// this (soft bias only) -- this hook runs in the harness, outside the model's control, so the
// forcing instruction is injected before the model does any reasoning. See feedback memory
// feedback_dev_plan_trigger_deterministic.md for the incident that prompted this (issue #75:
// "dev plan - #75" was treated as generic instruction instead of a skill trigger).

const fs = require("fs");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const raw = readStdin();
let data = {};
try {
  data = raw ? JSON.parse(raw) : {};
} catch {
  data = {};
}

const prompt = String(data.prompt ?? data.user_prompt ?? data.message ?? "");
const lower = prompt.toLowerCase();

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

function anyMatch(list) {
  return list.some((phrase) => lower.includes(phrase));
}

let skill = null;
if (anyMatch(DEV_PLAN_TRIGGERS)) {
  skill = "rushcut-dev-plan";
} else if (anyMatch(WRAPUP_TRIGGERS)) {
  skill = "rushcut-wrapup";
}

if (!skill) {
  process.exit(0);
}

const additionalContext =
  `MANDATORY (hook-enforced, not optional): this message contains a trigger phrase for the ` +
  `"${skill}" skill. Your very first action this turn MUST be calling the Skill tool with ` +
  `skill: "${skill}" -- before any other reasoning, tool call, or Plan Mode entry. Do not ` +
  `substitute an ad-hoc manual flow (e.g. generic Plan Mode with Explore/Plan agents) even if ` +
  `you believe it is equivalent: the skill's own step machinery (including any auto-invoked ` +
  `QA/verification step) only runs when the skill itself is invoked.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  })
);
