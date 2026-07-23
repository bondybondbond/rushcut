// Transcript-reading helpers for enforce-skill-gate.js. Lets PreToolUse independently
// re-derive "is a skill trigger currently pending" from the actual conversation on every
// call, instead of trusting a state file written by a separate UserPromptSubmit process
// (which had a cross-process write/read race -- see docs/LEARNINGS.md).
//
// Known limitation: a genuine human message that mixes text with a non-text block (e.g. an
// image attachment) is not recognised as human text by isGenuineHumanMessage below -- only
// pure-string or all-text-block messages count. Acceptable for this project's terminal-driven
// workflow; would need extending if image-attached trigger messages become common.
//
// Coupling risk (accepted, not mitigated): this reads the transcript JSONL's internal shape
// (isMeta, message.content block types, tool_use structure) -- an implementation detail, not a
// documented/versioned Claude Code API. If that shape changes in a future version, every read
// here fails closed to "couldn't parse" and the caller (enforce-skill-gate.js) fails OPEN --
// i.e. the hard gate silently stops firing and behaviour degrades to the pre-existing
// UserPromptSubmit-only soft hint, not a broken/blocking session. Acceptable for a workflow-
// discipline guard; would NOT be acceptable if this pattern were ever reused for an actual
// safety boundary (e.g. blocking a destructive command) -- that needs a sturdier mechanism
// than transcript-scraping.

const fs = require("fs");
const path = require("path");

function readLines(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return null;
  }
}

// Confirmed live (2026-07-23, #153): a delivered background-task notification is recorded as
// type:"user", non-sidechain, non-isMeta, with `message.content` as a PLAIN STRING starting
// with "<task-notification>" -- structurally indistinguishable from real human-typed text by
// every check above it. This is the actual root cause of #153 ("enforce-skill-gate.js
// false-triggers wrapup on background-notification/subagent text"). Reject it explicitly by
// content, not just structure.
const NOTIFICATION_MARKERS = ["<task-notification>", "[SYSTEM NOTIFICATION - NOT USER INPUT]"];
function looksLikeNotificationContent(text) {
  return NOTIFICATION_MARKERS.some((marker) => text.startsWith(marker) || text.includes(marker));
}

function isGenuineHumanMessage(entry) {
  if (!entry || entry.type !== "user" || entry.isSidechain) return false;
  if (entry.isMeta) return false; // Skill bodies and other injected content are isMeta:true
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return !looksLikeNotificationContent(content);
  if (Array.isArray(content)) {
    // tool_result blocks are synthetic harness->model content, not human-typed text
    if (content.length === 0 || !content.every((b) => b && b.type === "text")) return false;
    const joined = content.map((b) => b.text || "").join("\n");
    return !looksLikeNotificationContent(joined);
  }
  return false;
}

function extractText(entry) {
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content.map((b) => b.text || "").join("\n");
}

// Returns { text, index, lines } for the most recent genuine human message, or null if the
// transcript can't be read/parsed or no such message exists yet.
function findLastHumanMessage(transcriptPath) {
  const lines = readLines(transcriptPath);
  if (lines === null) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isGenuineHumanMessage(entry)) {
      return { text: extractText(entry), index: i, lines };
    }
  }
  return null;
}

// Scans forward from `fromIndex` (exclusive) looking for an assistant tool_use entry that
// calls the Skill tool with the given skill name.
function hasMatchingSkillCallSince(lines, fromIndex, skillName) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Skill" &&
        block.input &&
        block.input.skill === skillName
      ) {
        return true;
      }
    }
  }
  return false;
}

// Scans backward for the most recent assistant tool_use entry calling Skill with the given
// skill name. Returns its index, or -1 if never called in this transcript. Used by
// enforce-pp-auditor-spawn.js to anchor "has Step 0's spawn happened since dev-plan started."
function findLastMatchingSkillCall(lines, skillName) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Skill" &&
        block.input &&
        block.input.skill === skillName
      ) {
        return i;
      }
    }
  }
  return -1;
}

