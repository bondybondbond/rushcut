#!/usr/bin/env node
// Registered in .claude/settings.json 2026-07-23; this edit is the live self-lockout check
// (confirms Edit still works on this exempt path once the hook is actually wired in).
// PreToolUse hook: hard gate ensuring rushcut-dev-plan's search-required and approval-required
// checkpoints actually happened -- with PROOF (real tool_use evidence read from a subagent's own
// transcript, plus a structural VERDICT marker in its relayed result), not just "the agent was
// spawned" (see enforce-pp-auditor-spawn.js, which only checks that) or a self-reported claim.
//
// Origin: 2026-07-23, after the maintainer discovered a session shipped (#103/#148/#149) with no
// mechanical proof that required grounding research actually happened. docs/LEARNINGS.md already
// documents a near-identical prior gap ("a subagent round type... is not real until an invoking
// skill actually calls it"). This hook closes both: it doesn't trust prose in an agent file or a
// narrative claim by the orchestrator -- it re-derives proof from the transcript on every call,
// mirroring enforce-skill-gate.js / enforce-pp-auditor-spawn.js's established pattern.
//
// Blocks: Edit / Write, during an active rushcut-dev-plan session, unless:
//   (a) >=2 completed rushcut-real-pp-auditor spawns since dev-plan start each show real evidence
//       (either genuinely reached Perplexity, or genuinely tried and were blocked by an
//       unavailable Chrome -- with a documented pp-consultant fallback after it), AND
//   (b) the MOST RECENT completed rushcut-pp-consultant spawn since dev-plan start rendered
//       "VERDICT: APPROVE" specifically -- not just any marker (plan-approval gate; no search
//       evidence required here, per design). Value and recency both matter, not presence alone
//       -- see docs/LEARNINGS.md "mechanically verifying a subagent's real tool-call execution."
//
// Scope: only Step 6 (implementation). Once Skill(rushcut-wrapup) has been called in this
// transcript, this gate stops applying -- see the check right after skillIdx below.
//
// Permanent structural exemption (not a temporary bypass -- this is the correct permanent scope
// of the gate): editing the gate's OWN machinery must never be gated by the gate itself, or
// fixing/extending it becomes circular by construction. Scoped narrowly to exactly the files that
// ARE this dev-tooling machinery -- never product code, never docs, never wrapup.

const fs = require("fs");
const path = require("path");
const {
  findLastMatchingSkillCall,
  findAgentSpawnsSince,
  resolveAgentSpawn,
  countGateCycles,
  latestVerdict,
} = require("./lib/transcript");

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

const GATED_TOOLS = new Set(["Edit", "Write"]);
if (!GATED_TOOLS.has(toolName) || !transcriptPath) {
  process.exit(0);
}

// Exemption is a PRINCIPLED TWO-CATEGORY split, not a growing per-file allowlist (fixed
// 2026-07-24 after the exempt list grew 6->8->9 files in three consecutive gate-hits during this
// same session -- flagged directly as "this is exactly how bypasses accrete: one 'obvious'
// exception at a time until the gate has more holes than fence"). The principle, not just the
// list, is what future sessions must preserve:
//
//   (1) META-TOOLING (exact files, frozen) -- editing the gate's own machinery must never be
//       gated by the gate itself, or fixing/extending it becomes circular by construction. This
//       set does not grow casually; adding to it means widening what "is the gate" means.
//   (2) DOCUMENTATION (a directory category, `docs/**`) -- writing ABOUT a change is not
//       IMPLEMENTING one. The gate's purpose is to require grounding before product code changes
//       (`src/**`, `pipeline/**`, `src-tauri/**`), not to block someone from taking notes on what
//       already happened. This is a category, not a file list, precisely so it never needs
//       another one-off addition + AskUserQuestion round the next time a docs file needs editing.
//
// `.gitignore` and `CLAUDE.md` are root-level project config/instructions, not under `docs/`, so
// they stay in the exact-file set below (deliberately small, not meant to keep growing) rather
// than being folded into the directory category.
const EXEMPT_FILES = [
  "/.claude/agents/rushcut-real-pp-auditor.md",
  "/.claude/agents/rushcut-pp-consultant.md",
  "/.claude/hooks/enforce-pp-plan-gates.js",
  "/.claude/hooks/enforce-pp-wrapup-signoff.js",
  "/.claude/hooks/lib/transcript.js",
  "/.claude/hooks/lib/transcript.test.js",
  "/.claude/settings.json",
  "/.gitignore",
  "/CLAUDE.md",
];
const EXEMPT_PREFIXES = ["/docs/"];

const filePath = String(toolInput.file_path || "");
const normalized = filePath.replace(/\\/g, "/").toLowerCase();
const isExemptExact = EXEMPT_FILES.some((exact) => {
  const s = exact.toLowerCase();
  return normalized.endsWith(s) || normalized === s.slice(1); // absolute-path suffix, or bare relative match
});
const isExemptPrefix = EXEMPT_PREFIXES.some((prefix) => {
  const p = prefix.toLowerCase();
  return normalized.includes(p) || normalized.startsWith(p.slice(1)); // anywhere under it, absolute or bare relative
});
if (isExemptExact || isExemptPrefix) {
  process.exit(0);
}

