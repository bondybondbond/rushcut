#!/usr/bin/env node
// Lightweight regression tests for the search-verification gate helpers in transcript.js.
// Mirrors the project's existing lightweight-script test pattern (see
// pipeline/_test_clipitem_splice.py) -- no external test framework, run manually via
// `node .claude/hooks/lib/transcript.test.js`, not wired into CI. Exists specifically because
// countGateCycles()/latestVerdict() implement the mechanical proof this session's gates depend
// on; a synthetic-but-schema-accurate fixture proves the logic without needing a live Perplexity
// session to run every time.
//
// Fixture schema notes (all reverse-engineered from real transcripts this session, not assumed):
// - Main transcript: `type:"assistant"` entries carry `message.content[]` tool_use blocks; the
//   matching `type:"user"` entry has `message.content[]` with a `tool_result` block (matching
//   `tool_use_id`) AND a top-level `toolUseResult` object carrying `agentId`/`isAsync`/`content`.
// - Async completion: a `type:"queue-operation"`, `operation:"enqueue"` entry whose `content`
//   string contains `<task-id>AGENTID</task-id>...<status>completed</status>...<result>...</result>`.
// - Subagent's own transcript (a separate file): same `assistant`/`user` shape for its own tool
//   calls, but tool_result blocks carry `content` directly (string or array of `{type:"text"}`).

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  findAgentSpawnsSince,
  resolveAgentSpawn,
  countGateCycles,
  latestVerdict,
} = require("./transcript");

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rushcut-transcript-test-"));
let counter = 0;
function jsonl(entries) {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
// Every call site already builds an absolute path (via scratchDir) before calling this -- do
// not re-join with scratchDir, or an absolute 2nd path segment gets nonsensically nested.
function writeFile(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  return absPath;
}
function nextId(prefix) {
  counter++;
  return `${prefix}${counter}`;
}

// --- Fixture builders ---

function toolUse(name, input, id) {
  return { type: "tool_use", id, name, input };
}

function assistantEntry(blocks) {
  return { type: "assistant", message: { role: "assistant", content: blocks } };
}

// Builds a subagent's own transcript from a list of { name, input, resultText } tool calls.
function buildSubagentTranscript(calls) {
  const lines = [];
  for (const call of calls) {
    const id = nextId("toolu_");
    lines.push(assistantEntry([toolUse(call.name, call.input, id)]));
    lines.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: call.resultText ?? "" }] },
    });
  }
  return jsonl(lines);
}

// Sets up a main transcript + subagent transcript pair for one Agent spawn (sync, since
// pp-consultant is commonly sync; async is exercised separately below for latestVerdict).
function setupSyncSpawn(sessionDir, subagentType, agentId, resultText, subagentCalls = []) {
  const toolUseId = nextId("toolu_");
  const mainLines = [
    assistantEntry([toolUse("Agent", { subagent_type: subagentType, run_in_background: false }, toolUseId)]),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      toolUseResult: { status: "completed", agentId, content: [{ type: "text", text: resultText }] },
    },
  ];
  writeFile(path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`), buildSubagentTranscript(subagentCalls));
  return mainLines;
}

function setupAsyncSpawn(sessionDir, subagentType, agentId, resultText, subagentCalls = []) {
  const toolUseId = nextId("toolu_");
  const mainLines = [
    assistantEntry([toolUse("Agent", { subagent_type: subagentType, run_in_background: true }, toolUseId)]),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      toolUseResult: { isAsync: true, status: "async_launched", agentId, outputFile: "irrelevant.output" },
    },
    {
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>${resultText}</result>\n</task-notification>`,
    },
  ];
  writeFile(path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`), buildSubagentTranscript(subagentCalls));
  return mainLines;
}

function transcriptPathFor(sessionDir) {
  return sessionDir + ".jsonl"; // sibling to the <sessionDir>/ folder, matching the real convention
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}\n  ${err.message}`);
  }
}

// --- Gate-cycle fixtures ---