// Scans forward from `fromIndex` (exclusive) looking for an assistant tool_use entry that
// calls the Agent tool with the given subagent_type, spawned in the background (run_in_background
// must be true -- a synchronous/foreground spawn would stall the session, which Step 0
// explicitly requires it not do).
function hasAgentSpawnSince(lines, fromIndex, subagentType) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.name === "Agent" &&
        block.input &&
        block.input.subagent_type === subagentType &&
        block.input.run_in_background === true
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- Search-proof helpers (enforce-pp-plan-gates.js, enforce-pp-wrapup-signoff.js) ---
//
// These verify a subagent actually DID something (real tool_use calls, a rendered verdict),
// not just that it was spawned and returned some text. Confirmed empirically (2026-07-23,
// against real transcripts, not assumed) via rushcut-pp-consultant's own Round 2 audit:
//   - Agent tool_result.toolUseResult always carries `agentId`, for BOTH sync and async calls.
//   - `outputFile` (async only) is NOT the subagent's transcript -- it's an ephemeral, empty-
//     on-disk-after-session .output scratch file. NEVER read it for verification. The real
//     transcript lives at <dirname(transcriptPath)>/<sessionId>/subagents/agent-<agentId>.jsonl
//     regardless of sync/async -- always derive the path from agentId.
//   - Sync tool_result shape: {status:"completed", content: [{type:"text", text:"..."}], ...} --
//     already complete, no further wait needed, text lives in `content[].text`.
//   - Async tool_result shape: {isAsync:true, status:"async_launched", agentId, outputFile, ...}
//     -- NOT complete yet. Completion arrives later as a `type:"queue-operation"` entry whose
//     `content` string contains `<task-id>AGENTID</task-id>...<status>completed</status>...
//     <result>...</result>`.

// Scans forward from `fromIndex` (exclusive) for every Agent tool_use call matching
// `subagentType`, sync or async (pp-consultant is commonly sync; the real-pp-auditor is
// always background per its own spawn contract, but this does not filter on that -- callers
// needing "background only" should check the returned `isBackground` flag themselves).
// Returns [{ spawnIndex, toolUseId }].
function findAgentSpawnsSince(lines, fromIndex, subagentType) {
  const spawns = [];
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Agent" && block.input && block.input.subagent_type === subagentType) {
        spawns.push({ spawnIndex: i, toolUseId: block.id, isBackground: block.input.run_in_background === true });
      }
    }
  }
  return spawns;
}

// Finds the tool_result entry matching `toolUseId` (searched forward from `spawnIndex`, since
// the result always follows its tool_use) and resolves it into a uniform shape:
// { agentId, isAsync, complete, resultText, resultIndex } -- for sync calls `complete` is
// true immediately with `resultText` already populated; for async calls `complete` is false
// until a matching queue-operation completion is found (see resolveAsyncCompletion below).
// Returns null if no matching tool_result/agentId is found at all (spawn call malformed or
// transcript truncated mid-call).
function resolveSpawnResult(lines, spawnIndex, toolUseId) {
  for (let i = spawnIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "user" || !entry.toolUseResult) continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    const match = content.some((b) => b && b.type === "tool_result" && b.tool_use_id === toolUseId);
    if (!match) continue;
    const tur = entry.toolUseResult;
    if (!tur.agentId) return null;
    if (tur.isAsync) {
      return { agentId: tur.agentId, isAsync: true, complete: false, resultText: "", resultIndex: i };
    }
    const resultText = Array.isArray(tur.content) ? tur.content.map((b) => b.text || "").join("\n") : String(tur.content || "");
    return { agentId: tur.agentId, isAsync: false, complete: true, resultText, resultIndex: i };
  }
  return null;
}

// For an async spawn, scans forward from `fromIndex` for the queue-operation completion
// notification carrying this agentId. Returns { resultText } or null if not found yet
// (background task still running, or genuinely never completed this session).
function resolveAsyncCompletion(lines, fromIndex, agentId) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "queue-operation" || entry.operation !== "enqueue") continue;
    const content = entry.content;
    if (typeof content !== "string") continue;
    if (!content.includes(`<task-id>${agentId}</task-id>`)) continue;
    if (!content.includes("<status>completed</status>")) continue;
    const m = content.match(/<result>([\s\S]*?)<\/result>/);
    return { index: i, resultText: m ? m[1] : "" };
  }
  return null;
}

