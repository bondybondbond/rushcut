#!/usr/bin/env node
// PreToolUse hook: blocks `git commit` (via Bash or PowerShell) when a currently-staged file
// matches a forbidden pattern from rushcut-wrapup SKILL.md Step 6's "never commit" list
// (.env/.env.local, spike/tmp/, spike/output*, C:/clips/, credentials, private keys).
//
// Checks the real git index (`git diff --cached --name-only`) rather than the command string,
// so `git add -A` / `git add .` are still caught even though the command itself never names
// the file. Fails open on any git error (not a repo, git not on PATH, nothing staged) -- this
// is a safety net for an accidental commit, not a build gate, so an environment problem should
// never block a legitimate commit.
//
// Uses execFileSync (no shell) rather than exec/execSync -- no argument is ever passed through
// a shell, so there is no injection surface even though the args here are hardcoded anyway.
//
// Escape hatch (intentionally not an EXEMPT_TOOLS bypass): `git reset HEAD -- <file>` unstages
// without ever matching the `git commit` regex below, so the gate stays satisfiable.

const fs = require("fs");
const { execFileSync } = require("child_process");
const { forbiddenHits } = require("./lib/secret-guard");

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
const command = String((data.tool_input && data.tool_input.command) ?? "");

if (toolName !== "Bash" && toolName !== "PowerShell") {
  process.exit(0);
}

if (!/git\s+commit/i.test(command)) {
  process.exit(0);
}

let staged;
try {
  staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" });
} catch {
  process.exit(0); // not a repo, git missing, or nothing staged -- fail open
}

const files = staged
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

const hits = forbiddenHits(files);
if (hits.length === 0) {
  process.exit(0);
}

const list = hits.map((h) => `${h.path} (matches: ${h.pattern})`).join(", ");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): staged file(s) match a forbidden commit pattern from ` +
        `rushcut-wrapup Step 6's "never commit" list: ${list}. Unstage with ` +
        `"git reset HEAD -- <file>" if this was accidental, or confirm with the user this is ` +
        `intentional before retrying.`,
    },
  })
);
