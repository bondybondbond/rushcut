// Shared state helper for the two-layer skill-trigger enforcement:
// UserPromptSubmit (enforce-skill-trigger.js) arms the gate; PreToolUse
// (enforce-skill-gate.js) blocks every tool call except Skill/AskUserQuestion
// until the correct Skill is invoked. State is per-session (keyed by
// session_id) so concurrent sessions in this repo never interfere.
//
// Fail-open by design: EXPIRY_MS / MAX_ATTEMPTS guarantee a bug or edge case
// can never wedge a session -- worst case is a few denied tool calls, never
// a permanent block.

const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "..", ".state");
const EXPIRY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const VACUUM_AGE_MS = 60 * 60 * 1000;

function stateFile(sessionId) {
  return path.join(STATE_DIR, `gate-${sessionId}.json`);
}

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function vacuum() {
  ensureDir();
  const now = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(STATE_DIR);
  } catch {
    return;
  }
  for (const f of entries) {
    const p = path.join(STATE_DIR, f);
    try {
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > VACUUM_AGE_MS) fs.unlinkSync(p);
    } catch {
      // already gone or unreadable -- ignore
    }
  }
}

function arm(sessionId, skill) {
  ensureDir();
  fs.writeFileSync(
    stateFile(sessionId),
    JSON.stringify({ skill, armedAt: Date.now(), attempts: 0 })
  );
}

function read(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return null;
  }
}

function clear(sessionId) {
  try {
    fs.unlinkSync(stateFile(sessionId));
  } catch {
    // already cleared -- ignore
  }
}

function bumpAttempt(sessionId, data) {
  data.attempts = (data.attempts || 0) + 1;
  try {
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(data));
  } catch {
    // best-effort -- if this fails, isExpired's time-based check still saves us
  }
}

function isExpired(data) {
  return Date.now() - data.armedAt > EXPIRY_MS || (data.attempts || 0) >= MAX_ATTEMPTS;
}

module.exports = { arm, read, clear, vacuum, isExpired, bumpAttempt };