// Full resolution: spawn -> result -> (if async) completion -> (if resumed) LATEST completion.
// Returns { agentId, complete, resultText } or null if the spawn itself couldn't be resolved.
//
// An agent can be continued after its first resolution via SendMessage (a common recovery path
// -- an API-error interruption, or a fix-and-reverify round after an OBJECTION) -- this produces
// FURTHER queue-operation completions under the SAME agentId, well after the original tool_result
// (sync or async). Confirmed necessary empirically (2026-07-23): this exact session resumed two
// spawns this way, and checking only the first resolution silently returned each one's STALE
// initial answer (in one live case, an OBJECTION that had since been resolved to APPROVE by a
// later resume) -- exactly the "presence not recency" failure class this file's latestVerdict
// helper exists to prevent, just one level deeper (per-spawn, not just across-spawns). Always
// scan forward for every later completion of this agentId and keep the LAST one found.
function resolveAgentSpawn(lines, spawn) {
  const resolved = resolveSpawnResult(lines, spawn.spawnIndex, spawn.toolUseId);
  if (!resolved) return null;
  const agentId = resolved.agentId;
  let latestText = resolved.complete ? resolved.resultText : null;
  let cursor = resolved.resultIndex;
  // Keep walking forward -- a spawn can be resumed more than once (confirmed: this session did
  // it twice on two different agents), so don't stop at the first later completion found.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const completion = resolveAsyncCompletion(lines, cursor, agentId);
    if (!completion) break;
    latestText = completion.resultText;
    cursor = completion.index;
  }
  if (latestText === null) return { agentId, complete: false, resultText: "" };
  return { agentId, complete: true, resultText: latestText };
}

// Builds the on-disk path to a subagent's own transcript. ALWAYS derive from agentId -- never
// from toolUseResult.outputFile (see header note above for why that field is unusable).
function subagentTranscriptPath(transcriptPath, agentId) {
  const dir = path.dirname(transcriptPath);
  const sessionId = path.basename(transcriptPath, ".jsonl");
  return path.join(dir, sessionId, "subagents", `agent-${agentId}.jsonl`);
}

// Reads a subagent's own transcript and classifies its real tool-call evidence.
// `reachedNames` -- tool names that count as genuine outside-search evidence (e.g. WebSearch,
//   WebFetch, or mcp__claude-in-chrome__get_page_text/read_page).
// `triedNames` -- tool names that show a genuine attempt that legitimately stopped short (e.g.
//   list_connected_browsers, when Chrome truly isn't connected -- confirmed against the real
//   #149 Chrome-not-connected auditor run: exactly one list_connected_browsers call, nothing
//   after).
// Returns "reached" | "tried-blocked" | "none" | "unreadable" (the last is a distinct outcome
// from "none" -- an I/O flake right after spawn, not evidence the subagent did nothing; callers
// should treat "unreadable" as "not yet provable," not as a certain failure).
// This is a FLOOR check, not a ceiling: a tool_use call proves real interaction happened, not
// that the interaction was thorough or the resulting answer is correct. Callers must not
// present "reached" to a human as "verified good" -- only as "verified real."
function classifySubagentEvidence(transcriptPath, agentId, { reachedNames, triedNames = [] }) {
  const subPath = subagentTranscriptPath(transcriptPath, agentId);
  let lines;
  try {
    const raw = fs.readFileSync(subPath, "utf8");
    lines = raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return "unreadable";
  }
  let sawReached = false;
  let sawTried = false;
  for (const l of lines) {
    let entry;
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_use") continue;
      if (reachedNames.includes(block.name)) sawReached = true;
      if (triedNames.includes(block.name)) sawTried = true;
    }
  }
  if (sawReached) return "reached";
  if (sawTried) return "tried-blocked";
  return "none";
}

// Extracts a standardized `VERDICT: X` marker from a subagent's relayed result text. Tool-call
// evidence (classifySubagentEvidence) proves a real search happened; this proves the subagent
// actually rendered an explicit decision rather than just prose that reads like one. The two
// checks are deliberately independent -- see docs/LEARNINGS.md Workflow-GateMiss for why a
// confident-sounding summary alone (no structural commitment) is not sufficient evidence of
// approval.
const VERDICT_RE = /VERDICT:\s*([A-Z][A-Z-]*)/;
function extractVerdict(resultText) {
  if (!resultText) return null;
  const m = String(resultText).match(VERDICT_RE);
  return m ? m[1] : null;
}

