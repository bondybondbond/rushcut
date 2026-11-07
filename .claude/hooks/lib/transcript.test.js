#!/usr/bin/env node
// Lightweight regression tests for the search-verification gate helpers in transcript.js.
// Mirrors the project's existing lightweight-script test pattern (see
// pipeline/_test_clipitem_splice.py) -- no external test framework, run manually via
// `node .claude/hooks/lib/transcript.test.js`, not wired into CI. Exists specifically because
// countGateCycles()/latestVerdict() implement the mechanical proof this session's gates depend
// on; a synthetic-but-schema-accurate fixture proves the logic without needing a live ChatGPT
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
  extractVerdict,
  countWebSearchDiversity,
  CHROME_SETUP_SHAPES,
  isChromeSetupCommand,
  isScratchPowerShell,
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
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: call.resultText ?? "", ...(call.isError ? { is_error: true } : {}) }],
      },
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

// Fingerprint text must match GATE_FINGERPRINTS.breadth/.depth in transcript.js verbatim --
// these are Gate 3's two sequential queries (breadth then depth), not the old 4-gate model's
// per-gate templates.
const BREADTH_TYPE =
  "Search developer communities, official documentation, GitHub issues, and Stack Overflow for prior art on this problem.";
const DEPTH_TYPE = "Here is an implementation plan summary -- does this hold up against real-world traps?";
const REAL_ANSWER_1 = "A".repeat(600) + " -- direct answer about the breadth query, this is a genuinely new synthesized response from ChatGPT covering prior art in detail.";
const REAL_ANSWER_2 = "B".repeat(600) + " -- a completely different synthesized answer about the plan-fit depth query, traps and implementation risk discussed at length here.";

function twoFullCycleCalls() {
  return [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: DEPTH_TYPE } },
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
  assert.ok(result.provenGates.has("breadth") && result.provenGates.has("depth"));
});

test("1-cycle spawn: only 1 gate proven when 2nd type/submit/read never happens", () => {
  const calls = twoFullCycleCalls().slice(0, 4); // only the breadth cycle
  const dir = writeSpawnFixture("one-cycle", "agentOneCycle", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentOneCycle");
  assert.strictEqual(result.provenGates.size, 1);
  assert.ok(result.provenGates.has("breadth"));
});

test("type without submit: read after type-but-no-submit does not prove the gate", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
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
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: STALE }, // initial setup read
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
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
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: FIRST_READ },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: SECOND_READ },
  ];
  const dir = writeSpawnFixture("boilerplate-prefix", "agentBoilerplate", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentBoilerplate");
  assert.strictEqual(result.provenGates.size, 1, "a substantially longer new answer must prove the gate despite a shared opening prefix");
});

test("textsSimilar: two large read_page dumps within 10% length + identical nav-chrome prefix but different bodies both prove (real #170 case, 2026-08-28)", () => {
  // Real regression: successive `read_page` accessibility dumps of ChatGPT are ~30K chars,
  // land within 10% length of each other, and share an identical leading nav-chrome block, so
  // prefix-only textsSimilar() falsely flagged the depth read as a stale re-read and the 2nd
  // gate never proved. Suffix matching distinguishes them: different answers diverge in the tail.
  const NAV_CHROME = 'link "Skip to content" [ref_1] href="#main"\nnavigation "Sidebar" [ref_2]\n button "Open sidebar" [ref_3]\n link [ref_4] href="/"\n  generic "New chat" [ref_5]\n'.padEnd(400, " ");
  const BREADTH_ANSWER = NAV_CHROME + "X".repeat(29000) + " breadth answer: prior art on WebView2 isolation, CDP port collisions, taskkill pitfalls.";
  const DEPTH_ANSWER = NAV_CHROME + "Y".repeat(29800) + " depth answer: the plan accounts for F1/F3/F4 but must prove the actual UDF and CDP target identity.";
  assert.ok(Math.abs(BREADTH_ANSWER.length - DEPTH_ANSWER.length) < DEPTH_ANSWER.length * 0.1, "fixture must be within 10% length to exercise the real path");
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "key", text: "Return" } },
    { name: "mcp__claude-in-chrome__read_page", input: {}, resultText: BREADTH_ANSWER },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: DEPTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "key", text: "Return" } },
    { name: "mcp__claude-in-chrome__read_page", input: {}, resultText: DEPTH_ANSWER },
  ];
  const dir = writeSpawnFixture("large-dumps-shared-chrome", "agentLargeDumps", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentLargeDumps");
  assert.strictEqual(result.provenGates.size, 2, `both gates must prove despite shared nav-chrome prefix; got ${[...result.provenGates].join(",") || "none"}`);
});

// --- Fix 2: cross-chat issue-number correlation (issue #158 follow-up, 2026-08-26) ---
// Mirrors enforce-pp-plan-gates.js's own gate3Satisfied logic: both gates proven AND their
// issueNumbers equal and non-null. countGateCycles() only REPORTS issueNumbers; this helper is
// what actually judges pass/fail, same as the real hook does.
function gate3Passes(result) {
  if (!result.provenGates.has("breadth") || !result.provenGates.has("depth")) return false;
  const { breadth, depth } = result.issueNumbers;
  return Boolean(breadth) && Boolean(depth) && breadth === depth;
}

function issueTagged(n, text) {
  return `GitHub issue #${n}: ${text}`;
}

test("Fix 2 matrix — same issue, same chat: PASS", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, BREADTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, DEPTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ];
  const dir = writeSpawnFixture("fix2-same-chat", "agentFix2SameChat", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2SameChat");
  assert.strictEqual(gate3Passes(result), true, "same issue in the same chat must pass");
});

test("Fix 2 matrix — same issue, separate chats (quota-pause fallback shape): PASS", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, BREADTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, DEPTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ];
  const dir = writeSpawnFixture("fix2-separate-chats-match", "agentFix2SeparateMatch", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2SeparateMatch");
  assert.strictEqual(gate3Passes(result), true, "same issue across separate chats must still pass");
});

test("Fix 2 matrix — different issues, separate chats: FAIL", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, BREADTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(999, DEPTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ];
  const dir = writeSpawnFixture("fix2-mismatched-issues", "agentFix2Mismatch", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2Mismatch");
  assert.ok(result.provenGates.has("breadth") && result.provenGates.has("depth"), "both fingerprints must still independently prove -- the mismatch is caught at the correlation layer, not by hiding the underlying proof");
  assert.strictEqual(result.issueNumbers.breadth, "158");
  assert.strictEqual(result.issueNumbers.depth, "999");
  assert.strictEqual(gate3Passes(result), false, "mismatched issue numbers across chats must fail Gate 3");
});

test("Fix 2 matrix — missing issue prefix entirely: FAIL (fails closed)", () => {
  const calls = twoFullCycleCalls(); // BREADTH_TYPE/DEPTH_TYPE with no "GitHub issue #N:" prefix at all
  const dir = writeSpawnFixture("fix2-no-prefix", "agentFix2NoPrefix", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2NoPrefix");
  assert.ok(result.provenGates.has("breadth") && result.provenGates.has("depth"), "fingerprints still prove without the issue prefix -- GATE_FINGERPRINTS wording is unchanged");
  assert.strictEqual(result.issueNumbers.breadth, null);
  assert.strictEqual(result.issueNumbers.depth, null);
  assert.strictEqual(gate3Passes(result), false, "a missing issue-number prefix on both sides must fail closed, not pass permissively");
});

test("Fix 2 matrix — real captured query text (issue #158, same chat): PASS", () => {
  // Uses the ACTUAL typed text captured from the real live dry-run, not synthetic filler.
  const realBreadthText =
    "GitHub issue #158: Search developer communities, official documentation, GitHub issues, and Stack Overflow.\n\nTopic: Browser-automation-driven LLM research";
  const realDepthText =
    "GitHub issue #158: Here is an implementation plan summary: RushCut's Gate 3 research step migrated from Perplexity to a real ChatGPT Project driven via browser automation.";
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: realBreadthText } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: realDepthText } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ];
  const dir = writeSpawnFixture("fix2-real-text", "agentFix2RealText", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2RealText");
  assert.strictEqual(gate3Passes(result), true, "real captured query text with matching issue numbers must pass");
});

test("Fix 2 matrix — retype/recovery without a new submit: FAIL (locks in the #158 discovery — a retype cannot manufacture proof of a new submission)", () => {
  // Deliberately reproduces the EXACT false-positive shape found live 2026-08-26: submit, then a
  // same-gate retype, then a read with NO further submit after the retype. The rejected Fix 1
  // design (preserving `submitted` across a same-gate retype) would have proven this. The shipped
  // code must NOT -- confirmed here as a permanent regression guard, not just a one-off finding.
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, BREADTH_TYPE) } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } }, // submit #1
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: issueTagged(158, BREADTH_TYPE) } }, // retype, same gate, NO submit after this
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 }, // a fresh, substantial read -- but with no submit after the retype
  ];
  const dir = writeSpawnFixture("fix2-retype-no-resubmit", "agentFix2RetypeNoResubmit", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentFix2RetypeNoResubmit");
  assert.strictEqual(result.provenGates.has("breadth"), false, "a retype with no submit afterward must NOT prove the gate, even though a fresh substantial read followed it");
});

