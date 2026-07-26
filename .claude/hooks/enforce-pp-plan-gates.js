#!/usr/bin/env node
// PreToolUse hook: hard gate ensuring rushcut-dev-plan's Gate 2 (competitor/context research) and
// Gate 3 (plan + traps, Perplexity, CPO verdict) checkpoints actually happened -- with PROOF (real
// tool_use evidence read from a subagent's own transcript, plus a structural VERDICT marker in the
// CPO's relayed result), not just "the agent was spawned" or a self-reported claim.
//
// Rewritten 2026-07-24 (issue #156, CPO/Consultant/CC 3-role redesign) -- replaces the old
// 4-gate rushcut-real-pp-auditor + rushcut-pp-consultant dual-spawn shape. New shape, per
// docs/agent_plan.md:
//   Gate 1 (JTBD) -- CPO only, no search, enforced separately by enforce-cpo-gate1-spawn.js.
//   Gate 2 (competitor/context) -- rushcut-pp-consultant, Claude WebSearch only, >=3 distinct
//     queries spanning >=2 source types (see countWebSearchDiversity in lib/transcript.js).
//   Gate 3 (plan + traps) -- rushcut-pp-consultant, ONE Perplexity spawn, TWO sequential queries
//     (breadth then depth) in the same thread, findings mapped to the plan and written to a
//     scratch file; rushcut-cpo then reads that file and renders the actual VERDICT.
//
// Origin of the underlying "prove it, don't trust prose" approach: 2026-07-23, after the
// maintainer discovered a session shipped (#103/#148/#149) with no mechanical proof that required
// grounding research actually happened. This hook still doesn't trust prose in an agent file or a
// narrative claim by the orchestrator -- it re-derives proof from the transcript on every call.
//
// Blocks: Edit / Write, during an active rushcut-dev-plan session, unless:
//   (a) a completed rushcut-pp-consultant spawn since dev-plan start proves Gate 2 (>=3 distinct
//       WebSearch queries, >=2 source types) -- OR a genuine tried-and-blocked Chrome-unavailable
//       Gate 3 case exists with the documented WebSearch fallback noted, AND
//   (b) a completed rushcut-pp-consultant spawn proves Gate 3 (both "breadth" and "depth" query
//       cycles against real Perplexity, via the same type->submit->new-read proof as before), AND
//   (c) the MOST RECENT completed rushcut-cpo spawn since dev-plan start rendered "VERDICT:
//       APPROVE" specifically -- not just any marker. Value and recency both matter, not presence
//       alone -- see docs/LEARNINGS.md "mechanically verifying a subagent's real tool-call
//       execution."
//
// Scope: only Step 6 (implementation). Once Skill(rushcut-wrapup) has been called in this
// transcript, this gate stops applying -- see the check right after skillIdx below.
//
// Permanent structural exemption (not a temporary bypass -- this is the correct permanent scope
// of the gate): editing the gate's OWN machinery must never be gated by the gate itself, or
// fixing/extending it becomes circular by construction. Scoped narrowly to exactly the files that
// ARE this dev-tooling machinery -- never product code, never docs, never workflow-skill-definition
// files, never wrapup.

const fs = require("fs");
const path = require("path");
const {
  findLastMatchingSkillCall,
  findAgentSpawnsSince,
  resolveAgentSpawn,
  countGateCycles,
  countWebSearchDiversity,
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
  "/.claude/agents/rushcut-cpo.md",
  "/.claude/agents/rushcut-pp-consultant.md",
  "/.claude/hooks/enforce-cpo-gate1-spawn.js",
  "/.claude/hooks/enforce-pp-plan-gates.js",
  "/.claude/hooks/enforce-pp-wrapup-signoff.js",
  "/.claude/hooks/lib/transcript.js",
  "/.claude/hooks/lib/transcript.test.js",
  "/.claude/settings.json",
  "/.gitignore",
  "/CLAUDE.md",
];
// `.claude/skills/**` added 2026-07-24 (#156): editing a SKILL.md file is workflow-definition
// work, not product-code implementation -- same category rationale as `docs/**` below. Without
// this, mid-migration edits to rushcut-dev-plan/SKILL.md or rushcut-wrapup/SKILL.md (required by
// #156's own rollout, since both are being renumbered in the same atomic change as the agent/hook
// rename) would risk a circular self-lockout (flagged by rushcut-pp-consultant's Round 2 review).
const EXEMPT_PREFIXES = ["/docs/", "/.claude/skills/"];

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