// --- Gate-cycle proof (enforce-pp-plan-gates.js's rushcut-real-pp-auditor check) ---
//
// Replaces the earlier "any get_page_text/read_page call counts" check (2026-07-23) after two
// rounds of external audit (2026-07-24) found it too weak: it could pass on a homepage read, a
// stale/cached re-read, or a typed-but-never-submitted query. This version requires, per gate,
// in order: (1) a `type` action matching that gate's FIXED template fingerprint (see
// GATE_FINGERPRINTS -- pulled verbatim from rushcut-real-pp-auditor.md's own gate templates,
// not a length guess) while tracked domain state is Perplexity, (2) a submit transition
// (key/left_click/navigate) after the type, (3) a read (get_page_text/read_page) after THAT
// whose own tool_result content is both non-trivial (CONTENT_LENGTH_FLOOR, now a secondary
// anti-empty guard only) AND genuinely NEW relative to every prior read in this transcript (not
// a stale/homepage re-read) -- see textsSimilar. Domain tracking and content-delta comparison
// are proxies, not verified against Perplexity's actual DOM/URL scheme (no live Perplexity
// session was driven while building this) -- documented limitation, not a claim of certainty.

const GATE_FINGERPRINTS = {
  1: /Does this user story actually capture/,
  2: /DaVinci Resolve, CapCut, Premiere Pro/,
  3: /Is this a sound overall approach/,
  4: /Search Stack Overflow, GitHub issues\/discussions, official docs/,
};

// Documented, accepted gap (flagged by rushcut-pp-consultant's Round 2 review, 2026-07-24): this
// only proves SOME key/click happened after the fingerprinted type, on the Perplexity domain --
// a transcript alone can't confirm the click landed on the actual submit control vs. an unrelated
// element on the page. Acceptable because the auditor is a cooperative, instructed agent
// following its own documented protocol, not adversarial; tightening further would need real
// DOM/element-target verification this hook has no access to.
const SUBMIT_ACTIONS = new Set(["key", "left_click"]);
const READ_TOOLS = new Set(["mcp__claude-in-chrome__get_page_text", "mcp__claude-in-chrome__read_page"]);
const NAVIGATE_TOOL = "mcp__claude-in-chrome__navigate";
const COMPUTER_TOOL = "mcp__claude-in-chrome__computer";
const LIST_BROWSERS_TOOL = "mcp__claude-in-chrome__list_connected_browsers";
const CONTENT_LENGTH_FLOOR = 300;

function findToolResultText(lines, toolUseId, fromIndex) {
  for (let i = fromIndex; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "user") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    const block = content.find((b) => b && b.type === "tool_result" && b.tool_use_id === toolUseId);
    if (!block) continue;
    const c = block.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => b.text || "").join("\n");
    return "";
  }
  return "";
}

// Two read results count as "the same page state" (not a genuine new answer) if they're
// near-identical in length and share a large common prefix -- a cheap, DOM-agnostic proxy for
// "this is a stale/cached re-read," since the actual Perplexity markup isn't known here.
function textsSimilar(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > Math.max(50, a.length * 0.1)) return false;
  const prefixLen = Math.min(200, a.length, b.length);
  return a.slice(0, prefixLen) === b.slice(0, prefixLen);
}