test("thread switch mid-gate: breadth in one chat, depth in a NEW chat after a re-navigate, still proves both gates", () => {
  // Models the free-tier quota fallback (2026-08-25 migration): Consultant hits ChatGPT's
  // "Chat paused until usage resets" limit after Query 1, starts a fresh chat within the same
  // RushCut project for Query 2 (a second `navigate` call, still chatgpt.com), and continues.
  // currentDomain must stay "chatgpt" across the re-navigate, not reset/break the cycle.
  const calls = [
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_1 },
    // quota pause hit here -- Consultant starts a new chat in the same project for Query 2
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: DEPTH_TYPE } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "left_click" } },
    { name: "mcp__claude-in-chrome__get_page_text", input: {}, resultText: REAL_ANSWER_2 },
  ].map((c) => ({ ...c, resultText: c.resultText ?? "" }));
  const dir = writeSpawnFixture("thread-switch", "agentThreadSwitch", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentThreadSwitch");
  assert.strictEqual(result.provenGates.size, 2, `expected 2 proven gates across the thread switch, got ${result.provenGates.size}`);
  assert.ok(result.provenGates.has("breadth") && result.provenGates.has("depth"));
});

// SUPERSEDED in #216 Step 1 (2026-11-07): the old "exactly 1 event, list_connected_browsers
// only" fail-fast shape no longer qualifies -- rushcut-pp-consultant.md's Setup now REQUIRES a
// launch attempt + port probe + re-check, so a lone empty list is not evidence the documented
// fallback was tried. The positive real-shape cases live in the #216 Chrome-fallback block below.
test("triedBlocked: the OLD single-event shape (one empty list_connected_browsers) no longer qualifies (#216)", () => {
  const calls = [{ name: "mcp__claude-in-chrome__list_connected_browsers", input: {}, resultText: "[]" }];
  const dir = writeSpawnFixture("chrome-unavailable", "agentBlocked", calls);
  const result = countGateCycles(transcriptPathFor(dir), "agentBlocked");
  assert.strictEqual(result.triedBlocked, false);
  assert.strictEqual(result.provenGates.size, 0);
});