let lines;
try {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  lines = raw.length ? raw.split("\n").filter(Boolean) : [];
} catch {
  process.exit(0); // fail open -- can't read the transcript, don't block on a guess
}

const skillIdx = findLastMatchingSkillCall(lines, "rushcut-dev-plan");
if (skillIdx === -1) {
  process.exit(0); // no active dev-plan session in this transcript -- this gate doesn't apply
}

// This gate's purpose is Step 6 (implementation) specifically -- once Skill(rushcut-wrapup) has
// been called, the session has moved past implementation into docs/cleanup/commit, which needs
// no grounding-search proof of its own (it's downstream of already-gated implementation, and
// separately gated by enforce-pp-wrapup-signoff.js requiring its own sign-off to even start).
// Discovered live (2026-07-23): without this check, a dev-tooling-only session whose gates 1-2
// legitimately never produced product-implementation evidence (nothing to ground -- no product
// code was touched) got its own wrapup's LEARNINGS.md edit blocked by this same hook, which is
// not what "requires grounding before implementation" was ever meant to cover.
if (findLastMatchingSkillCall(lines, "rushcut-wrapup") > skillIdx) {
  process.exit(0);
}

const AUDITOR = "rushcut-real-pp-auditor";
const CONSULTANT = "rushcut-pp-consultant";

// Each real gate (1-4) requires its own proven type(fingerprint)->submit->new-read cycle, not
// just "some browser tool fired" -- see countGateCycles in lib/transcript.js. Each auditor spawn
// is supposed to cover 2 gates (1-2 at Step 0, 3-4 at Step 5a.5), so a spawn is only satisfied
// once it proves >=2 distinct gates within its own transcript -- tightened 2026-07-24 after
// external audit found the presence-only check could pass on a homepage read or an unsubmitted
// typed query.
const GATES_PER_SPAWN = 2;

const auditorSpawns = findAgentSpawnsSince(lines, skillIdx, AUDITOR).map((s) => ({
  ...s,
  resolved: resolveAgentSpawn(lines, s),
}));
const consultantSpawns = findAgentSpawnsSince(lines, skillIdx, CONSULTANT).map((s) => ({
  ...s,
  resolved: resolveAgentSpawn(lines, s),
}));

let satisfiedAuditorCount = 0;
for (const spawn of auditorSpawns) {
  if (!spawn.resolved || !spawn.resolved.complete) continue;
  const { provenGates, triedBlocked } = countGateCycles(transcriptPath, spawn.resolved.agentId);
  if (provenGates.size >= GATES_PER_SPAWN) {
    satisfiedAuditorCount++;
  } else if (triedBlocked) {
    // Legitimate fallback: Chrome genuinely unavailable, confirmed via list_connected_browsers
    // with nothing after -- only counts if a pp-consultant spawn exists after this point, per
    // the documented Step 0 fallback (SKILL.md: "fall back to rushcut-pp-consultant... note the
    // gap").
    const fallbackExists = consultantSpawns.some((c) => c.spawnIndex > spawn.spawnIndex);
    if (fallbackExists) satisfiedAuditorCount++;
  }
}

// Value AND recency matter, not just marker presence (rushcut-pp-consultant's own Round 4
// review, 2026-07-23: a stale or unrelated-round marker, or an unresolved OBJECTION, must not
// satisfy a gate whose entire point is requiring actual approval of the LATEST round).
const consultantApproved = latestVerdict(lines, consultantSpawns) === "APPROVE";

const missing = [];
if (satisfiedAuditorCount < 2) {
  missing.push(
    `real-Perplexity grounding evidence: ${satisfiedAuditorCount}/2 rushcut-real-pp-auditor spawns proven ` +
      `(each needs >=${GATES_PER_SPAWN} proven gate-submission cycles -- a fingerprinted query typed on ` +
      `Perplexity, an actual submit transition, and a genuinely new post-submit read -- not just any browser ` +
      `tool call; or a genuine tried-and-blocked Chrome-unavailable case with a rushcut-pp-consultant fallback ` +
      `after it). Spawn rushcut-real-pp-auditor ` +
      `again to run the missing gate(s) before editing implementation files.`
  );
}
if (!consultantApproved) {
  missing.push(
    `plan-approval sign-off: the most recent completed rushcut-pp-consultant spawn since dev-plan start did ` +
      `not render "VERDICT: APPROVE" (either no spawn yet, no marker, or the latest verdict was ` +
      `OBJECTION/DECLINE-OUT-OF-SCOPE). Spawn rushcut-pp-consultant (Round 2 -- plan critique), resolve any ` +
      `objection, and ensure its final response ends with "VERDICT: APPROVE" before editing implementation files.`
  );
}

if (missing.length === 0) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `BLOCKED (hook-enforced): rushcut-dev-plan requires provable grounding + plan-approval before ` +
        `implementation edits, per .claude/skills/rushcut-dev-plan/SKILL.md. Missing: ${missing.join(" | ")} ` +
        `(Note: tool-call evidence is a floor, not a ceiling -- it proves real interaction happened, not that ` +
        `it was thorough.)`,
    },
  })
);