const CONSULTANT = "rushcut-pp-consultant";
const CPO = "rushcut-cpo";

// Minimum diversity required for Gate 2, per rushcut-pp-consultant.md's own stated bar.
const MIN_WEBSEARCH_QUERIES = 3;
const MIN_SOURCE_TYPES = 2;

const consultantSpawns = findAgentSpawnsSince(lines, skillIdx, CONSULTANT).map((s) => ({
  ...s,
  resolved: resolveAgentSpawn(lines, s),
}));
const cpoSpawns = findAgentSpawnsSince(lines, skillIdx, CPO).map((s) => ({
  ...s,
  resolved: resolveAgentSpawn(lines, s),
}));

// Gate 2: any completed Consultant spawn proving >=3 distinct WebSearch queries spanning >=2
// source types, within that spawn's own transcript.
let gate2Satisfied = false;
for (const spawn of consultantSpawns) {
  if (!spawn.resolved || !spawn.resolved.complete) continue;
  const { count, sourceTypes } = countWebSearchDiversity(transcriptPath, spawn.resolved.agentId);
  if (count >= MIN_WEBSEARCH_QUERIES && sourceTypes.size >= MIN_SOURCE_TYPES) {
    gate2Satisfied = true;
    break;
  }
}

// Gate 3: any completed Consultant spawn proving BOTH the "breadth" and "depth" Perplexity query
// cycles (type(fingerprint)->submit->new-read, per countGateCycles), or a genuine tried-blocked
// Chrome-unavailable case (Consultant's own documented WebSearch fallback for Gate 3).
let gate3Satisfied = false;
for (const spawn of consultantSpawns) {
  if (!spawn.resolved || !spawn.resolved.complete) continue;
  const { provenGates, triedBlocked } = countGateCycles(transcriptPath, spawn.resolved.agentId);
  if (provenGates.has("breadth") && provenGates.has("depth")) {
    gate3Satisfied = true;
    break;
  }
  if (triedBlocked) {
    gate3Satisfied = true;
    break;
  }
}

// CPO's Gate 3 VERDICT is the actual approval -- Consultant only researches, never approves.
// Value AND recency matter, not just marker presence (a stale or unrelated-round marker, or an
// unresolved OBJECTION, must not satisfy a gate whose entire point is requiring actual approval
// of the LATEST round).
const cpoApproved = latestVerdict(lines, cpoSpawns) === "APPROVE";

const missing = [];
if (!gate2Satisfied) {
  missing.push(
    `Gate 2 (competitor/context research): no completed rushcut-pp-consultant spawn proves >=${MIN_WEBSEARCH_QUERIES} ` +
      `distinct WebSearch queries spanning >=${MIN_SOURCE_TYPES} source types. Spawn rushcut-pp-consultant to run Gate 2 ` +
      `before editing implementation files.`
  );
}
if (!gate3Satisfied) {
  missing.push(
    `Gate 3 (plan + traps): no completed rushcut-pp-consultant spawn proves both the breadth and depth Perplexity ` +
      `query cycles (a fingerprinted query typed on Perplexity, an actual submit transition, and a genuinely new ` +
      `post-submit read -- not just any browser tool call), and no genuine tried-and-blocked Chrome-unavailable ` +
      `case was found either. Spawn rushcut-pp-consultant to run Gate 3 before editing implementation files.`
  );
}
if (!cpoApproved) {
  missing.push(
    `Gate 3 sign-off: the most recent completed rushcut-cpo spawn since dev-plan start did not render ` +
      `"VERDICT: APPROVE" (either no spawn yet, no marker, or the latest verdict was OBJECTION/DECLINE-OUT-OF-SCOPE). ` +
      `Spawn rushcut-cpo to read Consultant's Gate 3 findings-mapping file and render a verdict ending in ` +
      `"VERDICT: APPROVE" before editing implementation files.`
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