const GATE1_TYPE = "thoughts? see github - issue 999@GitHub. Does this user story actually capture what a real user needs here? Is this solving a real pain point?";
const GATE2_TYPE = "thoughts? the problem. Search for how DaVinci Resolve, CapCut, Premiere Pro handle this. What's their approach?";
const REAL_ANSWER_1 = "A".repeat(600) + " -- direct answer about the JTBD framing, this is a genuinely new synthesized response from Perplexity covering the user story angle in detail.";
const REAL_ANSWER_2 = "B".repeat(600) + " -- a completely different synthesized answer about competitor research, DaVinci and CapCut approaches discussed at length here.";

function twoFullCycleCalls() {
  return [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://www.perplexity.ai/spaces/rushcut" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE1_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE2_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ].map((c) => ({ ...c, resultText: c.resultText ?? "" }));
}

// Each fixture gets its own explicit agentId, used consistently for both writing the subagent
// transcript file and reading it back via countGateCycles -- no derived/implicit naming.
function writeSpawnFixture(sessionLabel, agentId, calls) {
  const sessionDir = path.join(scratchDir, `${sessionLabel}-session`);
  writeFile(path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`), buildSubagentTranscript(calls));
  return sessionDir;
}

test("2-cycle spawn: both gates proven", () => {
  const dir = writeSpawnFixture("two-cycle", "agentTwoCycle", twoFullCycleCalls());
  const result = countGateCycles(transcriptPathFor(dir), "agentTwoCycle");
  assert.strictEqual(result.provenGates.size, 2, `expected 2 proven gates, got ${result.provenGates.size}`);
  assert.ok(result.provenGates.has(1) && result.provenGates.has(2));
});

test("1-cycle spawn: only 1 gate proven when 2nd type/submit/read never happens", () => {
  const calls = twoFullCycleCalls().slice(0, 4); // only gate 1's cycle
  const dir = writeSpawnFixture("one-cycle", "agentOneCycle", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentOneCycle");
  assert.strictEqual(result.provenGates.size, 1);
  assert.ok(result.provenGates.has(1));
});

test("type without submit: read after type-but-no-submit does not prove the gate", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://www.perplexity.ai/spaces/rushcut" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE1_TYPE } },
    // no submit action here -- read happens directly after typing, query never submitted
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
  ];
  const dir = writeSpawnFixture("no-submit", "agentNoSubmit", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentNoSubmit");
  assert.strictEqual(result.provenGates.size, 0, "a read with no prior submit must not prove a gate");
});

test("submit without new content: stale/homepage re-read does not prove the gate", () => {
  const STALE = "C".repeat(600) + " homepage boilerplate text that never changes across reads.";
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://www.perplexity.ai/spaces/rushcut" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: STALE }, // initial setup read
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE1_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: STALE }, // same content again -- stale
  ];
  const dir = writeSpawnFixture("stale-read", "agentStale", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentStale");
  assert.strictEqual(result.provenGates.size, 0, "a stale re-read (same as a prior read) must not prove a gate");
});

test("textsSimilar edge case: shared boilerplate prefix but substantially longer new content still proves the gate", () => {
  // Guards against the false-negative risk rushcut-pp-consultant flagged: if PP's own answers
  // share a templated opening ("## Direct answer\n\n..."), a genuinely NEW answer must not be
  // misclassified as stale just because of a shared heading -- the length delta should save it.
  const BOILERPLATE_PREFIX = "## Direct answer\n\nThis response follows the standard structure. ";
  const FIRST_READ = BOILERPLATE_PREFIX + "D".repeat(310); // setup/model-check read, ~360 chars
  const SECOND_READ = BOILERPLATE_PREFIX + "E".repeat(900); // genuinely new, much longer answer
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://www.perplexity.ai/spaces/rushcut" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: FIRST_READ },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE1_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: SECOND_READ },
  ];
  const dir = writeSpawnFixture("boilerplate-prefix", "agentBoilerplate", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentBoilerplate");
  assert.strictEqual(result.provenGates.size, 1, "a substantially longer new answer must prove the gate despite a shared opening prefix");
});

test("triedBlocked: exactly 1 event (list_connected_browsers only) is the fail-fast case", () => {
  const calls = [{ name: "mcp__claude-in-chrome__list_connected_browsers", input: {}, resultText: "[]" }];
  const dir = writeSpawnFixture("chrome-unavailable", "agentBlocked", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentBlocked");
  assert.strictEqual(result.triedBlocked, true);
  assert.strictEqual(result.provenGates.size, 0);
});

test("triedBlocked: a genuinely-attempted-but-interrupted spawn is NOT tried-blocked", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__list_connected_browsers", input: {}, resultText: "[{ok:true}]" },
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://www.perplexity.ai/spaces/rushcut" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: GATE1_TYPE } },
    // interrupted here -- no submit, no read, spawn just stopped
  ];
  const dir = writeSpawnFixture("interrupted", "agentInterrupted", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentInterrupted");
  assert.strictEqual(result.triedBlocked, false, "an interrupted-but-attempted spawn must not silently pass as Chrome-unavailable");
  assert.strictEqual(result.provenGates.size, 0);
});

// --- latestVerdict / Gate 3 process fixtures ---

test("Gate 3 process: OBJECTION blocks, a LATER APPROVE spawn unblocks", () => {
  const sessionDir = path.join(scratchDir, "gate3-session");
  let lines = [];
  lines = lines.concat(setupSyncSpawn(sessionDir, "rushcut-pp-consultant", "agentObjection", "Full critique text.\n\nVERDICT: OBJECTION"));
  const mainPathAfterObjection = writeFile(sessionDir + ".jsonl", jsonl(lines));
  const linesAfterObjection = fs.readFileSync(mainPathAfterObjection, "utf8").split("\n").filter(Boolean);
  const spawnsAfterObjection = findAgentSpawnsSince(linesAfterObjection, -1, "rushcut-pp-consultant");
  assert.strictEqual(latestVerdict(linesAfterObjection, spawnsAfterObjection), "OBJECTION", "latest verdict should be OBJECTION -- Edit/Write must be blocked here");

  // A later, distinct spawn re-reviewing the fixed plan approves it.
  lines = lines.concat(setupSyncSpawn(sessionDir, "rushcut-pp-consultant", "agentApprove", "Re-reviewed the fix.\n\nVERDICT: APPROVE"));
  const mainPathAfterApprove = writeFile(sessionDir + ".jsonl", jsonl(lines));
  const linesAfterApprove = fs.readFileSync(mainPathAfterApprove, "utf8").split("\n").filter(Boolean);
  const spawnsAfterApprove = findAgentSpawnsSince(linesAfterApprove, -1, "rushcut-pp-consultant");
  assert.strictEqual(latestVerdict(linesAfterApprove, spawnsAfterApprove), "APPROVE", "latest verdict should flip to APPROVE after the later spawn -- Edit/Write may now proceed");
});

test("resumed spawn: a SendMessage-style later completion supersedes the stale first one", () => {
  const sessionDir = path.join(scratchDir, "resume-session");
  const agentId = "agentResumed";
  const toolUseId = nextId("toolu_");
  const lines = [
    assistantEntry([toolUse("Agent", { subagent_type: "rushcut-pp-consultant", run_in_background: false }, toolUseId)]),
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId }] },
      toolUseResult: { status: "completed", agentId, content: [{ type: "text", text: "Interrupted mid-task.\n\nVERDICT: OBJECTION" }] },
    },
    {
      type: "queue-operation",
      operation: "enqueue",
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<result>Resumed and fixed.\n\nVERDICT: APPROVE</result>\n</task-notification>`,
    },
  ];
  writeFile(path.join(sessionDir, "subagents", `agent-${agentId}.jsonl`), buildSubagentTranscript([]));
  const mainPath = writeFile(sessionDir + ".jsonl", jsonl(lines));
  const readLines = fs.readFileSync(mainPath, "utf8").split("\n").filter(Boolean);
  const spawns = findAgentSpawnsSince(readLines, -1, "rushcut-pp-consultant");
  const resolved = resolveAgentSpawn(readLines, spawns[0]);
  assert.ok(resolved.resultText.includes("VERDICT: APPROVE"), "must resolve to the LATER completion, not the stale first one");
  assert.ok(!resolved.resultText.includes("Interrupted mid-task"));
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