// Reads a rushcut-real-pp-auditor spawn's own transcript and returns which gates (1-4, by
// GATE_FINGERPRINTS) it actually proved via a full type(fingerprint)->submit->new-read cycle,
// plus whether it hit the documented Chrome-unavailable tried-blocked case.
// Returns { provenGates: Set<number>, triedBlocked: boolean, unreadable: boolean }.
function countGateCycles(transcriptPath, agentId) {
  const subPath = subagentTranscriptPath(transcriptPath, agentId);
  let lines;
  try {
    const raw = fs.readFileSync(subPath, "utf8");
    lines = raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return { provenGates: new Set(), triedBlocked: false, unreadable: true };
  }

  const events = [];
  for (let i = 0; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use") events.push({ index: i, name: block.name, input: block.input || {}, toolUseId: block.id });
    }
  }

  let sawListBrowsers = false;
  let currentDomain = null;
  const priorReadTexts = [];
  const provenGates = new Set();
  let pendingGate = null; // { gate, submitted }

  for (const ev of events) {
    if (ev.name === LIST_BROWSERS_TOOL) sawListBrowsers = true;

    if (ev.name === NAVIGATE_TOOL && typeof ev.input.url === "string") {
      currentDomain = ev.input.url.includes("perplexity") ? "perplexity" : "other";
      if (pendingGate && !pendingGate.submitted) pendingGate.submitted = true;
      continue;
    }

    if (ev.name === COMPUTER_TOOL && ev.input.action === "type" && typeof ev.input.text === "string") {
      if (currentDomain !== "perplexity") continue;
      for (const [gateNum, fp] of Object.entries(GATE_FINGERPRINTS)) {
        if (fp.test(ev.input.text)) pendingGate = { gate: Number(gateNum), submitted: false };
      }
      continue;
    }

    if (ev.name === COMPUTER_TOOL && SUBMIT_ACTIONS.has(ev.input.action)) {
      if (pendingGate && !pendingGate.submitted) pendingGate.submitted = true;
      continue;
    }

    if (READ_TOOLS.has(ev.name)) {
      const resultText = findToolResultText(lines, ev.toolUseId, ev.index + 1);
      if (pendingGate && pendingGate.submitted && currentDomain === "perplexity") {
        const isSubstantial = resultText.length >= CONTENT_LENGTH_FLOOR;
        const isNew = !priorReadTexts.some((prev) => textsSimilar(prev, resultText));
        if (isSubstantial && isNew) {
          provenGates.add(pendingGate.gate);
          pendingGate = null;
        }
      }
      priorReadTexts.push(resultText);
      continue;
    }
  }

  // triedBlocked means the DOCUMENTED fail-fast case specifically (Chrome confirmed
  // unavailable, agent returns immediately per its own Setup protocol -- confirmed against the
  // real #149 case: EXACTLY ONE tool_use total, list_connected_browsers, nothing after).
  // list_connected_browsers is called by every auditor spawn as step 1 regardless of outcome,
  // so its presence alone is not distinguishing -- a spawn that genuinely tried (navigated,
  // typed, read) and got interrupted mid-task by an unrelated bug is NOT the same case, and must
  // not silently pass via this fallback (confirmed 2026-07-24: an earlier version conflated the
  // two). Tightened to exactly match the one documented real case (===1, not <=2 or looser) --
  // rushcut-pp-consultant's own Round 2 review flagged that a looser bound wasn't independently
  // justified against any real 2-event failure shape.
  const triedBlocked = sawListBrowsers && provenGates.size === 0 && events.length === 1;
  return { provenGates, triedBlocked, unreadable: false };
}

// Returns the VERDICT of the MOST RECENT completed spawn among `spawns` (each { spawnIndex,
// toolUseId }, as returned by findAgentSpawnsSince), or null if none are complete / none
// rendered a marker. Deliberately "most recent," not "any" -- confirmed necessary by
// rushcut-pp-consultant's own Round 4 review (2026-07-23): checking presence via `.some()`
// across ALL spawns let a stale early-round APPROVE, or an unrelated round's marker, satisfy a
// gate even when the LATEST relevant round was actually OBJECTION. "Most recent" also correctly
// handles the intended fix-and-reverify flow (Round 2 objects -> orchestrator fixes -> Round 2
// re-run approves -> the later spawn's APPROVE is what counts, not the earlier OBJECTION).
function latestVerdict(lines, spawns) {
  let best = null; // { spawnIndex, verdict }
  for (const spawn of spawns) {
    const resolved = resolveAgentSpawn(lines, spawn);
    if (!resolved || !resolved.complete) continue;
    const verdict = extractVerdict(resolved.resultText);
    if (verdict === null) continue;
    if (!best || spawn.spawnIndex > best.spawnIndex) best = { spawnIndex: spawn.spawnIndex, verdict };
  }
  return best ? best.verdict : null;
}

module.exports = {
  findLastHumanMessage,
  hasMatchingSkillCallSince,
  findLastMatchingSkillCall,
  hasAgentSpawnSince,
  findAgentSpawnsSince,
  resolveAgentSpawn,
  subagentTranscriptPath,
  classifySubagentEvidence,
  countGateCycles,
  extractVerdict,
  latestVerdict,
};
