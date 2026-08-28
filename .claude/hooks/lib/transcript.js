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
// not a length guess) while tracked domain state is ChatGPT, (2) a submit transition
// (key/left_click/navigate) after the type, (3) a read (get_page_text/read_page) after THAT
// whose own tool_result content is both non-trivial (CONTENT_LENGTH_FLOOR, now a secondary
// anti-empty guard only) AND genuinely NEW relative to every prior read in this transcript (not
// a stale/homepage re-read) -- see textsSimilar. Domain tracking and content-delta comparison
// are proxies, not verified against ChatGPT's actual DOM scheme in fine detail (a live session
// WAS driven to confirm the shape below, 2026-08-25 migration off Perplexity -- see
// docs/LEARNINGS.md), but content-delta staleness detection specifically remains unverified
// against a real repeated-read case.

// Rewritten 2026-07-24 (issue #156, CPO/Consultant/CC redesign): the old 4-gate auditor model
// (one spawn covering Gates 1-2, a second covering Gates 3-4, each needing >=2 fingerprint matches
// to count as "satisfied") is replaced by a single Gate 3 owned by rushcut-pp-consultant: ONE
// research-tool spawn, TWO sequential queries (breadth then depth). Gate 1 is now CPO's own quick
// JTBD judgment (see enforce-cpo-gate1-spawn.js) with no search involved at all. Gate 2 is
// Consultant's WebSearch-only competitor/context research (see countWebSearchDiversity below),
// never the Gate 3 tool.
//
// Migrated 2026-08-25 from Perplexity to a ChatGPT Project ("RushCut") as Gate 3's execution
// backend -- same contract, same fingerprints, same mechanical proof; only the domain string and
// the "same thread" assumption changed (see below). Live-verified against the real ChatGPT
// Project UI before this change: (1) no mode/model toggle exists or is needed on the free tier
// (no picker at all -- every conversation runs the standard default model); (2) driving the
// compose box via `computer` type/Return does NOT re-fire a `navigate` tool call -- the SPA route
// changes the tab's URL without a fresh `navigate` -- but this is harmless for domain tracking
// since `currentDomain` only needs to be set ONCE per spawn (from the initial navigate to the
// project URL) and nothing else in a Gate 3 spawn ever navigates to a different domain in between;
// (3) the free tier enforces a real, reproducible quota: a fresh chat's first message succeeds,
// but an immediate follow-up in the SAME thread is blocked ("Chat paused until usage resets") --
// confirmed via direct testing, not assumed. Per the user (whose own ChatGPT app usage doesn't
// hit this limit -- it's specific to driving the web UI): Consultant's own protocol is now
// "continue in the same thread by default; if the pause banner appears, start a NEW chat within
// the RushCut project and restate the GitHub issue number as the first line" -- so Query 1 and
// Query 2 may legitimately land in two different chats, both still on chatgpt.com the whole time.
// This is why `currentDomain` tracking (below) intentionally does not require both gates to share
// one `navigate` call -- only that no OTHER domain was navigated to in between.
const GATE_FINGERPRINTS = {
  breadth: /Search developer communities, official documentation, GitHub issues, and Stack Overflow/,
  depth: /Here is an implementation plan summary/,
};

// Cross-chat issue-number correlation (added 2026-08-26, issue #158 follow-up). Deliberately a
// SEPARATE regex from GATE_FINGERPRINTS, matched independently against the same `type` event text
// -- this keeps the query-template fingerprints themselves frozen (no wording change needed) while
// closing a real gap found via live testing: a `chatgpt.com` domain hit alone proves "some ChatGPT
// activity happened," not "breadth and depth research happened for the SAME issue." Confirmed via
// direct testing (not assumed) that a mismatched-issue-number pair independently satisfies both
// fingerprints today with nothing to catch the mismatch -- see the live cross-chat dry-run notes in
// docs/agent_plan.md's Gate 3 section. `rushcut-pp-consultant.md`'s protocol requires every Gate 3
// message to open with "GitHub issue #<N>: " -- this regex reads that back out as evidence.
const ISSUE_NUMBER_RE = /GitHub issue #(\d+)/i;