test("triedBlocked: a genuinely-attempted-but-interrupted spawn is NOT tried-blocked", () => {
  const calls = [
    { name: "mcp__claude-in-chrome__list_connected_browsers", input: {}, resultText: "[{ok:true}]" },
    { name: "mcp__claude-in-chrome__navigate", input: { url: "https://chatgpt.com/g/g-p-6a8dffb542848191a4b5876a6508d521-rushcut/project" } },
    { name: "mcp__claude-in-chrome__computer", input: { action: "type", text: BREADTH_TYPE } },
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

// =====================================================================================
// #216 STEP 1 -- independent fixtures (written BEFORE the implementation, 2026-11-07)
//
// Every expected value below is a hand-written literal, derived from the owner-approved
// wording and from real captured commands/results (sanitised: username -> "someone"). These
// tests deliberately do NOT read the implementation's own tables or regexes: if the
// implementation's grammar is wrong, these must disagree with it, not echo it. The only
// intentional dependency on a repo file is the tool-drift guard, which reads the tracked
// rushcut-pp-consultant.md on purpose.
// =====================================================================================

// ---- A. Verdict parser: final non-empty line only, recognised wrappers only ----------------
const VERDICT_CASES = [
  ["plain final line", "Reasoning.\n\nVERDICT: APPROVE", "APPROVE"],
  ["objection", "Reasoning.\n\nVERDICT: OBJECTION", "OBJECTION"],
  ["decline", "Out of scope.\nVERDICT: DECLINE-OUT-OF-SCOPE", "DECLINE-OUT-OF-SCOPE"],
  ["only the marker", "VERDICT: APPROVE", "APPROVE"],
  ["trailing newline", "VERDICT: APPROVE\n", "APPROVE"],
  ["trailing blank lines", "VERDICT: APPROVE\n\n\n", "APPROVE"],
  ["CRLF endings", "Text.\r\nVERDICT: OBJECTION\r\n", "OBJECTION"],
  ["surrounding spaces on final line", "Text.\n   VERDICT: OBJECTION   ", "OBJECTION"],
  ["bold wrapper", "Text.\n**VERDICT: APPROVE**", "APPROVE"],
  ["bold + number (real CPO result shape)", "Text.\n\n**4. VERDICT: APPROVE**", "APPROVE"],
  ["number prefix, no wrapper", "4. VERDICT: APPROVE", "APPROVE"],
  ["italic star wrapper", "*VERDICT: OBJECTION*", "OBJECTION"],
  ["underscore wrapper", "_VERDICT: OBJECTION_", "OBJECTION"],
  ["double underscore wrapper", "__VERDICT: APPROVE__", "APPROVE"],
  ["backtick wrapper", "`VERDICT: DECLINE-OUT-OF-SCOPE`", "DECLINE-OUT-OF-SCOPE"],
  ["early OBJECTION in prose, final APPROVE (the real Gate 1 false block)", "I would write VERDICT: OBJECTION if X were missing, but it is present.\n\nVERDICT: APPROVE", "APPROVE"],
  ["early APPROVE, final OBJECTION", "VERDICT: APPROVE (draft)\n...\nVERDICT: OBJECTION", "OBJECTION"],
  ["several markers ending in OBJECTION", "VERDICT: APPROVE\nVERDICT: APPROVE\nVERDICT: OBJECTION", "OBJECTION"],
  // ---- must NOT yield a verdict ----
  ["empty string", "", null],
  ["null", null, null],
  ["undefined", undefined, null],
  ["whitespace only", "  \n \r\n  ", null],
  ["no marker", "Everything else looks right.", null],
  ["marker only mid-text", "VERDICT: APPROVE\nSome closing remark", null],
  ["trailing text after the verdict word", "VERDICT: APPROVE with conditions", null],
  ["NOT APPROVE", "VERDICT: NOT APPROVE", null],
  ["APPROVED (wrong word)", "VERDICT: APPROVED", null],
  ["lowercase word", "VERDICT: approve", null],
  ["unknown word", "VERDICT: MAYBE", null],
  ["no space after colon", "VERDICT:APPROVE", null],
  ["double space after colon", "VERDICT:  APPROVE", null],
  ["trailing period", "VERDICT: APPROVE.", null],
  ["prose prefix on the same line", "My VERDICT: APPROVE", null],
  ["unclosed bold (opening only)", "**VERDICT: APPROVE", null],
  ["unclosed bold (closing only)", "VERDICT: APPROVE**", null],
  ["mismatched wrappers 1", "*VERDICT: APPROVE**", null],
  ["mismatched wrappers 2", "**VERDICT: APPROVE*", null],
  ["triple star (unrecognised wrapper)", "***VERDICT: APPROVE***", null],
  ["tilde wrapper (unrecognised)", "~~VERDICT: APPROVE~~", null],
  ["junk between wrapper and marker", "**x VERDICT: APPROVE**", null],
  ["number without a dot", "4 VERDICT: APPROVE", null],
  ["APPROVE inside a sentence on the final line", "The CPO will decide; APPROVE is not mine to give.", null],
];
for (const [label, input, expected] of VERDICT_CASES) {
  test(`#216 extractVerdict: ${label}`, () => {
    assert.strictEqual(extractVerdict(input), expected);
  });
}

function verdictLinesFor(subagentType, agentId, resultText) {
  const dir = path.join(scratchDir, `verdict-${agentId}-session`);
  return setupSyncSpawn(dir, subagentType, agentId, resultText).map((e) => JSON.stringify(e));
}

test("#216 latestVerdict end-to-end: prose OBJECTION early + final APPROVE resolves to APPROVE (real Gate 1 shape)", () => {
  const lines = verdictLinesFor("rushcut-cpo", "agentCpoProse", "If a field were missing I would write VERDICT: OBJECTION.\nIt is not missing.\n\nVERDICT: APPROVE");
  const spawns = findAgentSpawnsSince(lines, -1, "rushcut-cpo");
  assert.strictEqual(latestVerdict(lines, spawns), "APPROVE");
});

// Pre-commit review (CPO Gate 4 objection, 2026-11-07): an earlier APPROVE must not survive a LATER
// CPO reply whose final line is a verdict marker the strict parser rejects.
let seqCounter = 0;
function latestOver(resultTexts) {
  const sessionDir = path.join(scratchDir, `verdict-seq-${++seqCounter}-session`);
  let entries = [];
  resultTexts.forEach((text, i) => {
    entries = entries.concat(setupSyncSpawn(sessionDir, "rushcut-cpo", `agentSeq${seqCounter}x${i}`, text));
  });
  const lines = entries.map((e) => JSON.stringify(e));
  return latestVerdict(lines, findAgentSpawnsSince(lines, -1, "rushcut-cpo"));
}
const GOOD_APPROVE = "Reasoning.\n\nVERDICT: APPROVE";
const SEQUENCE_CASES = [
  ["strict APPROVE, then a later strict OBJECTION -> OBJECTION", [GOOD_APPROVE, "No.\n\nVERDICT: OBJECTION"], "OBJECTION"],
  ["strict APPROVE, then a later `## VERDICT: OBJECTION` heading -> null (blocks)", [GOOD_APPROVE, "Problems.\n\n## VERDICT: OBJECTION"], null],
  ["strict APPROVE, then a later numbered heading `## 4. VERDICT: OBJECTION` -> null", [GOOD_APPROVE, "Problems.\n\n## 4. VERDICT: OBJECTION"], null],
  ["strict APPROVE, then a later `VERDICT: APPROVE with conditions` -> null", [GOOD_APPROVE, "Mostly fine.\n\nVERDICT: APPROVE with conditions"], null],
  ["strict APPROVE, then a later `VERDICT: NOT APPROVE` -> null", [GOOD_APPROVE, "No.\n\nVERDICT: NOT APPROVE"], null],
  ["strict APPROVE, then a later bullet `- VERDICT: OBJECTION` -> null", [GOOD_APPROVE, "No.\n\n- VERDICT: OBJECTION"], null],
  ["strict APPROVE, then a later lower-case `verdict: objection` -> null", [GOOD_APPROVE, "No.\n\nverdict: objection"], null],
  ["strict APPROVE, then a later reply with NO marker at all -> APPROVE stands", [GOOD_APPROVE, "Quick check: the acceptance criteria look right."], "APPROVE"],
  ["strict APPROVE, then a later reply that only mentions the word in prose -> APPROVE stands", [GOOD_APPROVE, "I will give a VERDICT: later, once the plan is final.\nStill reading."], "APPROVE"],
  ["strict APPROVE, then a later reply whose FINAL line mentions `VERDICT:` only inside a sentence -> APPROVE stands", [GOOD_APPROVE, "Still gathering evidence.\nThe CPO will give a VERDICT: when the plan is final."], "APPROVE"],
  ["strict APPROVE, then a later reply whose OBJECTION marker is mid-text, ending in prose -> APPROVE stands", [GOOD_APPROVE, "VERDICT: OBJECTION\nActually, ignore that, more to check."], "APPROVE"],
  ["strict APPROVE, then a later `**VERDICT**: OBJECTION` (colon outside the bold) -> null", [GOOD_APPROVE, "No.\n\n**VERDICT**: OBJECTION"], null],
  ["strict APPROVE, then a later `__VERDICT__: OBJECTION` -> null", [GOOD_APPROVE, "No.\n\n__VERDICT__: OBJECTION"], null],
  ["malformed heading OBJECTION, then a later strict APPROVE -> APPROVE", ["Problems.\n\n## VERDICT: OBJECTION", GOOD_APPROVE], "APPROVE"],
  ["malformed heading alone -> null", ["Problems.\n\n## VERDICT: OBJECTION"], null],
  ["strict OBJECTION, then a later markerless reply -> OBJECTION stands", ["No.\n\nVERDICT: OBJECTION", "Just a note."], "OBJECTION"],
  ["strict APPROVE, malformed OBJECTION, then a markerless reply -> null (malformed is still newest)", [GOOD_APPROVE, "Problems.\n\n## VERDICT: OBJECTION", "Just a note."], null],
];
for (const [label, texts, expected] of SEQUENCE_CASES) {
  test(`#216 latestVerdict sequence: ${label}`, () => {
    assert.strictEqual(latestOver(texts), expected);
  });
}

test("#216 latestVerdict end-to-end: a consultant-style prose mention of APPROVE yields no verdict", () => {
  const lines = verdictLinesFor("rushcut-pp-consultant", "agentConsultantProse", "Gate 2 notes.\nThe CPO will say VERDICT: APPROVE or VERDICT: OBJECTION later.\n- https://example.org/source");
  const spawns = findAgentSpawnsSince(lines, -1, "rushcut-pp-consultant");
  assert.strictEqual(latestVerdict(lines, spawns), null);
});

// ---- B. Gate 2: evidence = returned URLs, distinct productive queries ----------------------
const wsCall = (query, urls, extra = {}) => ({
  name: "WebSearch",
  input: { query, mode: "standard" },
  resultText:
    urls === null
      ? "No links found."
      : `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(urls.map((u, i) => ({ title: `Result ${i}`, url: u })))}\n\nSummary text.`,
  ...extra,
});
const wfCall = (url, text, extra = {}) => ({ name: "WebFetch", input: { url, prompt: "summarise" }, resultText: text, ...extra });
let g2Counter = 0;
function gate2For(calls) {
  const id = `agentG2x${++g2Counter}`;
  const dir = writeSpawnFixture(`g2-${g2Counter}`, id, calls);
  return countWebSearchDiversity(transcriptPathFor(dir), id);
}
const sortedTypes = (r) => [...r.sourceTypes].sort();
const gate2Passes = (r) => r.count >= 3 && r.sourceTypes.size >= 2;

test("#216 Gate 2: 3 distinct productive queries over github + official docs + an unknown host passes", () => {
  const r = gate2For([
    wsCall("q one", ["https://github.com/anthropics/claude-code/issues/1"]),
    wsCall("q two", ["https://code.claude.com/docs/en/hooks"]),
    wsCall("q three", ["https://some-blog.example/post"]),
  ]);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(sortedTypes(r), ["github-issues", "official-docs", "web-other"]);
  assert.strictEqual(gate2Passes(r), true);
});

test("#216 Gate 2: the same query repeated 3 times counts once and fails", () => {
  const r = gate2For([
    wsCall("same query", ["https://github.com/a/b"]),
    wsCall("same query", ["https://code.claude.com/x"]),
    wsCall("same query", ["https://hex.pm/y"]),
  ]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(gate2Passes(r), false);
});

test("#216 Gate 2: only 2 distinct queries fails even with diverse sources", () => {
  const r = gate2For([wsCall("q1", ["https://github.com/a/b"]), wsCall("q2", ["https://code.claude.com/x"])]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(gate2Passes(r), false);
});

test("#216 Gate 2: a requested site: domain is not evidence (results came from other hosts)", () => {
  const r = gate2For([wsCall("site:code.claude.com hooks reference", ["https://hex.pm/packages/x", "https://some-blog.example/y"])]);
  assert.deepStrictEqual(sortedTypes(r), ["web-other"]);
});

test("#216 Gate 2: allowed_domains in the request is not evidence either", () => {
  const r = gate2For([
    wsCall("q", ["https://github.com/a/b"], { input: { query: "q", mode: "standard", allowed_domains: ["docs.rs", "code.claude.com"] } }),
  ]);
  assert.deepStrictEqual(sortedTypes(r), ["github-issues"]);
});

test("#216 Gate 2: empty Links array, missing Links line, and error results earn nothing", () => {
  const r = gate2For([
    wsCall("q-empty", []),
    wsCall("q-nolinks", null),
    wsCall("q-error", ["https://github.com/a/b"], { isError: true }),
  ]);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.sourceTypes.size, 0);
});

test("#216 Gate 2: unparseable Links line is unproductive (fails closed)", () => {
  const r = gate2For([wsCall("q", null, { resultText: 'Web search results for query: "q"\n\nLinks: [{"title":"broken"' })]);
  assert.strictEqual(r.count, 0);
});

test("#216 Gate 2: only non-http(s) links are unproductive; one usable link among them makes it productive", () => {
  const none = gate2For([wsCall("q", ["ftp://github.com/x", "javascript:alert(1)", "not a url"])]);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.sourceTypes.size, 0);
  const some = gate2For([wsCall("q", ["ftp://github.com/x", "https://tauri.app/x"])]);
  assert.strictEqual(some.count, 1);
  assert.deepStrictEqual(sortedTypes(some), ["official-docs"]);
});

test("#216 Gate 2: many different unknown hosts collapse into ONE web-other type", () => {
  const r = gate2For([
    wsCall("q1", ["https://one.example/a"]),
    wsCall("q2", ["https://two.example/b"]),
    wsCall("q3", ["https://three.example/c", "https://four.example/d"]),
  ]);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(sortedTypes(r), ["web-other"]);
  assert.strictEqual(gate2Passes(r), false, "3 queries over only unknown hosts is ONE evidence type, so it must fail the 2-type rule");
});

test("#216 Gate 2: changelog / releases / migration URL paths do not create a source type", () => {
  const r = gate2For([
    wsCall("q1", ["https://example.org/changelog"]),
    wsCall("q2", ["https://example.net/releases"]),
    wsCall("q3", ["https://example.com/migration-guide"]),
  ]);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(sortedTypes(r), ["web-other"]);
  assert.strictEqual(gate2Passes(r), false);
});

const HOST_CASES = [
  ["https://github.com/a/b", ["github-issues"]],
  ["https://GitHub.COM/a/b", ["github-issues"]],
  ["https://gist.github.com/a", ["github-issues"]],
  ["https://docs.github.com/en", ["github-issues"]],
  ["https://github.com:443/a", ["github-issues"]],
  ["https://github.com./a", ["github-issues"]],
  ["https://github.com.evil.com/x", ["web-other"]],
  ["https://evilgithub.com/x", ["web-other"]],
  ["https://github.com@evil.com/x", ["web-other"]],
  ["https://notgithub.com/x", ["web-other"]],
  ["https://stackoverflow.com/q/1", ["stackoverflow"]],
  ["https://meta.stackoverflow.com/q/1", ["stackoverflow"]],
  ["https://www.reddit.com/r/x", ["reddit"]],
  ["https://news.ycombinator.com/item?id=1", ["hn"]],
  ["https://ycombinator.com/x", ["web-other"]],
  ["https://code.claude.com/docs/en/hooks", ["official-docs"]],
  ["https://platform.claude.com/docs", ["official-docs"]],
  ["https://docs.rs/x", ["official-docs"]],
  ["https://sub.docs.rs/x", ["official-docs"]],
  ["https://notdocs.rs/x", ["web-other"]],
  ["https://tauri.app/x", ["official-docs"]],
  ["https://ffmpeg.org/doc", ["official-docs"]],
  ["https://hex.pm/x", ["web-other"]],
  ["http://127.0.0.1/x", ["web-other"]],
];
for (const [url, expectedTypes] of HOST_CASES) {
  test(`#216 Gate 2 host typing: ${url} -> ${expectedTypes.join("+")}`, () => {
    const r = gate2For([wsCall(`q for ${url}`, [url])]);
    assert.deepStrictEqual(sortedTypes(r), expectedTypes);
    assert.strictEqual(r.count, 1);
  });
}

test("#216 Gate 2: WebFetch adds evidence but never query count; short, empty and error fetches add nothing", () => {
  // Each fetch carries a DISTINCT evidence type, so removing the length floor or the error skip
  // would add reddit / hn / stackoverflow to the set and fail this test. Only the long, successful
  // tauri.app fetch (official-docs) may add a type.
  const r = gate2For([
    wsCall("q1", ["https://github.com/a/b"]),
    wfCall("https://tauri.app/v2/x", "x".repeat(250)),
    wfCall("https://www.reddit.com/r/x", "x".repeat(199)), // one char under the floor
    wfCall("https://news.ycombinator.com/item?id=1", "x".repeat(500), { isError: true }), // long but an error
    wfCall("https://stackoverflow.com/q/1", ""), // empty
  ]);
  assert.strictEqual(r.count, 1, "fetches must not raise the query count");
  assert.deepStrictEqual(sortedTypes(r), ["github-issues", "official-docs"]);
});
test("#216 Gate 2: a WebFetch of exactly the 200-character floor counts", () => {
  const r = gate2For([wsCall("q1", ["https://github.com/a/b"]), wfCall("https://www.reddit.com/r/x", "x".repeat(200))]);
  assert.deepStrictEqual(sortedTypes(r), ["github-issues", "reddit"]);
});

test("#216 Gate 2: tool_result content given as an array of text blocks is read the same way", () => {
  const id = "agentG2arr";
  const dir = writeSpawnFixture("g2-array", id, [wsCall("qa", ["https://github.com/a/b"]), wsCall("qb", ["https://code.claude.com/x"]), wsCall("qc", ["https://hex.pm/y"])]);
  const sub = require("./transcript").subagentTranscriptPath(transcriptPathFor(dir), id);
  const rewritten = fs
    .readFileSync(sub, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l);
      if (e.type === "user") {
        for (const b of e.message.content) if (b.type === "tool_result" && typeof b.content === "string") b.content = [{ type: "text", text: b.content }];
      }
      return JSON.stringify(e);
    })
    .join("\n");
  fs.writeFileSync(sub, rewritten + "\n");
  const r = countWebSearchDiversity(transcriptPathFor(dir), id);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(sortedTypes(r), ["github-issues", "official-docs", "web-other"]);
});

test("#216 Gate 2: a missing subagent transcript is reported unreadable with count 0", () => {
  const r = countWebSearchDiversity(path.join(scratchDir, "does-not-exist-session.jsonl"), "agentNope");
  assert.strictEqual(r.unreadable, true);
  assert.strictEqual(r.count, 0);
});

// ---- C. Chrome-unavailable fallback ---------------------------------------------------------
// Real command shapes (sanitised) captured from Chrome-unavailable consultant runs, 2026-08..11.
const L_CMD =
  `Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 4','--no-first-run','--no-default-browser-check'`;
const S_CMD = "Start-Sleep -Seconds 6";
const P_CMD = "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content";
const P_TRY_CONCAT = `try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 3).Content } catch { "9222 free: " + $_.Exception.Message }`;
const P_TRY_SUBEXPR = `try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 3).Content } catch { "9222 free: $($_.Exception.Message)" }`;
const P_URI = `(Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing).Content`;

test("#216 Chrome setup grammar: exactly nine permitted shapes (pinned count)", () => {
  assert.strictEqual(CHROME_SETUP_SHAPES.length, 9);
});

const NINE_ACCEPTED = [
  ["1 launch", L_CMD],
  ["2 launch; sleep", `${L_CMD}; ${S_CMD}`],
  ["3 launch; sleep; probe", `${L_CMD}; ${S_CMD}; ${P_CMD}`],
  ["4 launch; sleep; string", `${L_CMD}; ${S_CMD}; "launched"`],
  ["5 launch; probe", `${L_CMD}; ${P_CMD}`],
  ["6 launch; string", `${L_CMD}; "launched"`],
  ["7 sleep", S_CMD],
  ["8 sleep; string", `${S_CMD}; "waited"`],
  ["9 probe", P_CMD],
];
for (const [label, cmd] of NINE_ACCEPTED) {
  test(`#216 Chrome setup accepted shape ${label}`, () => {
    assert.ok(isChromeSetupCommand(cmd), `must accept: ${cmd}`);
  });
}

const EXTRA_ACCEPTED = [
  ["probe: try/catch concat (real)", P_TRY_CONCAT],
  ["probe: try/catch subexpression (real)", P_TRY_SUBEXPR],
  ["probe: -Uri quoted + trailing -UseBasicParsing (real)", P_URI],
  ["probe: -TimeoutSec 5", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 5).Content"],
  ["probe: try/catch with plain-string catch", `try { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9222/json/version" -TimeoutSec 3).Content } catch { "still no 9222" }`],
  ["sleep 25 (real)", "Start-Sleep -Seconds 25"],
  ["sleep 90 then string (real)", 'Start-Sleep -Seconds 90; "ok"'],
  ["surrounding whitespace is trimmed", `  ${S_CMD}  \n`],
  ["launch; sleep; try/catch probe", `${L_CMD}; ${S_CMD}; ${P_TRY_CONCAT}`],
  ["launch with another profile number and user name", L_CMD.replace("someone", "another.user").replace("Profile 4", "Profile 12")],
];
for (const [label, cmd] of EXTRA_ACCEPTED) {
  test(`#216 Chrome setup accepted variant: ${label}`, () => {
    assert.ok(isChromeSetupCommand(cmd), `must accept: ${cmd}`);
  });
}

const SETUP_REJECTED = [
  ["extra launch argument", L_CMD.replace("'--no-default-browser-check'", "'--no-default-browser-check','--new-window'")],
  ["launch with a URL argument", L_CMD.replace("'--no-default-browser-check'", "'--no-default-browser-check','https://chatgpt.com'")],
  ["launch missing --no-first-run", L_CMD.replace("'--no-first-run',", "")],
  ["launch with port 9223", L_CMD.replace("9222", "9223")],
  ["launch with the Default profile", L_CMD.replace("Profile 4", "Default")],
  ["launch with a user-data-dir elsewhere", L_CMD.replace("C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 4", "C:\\evil\\Profile 4")],
  ["launch of a different exe", L_CMD.replace("Google\\Chrome\\Application\\chrome.exe", "Temp\\chrome.exe")],
  ["bare chrome to a URL", 'Start-Process chrome "https://chatgpt.com"'],
  ["launch followed by a URL", `${L_CMD} "https://chatgpt.com"`],
  ["launch chained with a foreign cmdlet", `${L_CMD}; Get-Process chrome`],
  ["launch piped", `${L_CMD} | Out-Null`],
  ["launch with ampersand", `${L_CMD} & calc`],
  ["launch with a trailing backtick", `${L_CMD} \``],
  ["two sleeps", `${S_CMD}; ${S_CMD}`],
  ["sleep before launch", `${S_CMD}; ${L_CMD}`],
  ["four parts (launch; sleep; probe; string)", `${L_CMD}; ${S_CMD}; ${P_CMD}; "x"`],
  ["probe before launch", `${P_CMD}; ${L_CMD}`],
  ["launch twice", `${L_CMD}; ${L_CMD}`],
  ["string only", '"launched"'],
  ["sleep 0", "Start-Sleep -Seconds 0"],
  ["sleep 121", "Start-Sleep -Seconds 121"],
  ["sleep in milliseconds", "Start-Sleep -Milliseconds 500"],
  ["sleep with a fraction", "Start-Sleep -Seconds 6.5"],
  ["string with a variable", `${S_CMD}; "$env:USERNAME"`],
  ["probe to another host", "(Invoke-WebRequest -UseBasicParsing http://evil.example/json/version).Content"],
  ["probe to another port", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9223/json/version).Content"],
  ["probe to another path", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/list).Content"],
  ["probe via localhost", "(Invoke-WebRequest -UseBasicParsing http://localhost:9222/json/version).Content"],
  ["probe with -Method Post", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -Method Post).Content"],
  ["probe with Substring", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content.Substring(0,600)"],
  ["probe via Invoke-RestMethod", "(Invoke-RestMethod http://127.0.0.1:9222/json/version)"],
  ["try/catch whose catch runs a command", `try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content } catch { Start-Process chrome }`],
  ["catch string with a subexpression command", `try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version).Content } catch { "x $(Get-Date)" }`],
  ["probe followed by Get-Process (real, out of grammar)", `${P_TRY_CONCAT}; Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object`],
  ["multi-line command", `${L_CMD}\n${S_CMD}`],
  ["trailing garbage", `${S_CMD}; "waited" extra`],
  ["empty string", ""],
  ["whitespace only", "   "],
  ["null", null],
  ["number", 42],
  ["undefined", undefined],
];
for (const [label, cmd] of SETUP_REJECTED) {
  test(`#216 Chrome setup rejected: ${label}`, () => {
    assert.ok(!isChromeSetupCommand(cmd), `must reject: ${String(cmd)}`);
  });
}

// Scratch-file PowerShell screen (independent of fallback evidence). Real shapes from the
// Gate 3 scratch writes of genuine Chrome-unavailable runs.
const W_HERESTRING = [
  "$path = Join-Path $env:TEMP 'rushcut\\pp-consultant-gate3-170.md'",
  "$content = @'",
  "# Gate 3 notes -- these words are inert text: chrome, https://chatgpt.com, Start-Process, Invoke-WebRequest",
  "'@",
  "Set-Content -Path $path -Value $content -Encoding utf8",
  '"WROTE: $path"',
  "(Get-Item $path).Length",
].join("\n");
const W_DIRPREP = "$d = Join-Path $env:TEMP 'rushcut'; if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }; $d";
const W_COMBINED = [
  "$d = Join-Path $env:TEMP 'rushcut'; if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }",
  "$f = Join-Path $d 'pp-consultant-gate3-206.md'",
  "$c = @'",
  "body text",
  "'@",
  'Set-Content -Path $f -Value $c -Encoding utf8; "wrote $f"',
].join("\n");

const W_EMPTY_BODY = "$d = Join-Path $env:TEMP 'rushcut'\n$f = Join-Path $d 'pp-consultant-gate3-9.md'\n$c = @'\n'@\nSet-Content -Path $f -Value $c -Encoding utf8";
const W_CRLF = W_HERESTRING.replace(/\n/g, "\r\n");
// The distinct real scratch-write shapes found in consultant runs (sanitised: bodies replaced by
// the word "body", issue numbers varied). Each must be accepted: a genuine blocked run writes one.
const HS = (head, tail) => `${head} @'\nbody line one\n# a heading-looking line inside the body is inert\n'@\n${tail}`;
const REAL_SCRATCH = [
  ["Set-Content -LiteralPath + (Get-Item).Length", HS("$p = Join-Path $env:TEMP 'rushcut\\pp-consultant-gate3-216.md'\n$c =", "Set-Content -LiteralPath $p -Value $c -Encoding utf8\n(Get-Item $p).Length")],
  ["dir prep + Join-Path + echo string", HS("$d = Join-Path $env:TEMP 'rushcut'; if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }\n$f = Join-Path $d 'pp-consultant-gate3-206.md'\n$c =", 'Set-Content -Path $f -Value $c -Encoding utf8; "wrote $f"')],
  ["double-quoted $env:TEMP paths + FullName/Length", HS("$content =", 'New-Item -ItemType Directory -Force "$env:TEMP\\rushcut" | Out-Null\nSet-Content -Path "$env:TEMP\\rushcut\\pp-consultant-gate3-202.md" -Value $content -Encoding utf8\n(Get-Item "$env:TEMP\\rushcut\\pp-consultant-gate3-202.md").FullName; (Get-Item "$env:TEMP\\rushcut\\pp-consultant-gate3-202.md").Length')],
  ["if/New-Item -Path", HS("$d = Join-Path $env:TEMP 'rushcut'; if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }\n$f = Join-Path $d 'pp-consultant-gate3-201.md'\n$c =", "Set-Content -Path $f -Value $c -Encoding utf8\n(Get-Item $f).Length")],
  ["$dir/$body names + echo", HS("$dir = Join-Path $env:TEMP 'rushcut'; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }\n$f = Join-Path $dir 'pp-consultant-gate3-200.md'\n$body =", 'Set-Content -Path $f -Value $body -Encoding utf8\n"wrote: $f"; (Get-Item $f).Length')],
  ["Write-Host with $env:TEMP path in the message", HS("$content =", 'Set-Content -Path "$env:TEMP\\rushcut\\pp-consultant-gate3-197.md" -Value $content -Encoding utf8\nWrite-Host "Written: $env:TEMP\\rushcut\\pp-consultant-gate3-197.md"\n(Get-Item "$env:TEMP\\rushcut\\pp-consultant-gate3-197.md").Length')],
  ["Out-File piped", HS("$path = Join-Path $env:TEMP 'rushcut\\pp-consultant-gate3-163.md'\n$content =", '$content | Out-File -FilePath $path -Encoding utf8\n"Wrote: $path"\n(Get-Item $path).Length')],
  ["Get-Item | Select-Object FullName, Length", HS("$content =", '$path = Join-Path $env:TEMP \'rushcut\\pp-consultant-gate3-174.md\'\n$content | Out-File -FilePath $path -Encoding utf8\nGet-Item $path | Select-Object FullName, Length')],
  ["Write-Output string", HS("$content =", "$path = Join-Path $env:TEMP 'rushcut\\pp-consultant-gate3-152.md'\n$content | Out-File -FilePath $path -Encoding utf8\nWrite-Output \"WROTE: $path\"\n(Get-Item $path).Length")],
  ["Select-Object FullName, Length, LastWriteTime", HS("$content =", '$content | Out-File -FilePath "$env:TEMP\\rushcut\\pp-consultant-gate3-185.md" -Encoding utf8\nGet-Item "$env:TEMP\\rushcut\\pp-consultant-gate3-185.md" | Select-Object FullName, Length, LastWriteTime')],
  ["Write-Output with a bytes expression", HS("$p = Join-Path $env:TEMP 'rushcut\\pp-consultant-gate3-170.md'\n$content =", 'Set-Content -Path $p -Value $content -Encoding utf8\nWrite-Output "WROTE: $p"\nWrite-Output ("bytes: " + (Get-Item $p).Length)')],
];
for (const [label, cmd] of [
  ["here-string write (real)", W_HERESTRING],
  ["directory prep (real shape)", W_DIRPREP],
  ["combined prep + write (real)", W_COMBINED],
  ["here-string with an empty body", W_EMPTY_BODY],
  ["here-string write with CRLF line endings", W_CRLF],
  ...REAL_SCRATCH,
]) {
  test(`#216 scratch-write screen accepts: ${label}`, () => {
    assert.strictEqual(isScratchPowerShell(cmd), true);
  });
}
const SCRATCH_REJECTED = [
  ["bare chrome launch to a URL", "Start-Process chrome 'https://chatgpt.com'"],
  ["HTTP request", "Invoke-WebRequest http://127.0.0.1:9222/json/list"],
  ["valid write plus a Start-Process outside the here-string", `${W_HERESTRING}\nStart-Process chrome`],
  ["write to an absolute path", "Set-Content -Path 'C:\\Users\\someone\\secrets.txt' -Value 'a'"],
  ["write to another filename under rushcut", "$p = Join-Path $env:TEMP 'rushcut\\notes.md'; Set-Content -Path $p -Value 'x'"],
  ["delete", "Remove-Item -Recurse $env:TEMP"],
  ["pipe to another cmdlet", "Get-Item $env:TEMP | Remove-Item"],
  ["subexpression command", '"$(Invoke-WebRequest http://example.org)"'],
  ["other env var (everything else about the call is allowed)", "$p = Join-Path $env:APPDATA 'rushcut'; Set-Content -Path $p -Value $p"],
  ["parent-directory escape", "Set-Content -Path ..\\..\\x -Value $c"],
  ["URL in a quoted literal outside the here-string", "$u = 'https://example.org'; Set-Content -Path $u -Value 'a'"],
  ["call operator", "& 'calc.exe'"],
  ["suspicious browser word in a double-quoted literal (only allowed cmdlets otherwise)", "$p = Join-Path $env:TEMP 'rushcut'; Set-Content -Path $p -Value \"launch chrome now\""],
  ["suspicious ChatGPT word in a double-quoted literal", "$p = Join-Path $env:TEMP 'rushcut'; Set-Content -Path $p -Value \"ask chatgpt\""],
  ["pipe between two otherwise-allowed cmdlets", "$d = Join-Path $env:TEMP 'rushcut'; Get-Item $d | Set-Content -Path $d"],
  ["empty", ""],
  ["null", null],
  ["no recognised cmdlet at all", '$x = 1; "hello"'],
  ["unterminated here-string", "$c = @'\nno terminator\nSet-Content -Path $p -Value $c"],
  // Pre-commit review finding: an `@'` that is NOT a real here-string opener must not hide code.
  ["fake here-string opener in a # comment hides live code", "# @'\nInvoke-WebRequest http://127.0.0.1:9222/json/list\n'@\nGet-Item $env:TEMP"],
  ["fake here-string opener inside a double-quoted string hides a subexpression", 'Get-Item "a@\'\n$(Invoke-WebRequest u)\n\'@"'],
  ["fake here-string opener inside a double-quoted string hides a command", 'Set-Content -Path "@\'\n$(Remove-Item x)\n\'@" -Value a'],
  ["# comment in code context, otherwise allowed cmdlets only", "$d = Join-Path $env:TEMP 'rushcut' # note\nTest-Path $d"],
  // The four bypasses demonstrated by the CPO's Gate 4 review (an alias, iex, .NET static call):
  // (The alias / iex / .NET / Start-Process bypasses are re-based on a VALID prefix in the
  // "injected statement" block below, with a precondition that the prefix alone is accepted.)
  ["double-quoted here-string with a subexpression", "$d = Join-Path $env:TEMP 'rushcut'; $x = @\"\n$(Get-Date)\n\"@"],
  ["invocation operator on a variable", "$d = Join-Path $env:TEMP 'rushcut'\n& $d"],
  ["dot-sourcing", "$d = Join-Path $env:TEMP 'rushcut'\n. $d"],
  ["Set-Content to a path not built from the allowed forms", "Set-Content -Path $p -Value $c -Encoding utf8 -Force"],
  ["Set-Content with an inline literal path", "Set-Content -Path 'C:\\x.txt' -Value $c -Encoding utf8"],
  ["Out-File to a drive path", '$c | Out-File -FilePath "C:\\x.txt" -Encoding utf8'],
  ["message string with a subexpression", 'Write-Output "x $(calc)"'],
  ["message string with a backtick escape", 'Write-Output "x `$(calc)"'],
  ["Write-Output of an unquoted expression", "Write-Output (Get-Date)"],
  ["Select-Object of an extra property pipeline", "Get-Item $p | Select-Object FullName, Length | Format-List"],
  ["Join-Path with another env var", "$d = Join-Path $env:USERPROFILE 'rushcut'"],
  ["Join-Path with a different folder literal", "$d = Join-Path $env:TEMP 'other'"],
  ["Join-Path with a different filename literal", "$f = Join-Path $d 'notes.md'"],
  ["comment after code", "Test-Path $d # why"],
  ["unterminated double quote", 'Set-Content -Path $p -Value "abc'],
  ["unterminated single quote", "Set-Content -Path $p -Value 'abc"],
];
for (const [label, cmd] of SCRATCH_REJECTED) {
  test(`#216 scratch-write screen rejects: ${label}`, () => {
    assert.strictEqual(isScratchPowerShell(cmd), false, `must reject: ${String(cmd)}`);
  });
}

// Injected-statement bypasses (CPO Gate 4 review). Each injected statement is appended to a prefix
// that is ITSELF a valid scratch statement, and the prefix alone is asserted to be accepted, so a
// rejection can only come from the injected statement -- never from the prefix being invalid.
const VALID_PREFIX = "$d = Join-Path $env:TEMP 'rushcut'";
test("#216 scratch-write bypass tests: the valid prefix alone is accepted (precondition)", () => {
  assert.strictEqual(isScratchPowerShell(VALID_PREFIX), true);
});
const INJECTED = [
  "saps msedge",
  "start msedge",
  "Start-Process msedge",
  "Start-Process notepad",
  'iex "calc"',
  'Invoke-Expression "calc"',
  '[Diagnostics.Process]::Start("msedge")',
  'curl "example.org"',
  "Invoke-WebRequest http://127.0.0.1:9222/json/list",
  "cmd /c calc",
  'powershell -c "calc"',
  "& $d",
  ". $d",
  '$u = "chat" + "gpt.com"',
  "saps msedge $u",
  "Get-Process chrome",
  "Remove-Item $d",
  "$d | Remove-Item",
];
for (const inj of INJECTED) {
  for (const [sepLabel, sep] of [[";", "; "], ["newline", "\n"], ["CRLF", "\r\n"]]) {
    test(`#216 scratch-write rejects injected ${JSON.stringify(inj)} after a valid prefix (${sepLabel})`, () => {
      assert.strictEqual(isScratchPowerShell(`${VALID_PREFIX}${sep}${inj}`), false);
      assert.strictEqual(isScratchPowerShell(`${inj}${sep}${VALID_PREFIX}`), false, "...and before it");
    });
  }
}
// PowerShell treats U+2018..U+201B as single-quote characters, including as a here-string
// terminator, so a smart-quote terminator followed by live code hid a statement from the ASCII-only
// stripper (reproduced under Windows PowerShell 5.1). Any non-ASCII character must fail closed.
for (const cp of [0x2018, 0x2019, 0x201a, 0x201b]) {
  const q = String.fromCodePoint(cp);
  test(`#216 scratch-write rejects a U+${cp.toString(16)} here-string terminator hiding live code`, () => {
    const cmd = `$c = @'\nfoo\n${q}@; Start-Process msedge https://chatgpt.com\n$e = @'\nx\n'@`;
    assert.strictEqual(isScratchPowerShell(cmd), false);
    // the same shape with ASCII terminators and only the allowed content is fine (the control)
    assert.strictEqual(isScratchPowerShell(`$c = @'\nfoo\n'@\n$f = Join-Path $env:TEMP 'rushcut'\nSet-Content -Path $f -Value $c -Encoding utf8`), true);
  });
}
// A lone CR before `'@` terminates a here-string in PowerShell 5.1 (verified), so the stripper must
// see it as a newline too; otherwise `foo<CR>'@; <live code>` hides a statement inside the "body".
test("#216 scratch-write rejects a lone-CR here-string terminator hiding live code", () => {
  assert.strictEqual(isScratchPowerShell("$c = @'\nfoo\r'@; Start-Process msedge\n$e = @'\nx\n'@"), false);
  assert.strictEqual(isScratchPowerShell("$c = @'\rfoo\r'@; Start-Process msedge\r$e = @'\rx\r'@"), false);
});
test("#216 scratch-write accepts lone-CR and CRLF line endings on an otherwise valid write", () => {
  const ok = "$f = Join-Path $env:TEMP 'rushcut'\n$c = @'\nbody\n'@\nSet-Content -Path $f -Value $c -Encoding utf8";
  assert.strictEqual(isScratchPowerShell(ok), true);
  assert.strictEqual(isScratchPowerShell(ok.replace(/\n/g, "\r\n")), true);
  assert.strictEqual(isScratchPowerShell(ok.replace(/\n/g, "\r")), true);
});
test("#216 scratch-write accepts non-ASCII text (em dash, accents) INSIDE a here-string body only", () => {
  const body = "# Gate 3 \u2014 findings \u00e9 for issue 1";
  const ok = `$f = Join-Path $env:TEMP 'rushcut'\n$c = @'\n${body}\n'@\nSet-Content -Path $f -Value $c -Encoding utf8`;
  assert.strictEqual(isScratchPowerShell(ok), true);
  assert.strictEqual(isScratchPowerShell(ok + '\nWrite-Output "caf\u00e9"'), false, "outside a body it still fails");
});
test("#216 scratch-write rejects a Unicode single quote even inside a here-string body", () => {
  for (const cp of [0x2018, 0x2019, 0x201a, 0x201b]) {
    const ok = `$c = @'\nit${String.fromCodePoint(cp)}s fine\n'@`;
    assert.strictEqual(isScratchPowerShell(ok), false, `U+${cp.toString(16)}`);
  }
});
for (const [label, ch] of [["NBSP", "\u00a0"], ["zero-width space", "\u200b"], ["form feed", "\f"], ["NUL", "\0"], ["accented letter", "\u00e9"]]) {
  test(`#216 scratch-write rejects a stray ${label}`, () => {
    assert.strictEqual(isScratchPowerShell(`${VALID_PREFIX}${ch}`), false);
    assert.strictEqual(isScratchPowerShell(`${VALID_PREFIX}\nWrite-Output "a${ch}b"`), false);
  });
}
// Role-restricted variables: a here-string variable may never become a path, and a path variable
// may never be filled from a here-string.
const PATHVAR_REJECTED = [
  ["here-string into a path variable, then used as the write target", "$p = @'\nC:\\Users\\Public\\evil.ps1\n'@\n$c = @'\nanything\n'@\nSet-Content -Path $p -Value $c -Encoding utf8"],
  ["here-string into a path variable (assignment alone)", "$p = @'\nx\n'@"],
  ["content variable used as the write target", "$c = @'\nx\n'@\nSet-Content -Path $c -Value $c -Encoding utf8"],
  ["Out-File to a content variable", "$c = @'\nx\n'@\n$c | Out-File -FilePath $c -Encoding utf8"],
  ["path variable piped into Out-File (only content variables may be written)", "$f = Join-Path $env:TEMP 'rushcut'\n$f | Out-File -FilePath $f -Encoding utf8"],
  ["control character inside a here-string body", "$c = @'\nab\u0001cd\n'@"],
  ["path variable used as the written value", "$f = Join-Path $env:TEMP 'rushcut'\nSet-Content -Path $f -Value $f -Encoding utf8"],
  ["Join-Path onto a content variable base", "$c = @'\nx\n'@\n$f = Join-Path $c 'pp-consultant-gate3-1.md'"],
  ["Join-Path assigned to a content variable", "$c = Join-Path $env:TEMP 'rushcut'"],
  ["Join-Path with an arbitrary variable name", "$whatever = Join-Path $env:TEMP 'rushcut'"],
  ["Set-Content to an arbitrary variable name", "$zz = Join-Path $env:TEMP 'rushcut'\nSet-Content -Path $zz -Value $c -Encoding utf8"],
  ["Test-Path of a content variable", "Test-Path $c"],
  ["Write-Output of an arbitrary variable", "Write-Output $profile"],
  ["message interpolating an arbitrary variable", 'Write-Output "x $profile"'],
  ["bare $PROFILE", "$PROFILE"],
  ["bare $HOME", "$HOME"],
  ["variable name that only starts like an allowed one", "$content2 = @'\nx\n'@"],
  ["variable name with an allowed prefix and more letters", "$pathology = Join-Path $env:TEMP 'rushcut'"],
];
for (const [label, cmd] of PATHVAR_REJECTED) {
  test(`#216 scratch-write role check rejects: ${label}`, () => {
    assert.strictEqual(isScratchPowerShell(cmd), false, `must reject: ${cmd}`);
  });
}

// ---- Ordered fallback sequence, end to end through countGateCycles ----
const CIC = "mcp__claude-in-chrome__";
const LIST_TOOL = `${CIC}list_connected_browsers`;
const TABS_TOOL = `${CIC}tabs_context_mcp`;
const NOT_CONNECTED = "WARNING: **Claude in Chrome is not connected** The Chrome extension isn't reachable right now.";
const NO_LISTENER = "9222 free: Unable to connect to the remote server";
const CHROME_JSON = '{\r\n   "Browser": "Chrome/156.0.8078.80",\r\n   "Protocol-Version": "1.3"\r\n}';
const EDG_JSON = '{ "Browser": "Edg/150.0.3800.70", "Protocol-Version": "1.3" }';
const OTHER_JSON = '{ "Browser": "Firefox/120.0" }';
const psCall = (command, resultText = "") => ({ name: "PowerShell", input: { command }, resultText });
const listCall = (resultText = "[]") => ({ name: LIST_TOOL, input: {}, resultText });
const tabsCall = () => ({ name: TABS_TOOL, input: { createIfEmpty: true }, resultText: NOT_CONNECTED });
let fbCounter = 0;
function fallbackResult(calls) {
  const id = `agentFB${++fbCounter}`;
  const dir = writeSpawnFixture(`fb-${fbCounter}`, id, calls);
  return countGateCycles(transcriptPathFor(dir), id);
}
const fallbackBlocked = (calls) => fallbackResult(calls).triedBlocked;

// Real shape: probe, launch, re-check, probe (Chrome JSON), wait, re-check `[]`, then WebSearch fallback.
function realShape() {
  return [
    tabsCall(),
    psCall(P_TRY_CONCAT, NO_LISTENER),
    psCall(`${L_CMD}; ${S_CMD}; "launched"`, "launched"),
    listCall(),
    tabsCall(),
    psCall(P_TRY_CONCAT, CHROME_JSON),
    psCall(`${S_CMD}; "waited"`, "waited"),
    listCall(),
    wsCall("fallback query", ["https://example.org/a"]),
  ];
}

test("#216 fallback: the real documented sequence qualifies (launch -> probe -> final empty list)", () => {
  const r = fallbackResult(realShape());
  assert.strictEqual(r.triedBlocked, true);
  assert.strictEqual(r.provenGates.size, 0);
});
test("#216 fallback: launch+sleep+probe chained in one call, Chrome JSON, then empty list qualifies", () => {
  assert.strictEqual(fallbackBlocked([tabsCall(), listCall(), psCall(`${L_CMD}; ${S_CMD}; ${P_CMD}`, CHROME_JSON), listCall()]), true);
});
test("#216 fallback: a recognised no-listener probe after launch, then empty list qualifies", () => {
  assert.strictEqual(fallbackBlocked([listCall(), psCall(L_CMD, ""), psCall(P_TRY_CONCAT, NO_LISTENER), listCall()]), true);
});
test("#216 fallback: launch+probe chained in the first call qualifies", () => {
  assert.strictEqual(fallbackBlocked([psCall(`${L_CMD}; ${P_CMD}`, CHROME_JSON), listCall()]), true);
});
test("#216 fallback: Read / WebSearch / WebFetch / Glob / Grep around the sequence are allowed", () => {
  const calls = [
    { name: "Read", input: { file_path: "C:\\x\\notes.md" }, resultText: "text" },
    ...realShape(),
    wfCall("https://tauri.app/x", "y".repeat(300)),
    { name: "Glob", input: { pattern: "*.md" }, resultText: "a.md" },
    { name: "Grep", input: { pattern: "x" }, resultText: "" },
  ];
  assert.strictEqual(fallbackBlocked(calls), true);
});

test("#216 fallback: scratch write is permitted but is NOT evidence -- a valid sequence passes with or without it", () => {
  assert.strictEqual(fallbackBlocked(realShape()), true);
  assert.strictEqual(fallbackBlocked([...realShape(), psCall(W_HERESTRING, "WROTE: x"), psCall(W_DIRPREP, "x True")]), true);
});
test("#216 fallback: a scratch write ALONE never qualifies", () => {
  assert.strictEqual(fallbackBlocked([psCall(W_HERESTRING, "WROTE: x")]), false);
  assert.strictEqual(fallbackBlocked([tabsCall(), listCall(), psCall(W_HERESTRING, "WROTE: x")]), false);
});
test("#216 fallback: a scratch write cannot repair a broken sequence (no launch)", () => {
  assert.strictEqual(fallbackBlocked([tabsCall(), psCall(P_TRY_CONCAT, NO_LISTENER), listCall(), psCall(W_HERESTRING, "WROTE: x")]), false);
});
test("#216 fallback: a failed or missing scratch write does not break a valid sequence", () => {
  assert.strictEqual(fallbackBlocked([...realShape(), psCall(W_HERESTRING, "Set-Content : Access denied")]), true);
});

test("#216 fallback: OLD shape (a lone empty list) does not qualify", () => {
  assert.strictEqual(fallbackBlocked([listCall()]), false);
});
test("#216 fallback: no launch attempt does not qualify", () => {
  assert.strictEqual(fallbackBlocked([tabsCall(), psCall(P_TRY_CONCAT, NO_LISTENER), listCall()]), false);
});
test("#216 fallback: launch without any probe does not qualify", () => {
  assert.strictEqual(fallbackBlocked([psCall(L_CMD, ""), listCall()]), false);
});
test("#216 fallback: list BEFORE the probe, with no list after it, does not qualify", () => {
  assert.strictEqual(fallbackBlocked([psCall(L_CMD, ""), listCall(), psCall(P_TRY_CONCAT, CHROME_JSON)]), false);
});
test("#216 fallback: probe before the launch only does not qualify", () => {
  assert.strictEqual(fallbackBlocked([psCall(P_TRY_CONCAT, NO_LISTENER), psCall(L_CMD, ""), listCall()]), false);
});
test("#216 fallback: a launch AFTER the final list does not qualify", () => {
  assert.strictEqual(fallbackBlocked([psCall(L_CMD, ""), psCall(P_TRY_CONCAT, CHROME_JSON), listCall(), psCall(L_CMD, "")]), false);
});
test("#216 fallback: the final list returning a device does not qualify", () => {
  const calls = realShape();
  calls[7] = listCall('[{"deviceId":"abc","name":"Browser 1"}]');
  assert.strictEqual(fallbackBlocked(calls), false);
});
test("#216 fallback: Chrome JSON alone does not establish unavailability (final list shows a device)", () => {
  assert.strictEqual(fallbackBlocked([psCall(`${L_CMD}; ${P_CMD}`, CHROME_JSON), listCall('[{"deviceId":"abc"}]')]), false);
});
for (const [label, probeResult] of [
  ["Edg/ WebView2 JSON (port squatted)", EDG_JSON],
  ["unknown JSON", OTHER_JSON],
  ["unrecognised text", "something odd happened"],
  ["empty result", ""],
]) {
  test(`#216 fallback: last probe result "${label}" does not qualify`, () => {
    assert.strictEqual(fallbackBlocked([psCall(`${L_CMD}; ${P_CMD}`, probeResult), listCall()]), false);
  });
}
test("#216 fallback: the LAST probe decides -- ok probe then a squatted probe does not qualify", () => {
  assert.strictEqual(fallbackBlocked([psCall(`${L_CMD}; ${P_CMD}`, CHROME_JSON), psCall(P_CMD, EDG_JSON), listCall()]), false);
});

test("#216 fallback: a ChatGPT navigate after a valid sequence disqualifies (the interrupted/attempted shape)", () => {
  const nav = { name: `${CIC}navigate`, input: { url: "https://chatgpt.com/g/x/project" }, resultText: NOT_CONNECTED };
  assert.strictEqual(fallbackBlocked([...realShape(), nav]), false);
});

const BANNED_CIC = ["navigate", "computer", "read_page", "find", "get_page_text", "javascript_tool", "select_browser", "switch_browser", "form_input", "file_upload", "upload_image", "resize_window", "gif_creator", "read_console_messages", "read_network_requests", "tabs_create_mcp", "tabs_close_mcp", "browser_batch"].map((n) => CIC + n);
const BANNED_CU = ["screenshot", "left_click", "type", "key", "scroll", "open_application", "read_clipboard", "write_clipboard", "request_access"].map((n) => `mcp__computer-use__${n}`);
const BANNED_OTHER = ["Bash", "Edit", "Write", "Agent", "NotebookEdit", "mcp__future__new_tool"];
for (const tool of [...BANNED_CIC, ...BANNED_CU, ...BANNED_OTHER]) {
  test(`#216 fallback: any call to ${tool} disqualifies an otherwise valid sequence`, () => {
    assert.strictEqual(fallbackBlocked([...realShape(), { name: tool, input: {}, resultText: "x" }]), false);
  });
}
for (const action of ["left_click", "right_click", "double_click", "triple_click", "type", "screenshot", "wait", "scroll", "key", "left_click_drag", "zoom", "scroll_to", "hover"]) {
  test(`#216 fallback: a computer ${action} action disqualifies (no ChatGPT interaction of any kind)`, () => {
    assert.strictEqual(fallbackBlocked([{ name: `${CIC}computer`, input: { action }, resultText: "x" }, ...realShape()]), false);
  });
}
test("#216 fallback: a banned tool BEFORE the sequence also disqualifies", () => {
  assert.strictEqual(fallbackBlocked([{ name: `${CIC}get_page_text`, input: {}, resultText: "x" }, ...realShape()]), false);
});

for (const [label, cmd] of [
  ["Start-Process chrome to ChatGPT", 'Start-Process chrome "https://chatgpt.com"'],
  ["Invoke-WebRequest to another host", "Invoke-WebRequest http://example.org"],
  ["valid scratch write plus Start-Process", `${W_HERESTRING}\nStart-Process chrome`],
  ["Get-Process chrome piped", "Get-Process chrome | Measure-Object"],
  ["probe to the /json/list endpoint", "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/list).Content"],
]) {
  test(`#216 fallback: a foreign PowerShell call disqualifies -- ${label}`, () => {
    assert.strictEqual(fallbackBlocked([...realShape(), psCall(cmd, "x")]), false);
  });
}

// Failure reasons: informational field naming the FIRST thing that broke the sequence (no hook
// reads it yet). Each case pins a distinct, human-meaningful cause.
const REASON_CASES = [
  ["qualifies -> null", realShape(), null],
  ["disallowed tool names the tool", [...realShape(), { name: `${CIC}get_page_text`, input: {}, resultText: "x" }], /not on the fallback allow-list: mcp__claude-in-chrome__get_page_text/],
  ["foreign PowerShell names the call", [...realShape(), psCall("Get-Process chrome | Measure-Object", "3")], /PowerShell call #\d+ is outside the allowed .*Get-Process chrome/],
  ["real-world probe with a trailing Get-Process diagnostic is named", [psCall(L_CMD, ""), psCall(`${P_TRY_CONCAT}; Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object`, NO_LISTENER), listCall()], /outside the allowed .*Get-Process/],
  ["no launch", [tabsCall(), listCall()], /no documented Chrome launch/],
  ["no probe after launch", [psCall(L_CMD, ""), listCall()], /no port-9222 probe/],
  ["unrecognised probe result", [psCall(`${L_CMD}; ${P_CMD}`, EDG_JSON), listCall()], /not a recognised no-listener message or Chrome JSON/],
  ["no list after the probe", [psCall(`${L_CMD}; ${P_CMD}`, CHROME_JSON)], /no list_connected_browsers call after the last probe/],
  ["final list not empty", [psCall(`${L_CMD}; ${P_CMD}`, CHROME_JSON), listCall('[{"deviceId":"d"}]')], /final list_connected_browsers result is not \[\]/],
];
for (const [label, calls, expected] of REASON_CASES) {
  test(`#216 fallback reason: ${label}`, () => {
    const r = fallbackResult(calls);
    if (expected === null) {
      assert.strictEqual(r.triedBlocked, true);
      assert.strictEqual(r.triedBlockedReason, null);
    } else {
      assert.strictEqual(r.triedBlocked, false);
      assert.match(r.triedBlockedReason, expected);
    }
  });
}
test("#216 fallback reason: a spawn that proved real ChatGPT gates reports the fallback as not applicable", () => {
  const dir = writeSpawnFixture("fb-proved", "agentFBProved", twoFullCycleCalls());
  const r = countGateCycles(transcriptPathFor(dir), "agentFBProved");
  assert.strictEqual(r.triedBlocked, false);
  assert.match(r.triedBlockedReason, /not applicable/);
});

// Drift guard: reads the tracked consultant agent file ON PURPOSE. If a tool is added there
// without being classified here, this fails until a person decides allowed vs disqualifying.
const ALLOWED_DECLARED = ["Read", "Grep", "Glob", "PowerShell", "WebSearch", "WebFetch", TABS_TOOL, LIST_TOOL];
const BANNED_DECLARED = [`${CIC}navigate`, `${CIC}computer`, `${CIC}read_page`, `${CIC}find`, `${CIC}get_page_text`, `${CIC}javascript_tool`, `${CIC}select_browser`, "mcp__computer-use__read_clipboard", "mcp__computer-use__write_clipboard", "mcp__computer-use__request_access"];
const consultantFile = fs.readFileSync(path.join(__dirname, "..", "..", "agents", "rushcut-pp-consultant.md"), "utf8");
const declaredTools = (consultantFile.match(/^tools:\s*(.+)$/m) || [null, ""])[1].split(",").map((s) => s.trim()).filter(Boolean);

test("#216 drift guard: the consultant agent file declares tools and every one is classified", () => {
  assert.ok(declaredTools.length > 0, "could not read the tools: line from rushcut-pp-consultant.md");
  const unclassified = declaredTools.filter((t) => !ALLOWED_DECLARED.includes(t) && !BANNED_DECLARED.includes(t));
  assert.deepStrictEqual(unclassified, [], `unclassified tools in rushcut-pp-consultant.md: ${unclassified.join(", ")}`);
});
test("#216 drift guard: every declared allowed tool keeps a valid sequence qualifying; every declared banned tool disqualifies it", () => {
  for (const tool of declaredTools) {
    if (tool === "PowerShell" || tool === LIST_TOOL || tool === TABS_TOOL) continue; // covered by the sequence tests
    const extra = { name: tool, input: {}, resultText: "x" };
    const expectBlocked = ALLOWED_DECLARED.includes(tool);
    assert.strictEqual(fallbackBlocked([...realShape(), extra]), expectBlocked, `${tool}: expected triedBlocked=${expectBlocked}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
