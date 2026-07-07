#!/usr/bin/env node
// UserPromptSubmit hook: soft hint only. The actual enforcement lives entirely in
// enforce-skill-gate.js (PreToolUse), which independently re-derives the trigger match from
// the transcript on every tool call -- no shared state file, no cross-hook race. An earlier
// version of this hook wrote a state file that enforce-skill-gate.js read; that had a
// cross-process write/read race (see docs/LEARNINGS.md). This hook's only remaining job is to
// inject a helpful nudge into the model's context immediately, so it ideally never sees the
// deny at all.

const fs = require("fs");
const { detectSkill } = require("./lib/trigger-match");

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

const prompt = String(data.prompt ?? data.user_prompt ?? data.message ?? "");
const skill = detectSkill(prompt);

if (!skill) {
  process.exit(0);
}

const additionalContext =
  `MANDATORY: this message contains a trigger phrase for the "${skill}" skill. Your very ` +
  `first action this turn MUST be calling the Skill tool with skill: "${skill}" -- before ` +
  `any other reasoning, tool call, or Plan Mode entry. This is also hard-enforced by a ` +
  `PreToolUse hook that will deny every other tool call until this Skill call happens -- it ` +
  `independently re-derives this same trigger match from the transcript, so acting now avoids ` +
  `a denied first attempt.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  })
);