// Documented, accepted gap (flagged by rushcut-pp-consultant's Round 2 review, 2026-07-24): this
// only proves SOME key/click happened after the fingerprinted type, on the ChatGPT domain --
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
// near-identical in length and match at BOTH ends -- a cheap, DOM-agnostic proxy for
// "this is a stale/cached re-read."
//
// Prefix-only comparison false-positived a real Gate 3 depth read (2026-08-28): successive
// `read_page` accessibility dumps of ChatGPT are ~30K chars, land within 10% length of each
// other, and share an identical ~200-char leading nav-chrome block ("Skip to content" /
// "Sidebar" / "New chat" ...), so two genuinely different answers rendered into the same page
// shell looked "similar" and the second gate never proved. A true stale re-read of an
// unchanged page matches at the prefix AND the suffix; two different answers diverge in the
// body/tail even when the chrome and length are close.
function textsSimilar(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > Math.max(50, a.length * 0.1)) return false;
  const w = Math.min(200, a.length, b.length);
  return a.slice(0, w) === b.slice(0, w) && a.slice(-w) === b.slice(-w);
}

// Reads a rushcut-pp-consultant Gate 3 spawn's own transcript and returns which queries
// ("breadth"/"depth", by GATE_FINGERPRINTS) it actually proved via a full
// type(fingerprint)->submit->new-read cycle, plus whether it hit the documented
// Chrome-unavailable tried-blocked case (falls back to WebSearch per the agent's own file).
// Returns { provenGates: Set<"breadth"|"depth">, issueNumbers: {breadth: string|null, depth:
// string|null}, triedBlocked: boolean, unreadable: boolean }.
//
// Cross-chat correlation (added 2026-08-26, issue #158 follow-up): `issueNumbers` records which
// GitHub issue number (per ISSUE_NUMBER_RE) was present in the SAME `type` event that satisfied
// each proven gate's fingerprint -- null if that gate wasn't proven, or if the type text had no
// issue-number prefix at all. The caller (enforce-pp-plan-gates.js) is responsible for requiring
// both to be present AND equal; this function only reports what it found, it doesn't judge.
// Deliberately does NOT verify the "wrong chat"/wrong-PROJECT guard (that the active conversation
// is actually inside the RushCut ChatGPT Project, not just chatgpt.com generally) -- narrower gap,
// same category, would need reading a `read_page` result's visible project/chat title, which this
// function doesn't currently parse for content beyond the read-freshness check.
//
// Deliberately does NOT attempt to tolerate a retype/recovery sequence (e.g. an agent correcting a
// premature-submit) as an alternate path to proof -- tested and rejected 2026-08-26: any state
// change that credits a submit-then-retype-then-read sequence is mechanically indistinguishable
// from crediting a submit-then-retype-then-UNRELATED-read false positive (empirically confirmed,
// not just argued -- both patterns produce the identical tool-call shape). The fix for that failure
// mode lives on the agent side instead (rushcut-pp-consultant.md's Gate 3 setup: never embed a
// literal newline in a `type` action against ChatGPT's compose box -- Enter submits, so an embedded
// `\n` mid-type fires a premature submit; and always read the response immediately after a submit,
// before starting any further typing for the next query) -- keeping this verifier exactly as strict
// as it already was, rather than teaching it to infer intent from an ambiguous pattern.
function countGateCycles(transcriptPath, agentId) {
  const subPath = subagentTranscriptPath(transcriptPath, agentId);
  let lines;
  try {
    const raw = fs.readFileSync(subPath, "utf8");
    lines = raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return { provenGates: new Set(), issueNumbers: { breadth: null, depth: null }, triedBlocked: false, unreadable: true };
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
  const issueNumbers = { breadth: null, depth: null };
  let pendingGate = null; // { gate, submitted, issueNumber }

  for (const ev of events) {
    if (ev.name === LIST_BROWSERS_TOOL) sawListBrowsers = true;

    if (ev.name === NAVIGATE_TOOL && typeof ev.input.url === "string") {
      currentDomain = ev.input.url.includes("chatgpt.com") ? "chatgpt" : "other";
      if (pendingGate && !pendingGate.submitted) pendingGate.submitted = true;
      continue;
    }

    if (ev.name === COMPUTER_TOOL && ev.input.action === "type" && typeof ev.input.text === "string") {
      if (currentDomain !== "chatgpt") continue;
      for (const [gateKey, fp] of Object.entries(GATE_FINGERPRINTS)) {
        if (fp.test(ev.input.text)) {
          const issueMatch = ev.input.text.match(ISSUE_NUMBER_RE);
          pendingGate = { gate: gateKey, submitted: false, issueNumber: issueMatch ? issueMatch[1] : null };
        }
      }
      continue;
    }

    if (ev.name === COMPUTER_TOOL && SUBMIT_ACTIONS.has(ev.input.action)) {
      if (pendingGate && !pendingGate.submitted) pendingGate.submitted = true;
      continue;
    }

    if (READ_TOOLS.has(ev.name)) {
      const resultText = findToolResultText(lines, ev.toolUseId, ev.index + 1);
      if (pendingGate && pendingGate.submitted && currentDomain === "chatgpt") {
        const isSubstantial = resultText.length >= CONTENT_LENGTH_FLOOR;
        const isNew = !priorReadTexts.some((prev) => textsSimilar(prev, resultText));
        if (isSubstantial && isNew) {
          provenGates.add(pendingGate.gate);
          issueNumbers[pendingGate.gate] = pendingGate.issueNumber;
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
  return { provenGates, issueNumbers, triedBlocked, unreadable: false };
}

// --- Gate 2 proof (enforce-pp-plan-gates.js's rushcut-pp-consultant WebSearch check, #156) ---
//
// Gate 2 requires >=3 distinct WebSearch queries spanning >=2 different source types, per
// rushcut-pp-consultant.md's "Search Engine Guidance" section. Source type is inferred from a
// `site:` operator in the query text (or a changelog-style query with no site: at all, bucketed
// separately) -- a proxy for "did this actually diversify sources," not a guarantee the query was
// well-constructed. Distinctness is by exact query string, not semantic similarity -- a documented
// limitation (two near-identical rephrasings of the same query would count as 2 distinct queries),
// acceptable because Consultant is a cooperative, instructed agent, not adversarial.
const SOURCE_TYPE_PATTERNS = {
  "official-docs": /site:(?!github\.com|stackoverflow\.com|reddit\.com|news\.ycombinator\.com)[\w.-]+\.(dev|app|com\/docs|org)/i,
  "github-issues": /site:github\.com/i,
  stackoverflow: /site:stackoverflow\.com/i,
  reddit: /site:reddit\.com/i,
  hn: /site:news\.ycombinator\.com/i,
  changelog: /\b(changelog|breaking changes|migration)\b/i,
};

// Reads a rushcut-pp-consultant spawn's own transcript and classifies its WebSearch calls by
// source type. Returns { count: number, sourceTypes: Set<string> } -- count is DISTINCT query
// strings (case-sensitive exact match), not total tool_use calls (a retried identical query
// should not inflate the count).
function countWebSearchDiversity(transcriptPath, agentId) {
  const subPath = subagentTranscriptPath(transcriptPath, agentId);
  let lines;
  try {
    const raw = fs.readFileSync(subPath, "utf8");
    lines = raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return { count: 0, sourceTypes: new Set(), unreadable: true };
  }

  const seenQueries = new Set();
  const sourceTypes = new Set();
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
      if (block.type !== "tool_use" || block.name !== "WebSearch") continue;
      const query = String((block.input && block.input.query) || "");
      if (!query) continue;
      seenQueries.add(query);
      for (const [type, pattern] of Object.entries(SOURCE_TYPE_PATTERNS)) {
        if (pattern.test(query)) sourceTypes.add(type);
      }
    }
  }
  return { count: seenQueries.size, sourceTypes, unreadable: false };
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
  countWebSearchDiversity,
  extractVerdict,
  latestVerdict,
};
