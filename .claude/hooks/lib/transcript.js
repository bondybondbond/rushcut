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
// #202: lib/trigger-match.js keeps its OWN copy of this list. It is deliberately duplicated: this
// file is git-tracked and trigger-match.js is local-only (.claude/ is gitignored except 8 files),
// so a tracked file must not require a local-only one. test-gate-hooks.js asserts the two lists
// stay identical and classify text identically -- if you edit one, edit the other.
const NOTIFICATION_MARKERS = ["<task-notification>", "[SYSTEM NOTIFICATION - NOT USER INPUT]"];
function looksLikeNotificationContent(text) {
  return NOTIFICATION_MARKERS.some((marker) => text.startsWith(marker) || text.includes(marker));
}

function isGenuineHumanMessage(entry) {
  if (!entry || entry.type !== "user" || entry.isSidechain) return false;
  if (entry.isMeta) return false; // Skill bodies and other injected content are isMeta:true
  // #202: transcript records carry origin.kind ("human" vs "task-notification"). Reject any
  // record that explicitly says it is not human; a record with NO origin (older transcripts,
  // synthetic test fixtures) still counts as human. NOTE: origin is transcript-only -- the
  // UserPromptSubmit payload documents no such field -- so this is a belt-and-braces check,
  // not a safeguard to rely on alone.
  if (entry.origin && typeof entry.origin === "object" && entry.origin.kind && entry.origin.kind !== "human") return false;
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

// #202: "skill loaded" is recognised two ways, because a typed /skill-name is expanded by Claude
// Code itself and produces NO assistant Skill tool_use:
//   (1) an assistant tool_use calling Skill with that name (model-invoked), or
//   (2) the harness-injected skill-body record: type:"user", isMeta:true, non-sidechain, whose
//       text starts "Base directory for this skill: <...>\skills\<name>". isMeta records are
//       written by the harness, never by pasted or notification text, so this cannot be forged
//       by a string inside a paste; and a failed/blocked expansion writes no body record.
// (The exact record shape for a TYPED slash command is confirmed by the #202 probe fixture.)
function skillBodyText(entry) {
  const content = entry && entry.message && entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.text) || "").join("\n");
  return "";
}
function isSkillBodyRecord(entry, skillName) {
  if (!entry || entry.type !== "user" || entry.isSidechain || !entry.isMeta) return false;
  const text = skillBodyText(entry);
  if (!text.startsWith("Base directory for this skill:")) return false;
  const firstLine = text.split("\n", 1)[0];
  const name = String(skillName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[\\\\/]skills[\\\\/]${name}\\s*$`).test(firstLine.trim());
}

// Scans forward from `fromIndex` (exclusive) looking for evidence the skill was loaded: an
// assistant tool_use calling the Skill tool with the given name, or its skill-body record.
function hasMatchingSkillCallSince(lines, fromIndex, skillName) {
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isSkillBodyRecord(entry, skillName)) return true;
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
    if (isSkillBodyRecord(entry, skillName)) return i; // #202: slash-loaded skill anchor
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

// --- Spawn completion (#216 Step 2) -------------------------------------------------------------
//
// A SYNC spawn is complete the moment its structured toolUseResult arrives (harness-written, not
// text a user can type). An ASYNC spawn, or a sync spawn that was later RESUMED with SendMessage,
// is complete only on STRUCTURED evidence: the subagent's own transcript (agent-<agentId>.jsonl,
// found through the structured toolUseResult.agentId). Notification text is NOT trusted: the
// queue-operation/enqueue and attachment/queued_command records are the channel typed or pasted
// text arrives through, so a message containing the same XML-like tags could forge a completion
// (reproduced against the previous matcher: a typed message completed a pending CPO spawn with
// "VERDICT: APPROVE"). Only a user record whose harness-set origin.kind is "task-notification" is
// accepted, and only as a fallback when the agent file is missing or ends on a legacy null
// stop_reason. "Complete" never means "succeeded": the gates stay safe because they also need tool
// evidence and a final-line VERDICT (see extractVerdict).
const AGENT_ID_RE = /^[A-Za-z0-9]+$/;

// A hook that fires inside a subagent can, depending on the Claude Code version, hand us the
// SUBAGENT'S own file as transcript_path. Gate state belongs to the PARENT session, so map
// <dir>/<sessionId>/subagents/agent-<id>.jsonl back to <dir>/<sessionId>.jsonl by path shape alone
// (never by agent_id: an agent file with no agent_id would otherwise find no dev-plan call and allow).
const AGENT_FILE_SHAPE_RE = /^(.*)[\\/]subagents[\\/]agent-[A-Za-z0-9]+\.jsonl$/;
function parentTranscriptPath(p) {
  if (typeof p !== "string") return p;
  const m = p.match(AGENT_FILE_SHAPE_RE);
  return m ? m[1] + ".jsonl" : p;
}

// Reads a file once per (path, mtime, size): completion and Gate 2/3 evidence share one read per
// hook run, while tests that rewrite a fixture in place still see the new content.
const _fileCache = new Map();
function readFileCached(p) {
  const st = fs.statSync(p);
  const key = String(st.mtimeMs) + ":" + st.size;
  const hit = _fileCache.get(p);
  if (hit && hit.key === key) return hit.raw;
  const raw = fs.readFileSync(p, "utf8");
  _fileCache.set(p, { key, raw });
  return raw;
}

// Classifies a subagent transcript. Returns:
//   { state: "complete", text, lastTs }
//   { state: "legacy-null", text, lastTs }   final stop_reason is null (older Claude Code); only the origin fallback may complete it
//   { state: "missing" }                     ENOENT: the origin fallback may apply
//   { state: "incomplete", why }             never complete, no fallback (torn tail, tool_use pending, last record is a user message,
//                                            API-error final, max_tokens/pause_turn/refusal, empty text, unreadable)
function agentFileCompletion(transcriptPath, agentId) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return { state: "incomplete", why: "no transcript path" };
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return { state: "incomplete", why: "invalid agentId" };
  const agentPath = subagentTranscriptPath(parentTranscriptPath(transcriptPath), agentId);
  let raw;
  try {
    raw = readFileCached(agentPath);
  } catch (e) {
    return e && e.code === "ENOENT" ? { state: "missing" } : { state: "incomplete", why: "unreadable (" + (e && e.code) + ")" };
  }
  if (!raw.endsWith("\n")) return { state: "incomplete", why: "torn tail (no trailing newline)" };
  const rawLines = raw.split("\n").filter(Boolean);
  if (!rawLines.length) return { state: "incomplete", why: "empty file" };
  try {
    JSON.parse(rawLines[rawLines.length - 1]);
  } catch {
    return { state: "incomplete", why: "torn tail (last line does not parse)" };
  }
  const recs = [];
  for (const l of rawLines) {
    try {
      recs.push(JSON.parse(l));
    } catch {
      /* a damaged middle line cannot be the final record, which was parsed above */
    }
  }
  let last = null;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i] && (recs[i].type === "user" || recs[i].type === "assistant")) {
      last = recs[i];
      break;
    }
  }
  if (!last) return { state: "incomplete", why: "no conversational record" };
  if (last.type !== "assistant") return { state: "incomplete", why: "last conversational record is a user message (running or resumed)" };
  const msg = last.message || {};
  // Claude Code writes one record per content block of a message; they share message.id.
  const group = msg.id ? recs.filter((r) => r && r.type === "assistant" && r.message && r.message.id === msg.id) : [last];
  const blocks = group.flatMap((r) => (Array.isArray(r.message && r.message.content) ? r.message.content : []));
  if (blocks.some((b) => b && b.type === "tool_use")) return { state: "incomplete", why: "tool_use pending" };
  if (last.isApiErrorMessage || last.error || msg.model === "<synthetic>") return { state: "incomplete", why: "API-error final message" };
  const text = blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
  if (!text.trim()) return { state: "incomplete", why: "no text in the final message" };
  const lastTs = typeof last.timestamp === "string" ? last.timestamp : null;
  const sr = msg.stop_reason;
  if (sr === "end_turn") return { state: "complete", text, lastTs };
  if (sr === null || sr === undefined) return { state: "legacy-null", text, lastTs };
  return { state: "incomplete", why: "stop_reason " + sr };
}

// --- Resume (SendMessage) state model (#216 Step 2, owner-approved 2026-11-07) -------------------------------
//
// A completed agent that is RESUMED must not keep its earlier verdict, and that earlier verdict must not be
// restored by a timeout either. Everything below is derived from STRUCTURED records only (no clock is read):
//   - A resume is a SendMessage tool_use block (assistant record, a string tool_use id, input.to === this agentId)
//     after the spawn's result. Its OUTCOME is the structured tool_result with that id:
//       is_error, or JSON {"success": false}  -> "rejected": the message never reached the agent (a hook block, a
//                                                validation error); it is ignored and an earlier completion stands.
//       no tool_result yet                      -> "in-flight": treated as accepted (we cannot rule it out).
//       anything else                           -> "accepted".
//   - Only the LATEST accepted/in-flight resume counts. Its run is COMPLETE only when the agent file's final
//     conversational record is a clean end_turn assistant message that is DEMONSTRABLY AFTER that resume: its
//     timestamp must exceed the resume's by more than RESUME_SKEW_MS. A notification is NEVER evidence for a resumed
//     run (it does not say which run it describes). A record before the resume, a record inside
//     the +/- 1 s ambiguity window, and a record with a missing or unparseable timestamp are all NOT evidence:
//     the spawn stays resumePending (incomplete) until demonstrably newer evidence appears or a newer spawn exists.
//   - A resume that never produces that evidence leaves the verdict UNKNOWN, never APPROVE (see latestVerdict).
const RESUME_SKEW_MS = 1000;

function classifySendMessageResult(block) {
  if (block.is_error === true) return "rejected";
  const c = block.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || "").join("\n") : "";
  for (const candidate of [text.trim(), text.trim().split("\n")[0]]) {
    try {
      const j = JSON.parse(candidate);
      if (j && typeof j === "object" && j.success === false) return "rejected";
      break;
    } catch {
      /* not JSON: keep looking, then treat as accepted */
    }
  }
  return "accepted";
}

// Returns [{ id, index, ts, status: "accepted"|"in-flight"|"rejected" }] for every SendMessage addressed to agentId.
function sendMessageResumes(lines, agentId, fromIndex) {
  const calls = [];
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "assistant") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_use" && b.name === "SendMessage" && typeof b.id === "string" && b.id && b.input && b.input.to === agentId) {
        calls.push({ id: b.id, index: i, ts: typeof entry.timestamp === "string" ? entry.timestamp : null, status: "in-flight" });
      }
    }
  }
  if (!calls.length) return calls;
  const byId = new Map(calls.map((c) => [c.id, c]));
  const decided = new Set();
  for (let i = calls[0].index + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "user") continue;
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === "tool_result" && byId.has(b.tool_use_id) && !decided.has(b.tool_use_id)) {
        byId.get(b.tool_use_id).status = classifySendMessageResult(b);
        decided.add(b.tool_use_id);
      }
    }
  }
  return calls;
}

// True only when BOTH timestamps parse and recordTs is later than resumeTs by MORE than RESUME_SKEW_MS.
function demonstrablyAfter(recordTs, resumeTs) {
  const a = Date.parse(recordTs);
  const b = Date.parse(resumeTs);
  return Number.isFinite(a) && Number.isFinite(b) && a > b + RESUME_SKEW_MS;
}

// Fallback completion for an agent whose file is missing / legacy-null: a USER record with the
// harness-set origin.kind "task-notification", after the spawn's result, whose HEADER (everything
// before the first <result>) names this agent and status "completed". Header-parsed, never substring
// matched, so tags quoted inside another agent's <result> cannot complete this spawn. The latest wins.
function originNotificationCompletion(lines, agentId, fromIndex) {
  let best = null;
  for (let i = fromIndex + 1; i < lines.length; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "user" || !entry.origin || entry.origin.kind !== "task-notification") continue;
    const c = entry.message && entry.message.content;
    if (typeof c !== "string" || !c.startsWith("<task-notification>")) continue;
    const cut = c.indexOf("<result>");
    const head = cut === -1 ? c : c.slice(0, cut);
    const tid = (head.match(/<task-id>([^<]*)<\/task-id>/) || [])[1];
    const st = (head.match(/<status>([^<]*)<\/status>/) || [])[1];
    if (tid !== agentId || st !== "completed") continue;
    const m = c.match(/<result>([\s\S]*?)<\/result>/);
    best = { index: i, resultText: m ? m[1] : "" };
  }
  return best;
}

// Full resolution: spawn -> (sync? structured result) / (async or resumed? the agent's own transcript,
// then the origin-verified fallback). Returns { agentId, complete, resultText, why? } or null if the
// spawn itself could not be resolved. `transcriptPath` is the PARENT session transcript; without it an
// async or resumed spawn is INCOMPLETE (there is deliberately no fallback to the old notification rule).
function resolveAgentSpawn(lines, spawn, transcriptPath) {
  const resolved = resolveSpawnResult(lines, spawn.spawnIndex, spawn.toolUseId);
  if (!resolved) return null;
  const agentId = resolved.agentId;
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) return null;
  const resumes = sendMessageResumes(lines, agentId, resolved.resultIndex).filter((r) => r.status !== "rejected");
  const latest = resumes.length ? resumes[resumes.length - 1] : null;
  if (!resolved.isAsync && !latest) {
    return { agentId, complete: true, resultText: resolved.resultText };
  }
  const fc = agentFileCompletion(transcriptPath, agentId);
  const incomplete = (why, extra) => ({ agentId, complete: false, resultText: "", why, ...(extra || {}) });
  if (latest) {
    // A resume was accepted: the earlier completion (sync result or earlier end_turn) is SUPERSEDED. Only a final
    // end_turn record demonstrably after the latest resume completes the resumed run; no timeout, no fallback.
    if (fc.state === "complete" && demonstrablyAfter(fc.lastTs, latest.ts)) return { agentId, complete: true, resultText: fc.text };
    // NO notification fallback here. A completion notification carries no identifier of WHICH run it describes, so a
    // delayed notification of the EARLIER run (delivered after the SendMessage) would otherwise complete the resumed
    // run with the earlier run's verdict (reproduced by the Gate 4 review: a stale APPROVE). When the agent file is
    // missing or ends on a legacy null stop_reason, a resumed run therefore stays resumePending (fails closed).
    const why =
      fc.state === "complete"
        ? "resume accepted; the agent file's final record is not demonstrably after it (before it, inside the 1 s ambiguity window, or a timestamp is missing)"
        : "resume accepted; the resumed run has not completed (" + (fc.why || fc.state) + ")";
    return incomplete(why, { resumePending: true });
  }
  if (fc.state === "complete") {
    return { agentId, complete: true, resultText: fc.text };
  }
  if (fc.state === "missing" || fc.state === "legacy-null") {
    const n = originNotificationCompletion(lines, agentId, resolved.resultIndex);
    if (n) return { agentId, complete: true, resultText: n.resultText };
    return incomplete(fc.state === "missing" ? "agent file missing and no origin-verified notification" : "legacy null stop_reason and no origin-verified notification");
  }
  return incomplete(fc.why);
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
    const raw = readFileCached(subPath);
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
//
// #216 Step 1 (2026-11-07): the verdict is the FINAL non-empty line of the result, and only that
// line. The old "first VERDICT: marker anywhere" rule let a CPO that quoted "VERDICT: OBJECTION"
// in prose and then ended "VERDICT: APPROVE" read as OBJECTION (reproduced live on this very
// session's Gate 1), and let a consultant's prose mention read as a verdict. Accepted final line:
//   [wrapper] [N. ] VERDICT: <APPROVE|OBJECTION|DECLINE-OUT-OF-SCOPE> [same wrapper]
// where the wrapper is one of ** __ * _ ` and must be IDENTICAL at both ends (so `**4. VERDICT:
// APPROVE**`, a real CPO result shape, is read, but `**VERDICT: APPROVE` and `*VERDICT: APPROVE**`
// are not), exactly one space follows the colon, and nothing else may share the line. Anything
// else returns null (fails closed). Surrounding whitespace and CRLF are tolerated.
const VERDICT_LINE_RE = /^(\*\*|__|\*|_|`)?(?:\d+\.\s+)?VERDICT: (APPROVE|OBJECTION|DECLINE-OUT-OF-SCOPE)\1$/;
function extractVerdict(resultText) {
  if (!resultText) return null;
  const lines = String(resultText)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const m = lines[lines.length - 1].match(VERDICT_LINE_RE);
  return m ? m[2] : null;
}

// True when the FINAL non-empty line is a verdict LABEL: after optional markdown/list decoration
// (`#` headings, `>` quotes, `*` `_` backtick emphasis, `-` bullets, "N." numbering, spaces) it
// begins with the word VERDICT and a colon. Prose that merely contains the word ("My VERDICT: ...",
// "The verdict is ...") is not a marker. Used only to tell "no verdict rendered" (skip) from
// "a verdict was attempted but is malformed" (block) in latestVerdict; it never yields a verdict.
const VERDICT_MARKER_LINE_RE = /^[\s#>*_`~\-]*(?:\d+\.\s+)?[\s#>*_`~\-]*VERDICT[*_`]*\s*:/i;
function finalLineIsVerdictMarker(resultText) {
  if (!resultText) return false;
  const lines = String(resultText)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length > 0 && VERDICT_MARKER_LINE_RE.test(lines[lines.length - 1]);
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

// --- Chrome-unavailable fallback proof (#216 Step 1, 2026-11-07) -----------------------------
//
// Why this exists: rushcut-pp-consultant.md's Setup, when Chrome is not connected, requires the
// agent to (1) launch the automation Chrome via PowerShell, (2) probe CDP port 9222, (3) re-check
// list_connected_browsers, and only then fall back to WebSearch. The old rule ("exactly ONE
// tool_use in the whole spawn") could never match that, so a genuine blocked run failed Gate 3.
//
// The rule is an ORDERED sequence over the spawn's tool calls (tool_use order), all of:
//   1. a Chrome LAUNCH call (the documented Start-Process form, see CHROME_SETUP_SHAPES);
//   2. a port-9222 PROBE at or after the LAST launch, whose result is a recognised no-listener
//      message OR Chrome JSON (Browser starts "Chrome/"). Chrome JSON only shows Chrome STARTED;
//      it never by itself shows automation was unavailable. A WebView2 ("Edg/") answer means the
//      port is squatted (the agent must return to CC instead), and any other JSON or an
//      unrecognised/empty result is rejected -- the LAST probe decides;
//   3. a list_connected_browsers call AFTER that probe, and the spawn's LAST list result is
//      exactly `[]` -- this final check, not the probe, is what shows automation was unavailable;
//   4. NO ChatGPT interaction of any kind. Enforced as a CLOSED ALLOW-LIST of tools for the whole
//      spawn (FALLBACK_ALLOWED_TOOLS): any other tool name -- every other Chrome-extension tool
//      (navigate, computer with ANY action, read_page, find, get_page_text, javascript_tool,
//      form_input, uploads, tab/console/network tools, select/switch_browser ...), every
//      computer-use and clipboard tool, Bash/Edit/Write, and any tool that does not exist yet --
//      disqualifies. New tools therefore fail closed by default.
//
// PowerShell is the one allowed tool that can do arbitrary things, so each PowerShell call must be
// EITHER one of the nine CHROME_SETUP_SHAPES below (the sequence evidence) OR pass the separate
// scratch-file screen isScratchPowerShell (permitted, but it carries NO weight: it is never part
// of the evidence that the fallback was attempted, and a missing/failed scratch write never
// breaks a valid sequence). Any other PowerShell call disqualifies. Anything outside the grammar
// fails closed -- a deliberate trade: a diagnosable false negative beats a silently widened gate.
const POWERSHELL_TOOL = "PowerShell";
const TABS_CONTEXT_TOOL = "mcp__claude-in-chrome__tabs_context_mcp";
const FALLBACK_ALLOWED_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  POWERSHELL_TOOL,
  LIST_BROWSERS_TOOL,
  TABS_CONTEXT_TOOL,
]);

const _CHROME_EXE = String.raw`"C:\\Program Files\\Google\\Chrome\\Application\\chrome\.exe"`;
const _LAUNCH = String.raw`Start-Process ${_CHROME_EXE} -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\\Users\\[^\\'"\r\n;]+\\AppData\\Local\\Google\\Chrome\\User Data\\Profile \d+','--no-first-run','--no-default-browser-check'`;
const _SLEEP = String.raw`Start-Sleep -Seconds (?:[1-9]|[1-9]\d|1[01]\d|120)`;
const _STR = String.raw`"[A-Za-z0-9 :._-]+"`;
const _URL = String.raw`http://127\.0\.0\.1:9222/json/version`;
const _TIMEOUT = String.raw`(?: -TimeoutSec (?:[1-9]|[12]\d|30))?`;
const _IWR = String.raw`\(Invoke-WebRequest(?: -UseBasicParsing)?(?: -Uri)? "?${_URL}"?(?: -UseBasicParsing)?${_TIMEOUT}\)\.Content`;
const _CATCH_BODY = String.raw`(?:"[A-Za-z0-9 :._-]*"(?: \+ \$_\.Exception\.Message)?|"[A-Za-z0-9 :._-]*\$\(\$_\.Exception\.Message\)")`;
const _PROBE = String.raw`(?:${_IWR}|try \{ ${_IWR} \} catch \{ ${_CATCH_BODY} \})`;

// The ONE authoritative grammar: exactly nine permitted single-line command shapes, joined by
// "; " (semicolon, optional single space). The tests carry their own independent literal
// fixtures for all nine and for malformed variants -- they do not read this table.
const CHROME_SETUP_SHAPES = [
  { name: "launch", hasLaunch: true, hasProbe: false, parts: [_LAUNCH] },
  { name: "launch;sleep", hasLaunch: true, hasProbe: false, parts: [_LAUNCH, _SLEEP] },
  { name: "launch;sleep;probe", hasLaunch: true, hasProbe: true, parts: [_LAUNCH, _SLEEP, _PROBE] },
  { name: "launch;sleep;string", hasLaunch: true, hasProbe: false, parts: [_LAUNCH, _SLEEP, _STR] },
  { name: "launch;probe", hasLaunch: true, hasProbe: true, parts: [_LAUNCH, _PROBE] },
  { name: "launch;string", hasLaunch: true, hasProbe: false, parts: [_LAUNCH, _STR] },
  { name: "sleep", hasLaunch: false, hasProbe: false, parts: [_SLEEP] },
  { name: "sleep;string", hasLaunch: false, hasProbe: false, parts: [_SLEEP, _STR] },
  { name: "probe", hasLaunch: false, hasProbe: true, parts: [_PROBE] },
].map((s) => ({ name: s.name, hasLaunch: s.hasLaunch, hasProbe: s.hasProbe, re: new RegExp("^" + s.parts.join("; ?") + "$") }));

// Returns the matching shape object, or null. Whitespace around the whole command is trimmed;
// embedded newlines never match.
function isChromeSetupCommand(cmd) {
  if (typeof cmd !== "string") return null;
  const t = cmd.trim();
  if (!t || t.length > 2000) return null;
  return CHROME_SETUP_SHAPES.find((s) => s.re.test(t)) || null;
}

// Replaces each single-quoted here-string (`@'` newline ... newline `'@`) with an empty one so its
// body is ignored. This is deliberately a plain regex, NOT a PowerShell tokeniser: the closed
// grammar below fully matches what is left, so a fake opener (`# @'`, `"@'`) that strips live code
// out of view leaves a stray `#`, `"`, `'` or `@''@` in a statement that no shape accepts, and the
// whole call is rejected. An unterminated here-string is left in place and is likewise rejected.
// PRECONDITIONS (guaranteed by isScratchPowerShell, which is its only caller): line endings are
// already normalised to LF, and the command contains none of U+2018..U+201B, so PowerShell and this
// regex end a body at the same place.
function stripHereStrings(cmd) {
  return cmd.replace(/@'\n(?:[\s\S]*?\n)?'@/g, "@''@");
}

// --- Scratch-write grammar (pre-commit review, 2026-11-07) ------------------------------------
//
// A genuine Chrome-unavailable run also writes its Gate 3 findings table to
// %TEMP%\rushcut\pp-consultant-gate3-<n>.md with a few PowerShell calls. Those calls are allowed
// but are NOT evidence of anything. The first version of this screen was a cmdlet/word filter, and
// the review showed aliases (`saps`, `start`), `iex` and .NET static calls walk straight through it.
// It is now a CLOSED POSITIVE GRAMMAR, in the same spirit as CHROME_SETUP_SHAPES: after single-
// quoted here-string bodies are stripped (stripHereStrings), the command is split into statements
// on newlines and semicolons, and EVERY statement must fully match one of the shapes below
// (canonical casing, fixed cmdlets, fixed parameters). Anything else -- another cmdlet, an alias,
// a pipe other than the listed ones, `&`, `iex`, `::`, `$(...)`, a URL, a drive path, a different
// filename or env var -- fails the whole call, and so disqualifies the fallback. The shapes were
// generalised from the 13 distinct scratch-write commands found in real consultant runs; an
// unusual-but-harmless variant failing is the accepted trade (a diagnosable false negative).
// Variables are split by ROLE so a variable filled from a here-string can never be used as a path,
// and a path variable can only ever hold a value built from $env:TEMP (CPO Gate 4 review:
// `$p = @'C:\evil'@; Set-Content -Path $p ...` wrote anywhere when any variable name was allowed).
const _PV = String.raw`\$(?:p|path|f|file|d|dir|folder|out)(?![A-Za-z0-9])`; // path variables
const _CV = String.raw`\$(?:c|content|body|text)(?![A-Za-z0-9])`; // content variables
const _AV = String.raw`(?:${_PV}|${_CV})`; // either, for echoes only
const _SN = String.raw`pp-consultant-gate3-\d+\.md`;
const _TEMPDIR = String.raw`\$env:TEMP\\rushcut`;
const _TEMPFILE = String.raw`\$env:TEMP\\rushcut\\${_SN}`;
const _PATHARG = String.raw`(?:${_PV}|"(?:${_TEMPDIR}|${_TEMPFILE})")`;
const _MSG = String.raw`"(?:[A-Za-z0-9 :._-]|${_TEMPFILE}|${_AV})*"`;
const SCRATCH_STATEMENT_SHAPES = [
  // $d = Join-Path $env:TEMP 'rushcut'   /   $p = Join-Path $env:TEMP 'rushcut\pp-consultant-gate3-N.md'
  String.raw`${_PV} = Join-Path \$env:TEMP '(?:rushcut|rushcut\\${_SN})'`,
  // $f = Join-Path $d 'pp-consultant-gate3-N.md'
  String.raw`${_PV} = Join-Path ${_PV} '${_SN}'`,
  // $c = @'...'@   (body already stripped to @''@) -- content variables only, never a path variable
  String.raw`${_CV} = @''@`,
  // if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
  String.raw`if \(-not \(Test-Path ${_PV}\)\) \{ New-Item -ItemType Directory (?:-Force |-Path |-Force -Path )${_PV} \| Out-Null \}`,
  // New-Item -ItemType Directory -Force "$env:TEMP\rushcut" | Out-Null
  String.raw`New-Item -ItemType Directory -Force "${_TEMPDIR}" \| Out-Null`,
  String.raw`Test-Path ${_PV}`,
  // Set-Content -Path $f -Value $c -Encoding utf8
  String.raw`Set-Content -(?:Path|LiteralPath) ${_PATHARG} -Value ${_CV} -Encoding utf8`,
  // $content | Out-File -FilePath $path -Encoding utf8
  String.raw`${_CV} \| Out-File -FilePath ${_PATHARG} -Encoding utf8`,
  // result echoes: bare $var, "msg", Write-Output "msg", Write-Host "msg", Write-Output ("bytes: " + ...)
  _AV,
  _MSG,
  String.raw`Write-(?:Output|Host) ${_MSG}`,
  String.raw`Write-Output \("bytes: " \+ \(Get-Item ${_PATHARG}\)\.Length\)`,
  // (Get-Item $p).Length   /   Get-Item $p | Select-Object FullName, Length
  String.raw`\(Get-Item ${_PATHARG}\)\.(?:Length|FullName)`,
  String.raw`Get-Item ${_PATHARG} \| Select-Object FullName, Length(?:, LastWriteTime)?`,
].map((s) => new RegExp("^" + s + "$"));

function isScratchPowerShell(cmd) {
  if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 200000) return false;
  // The stripper below must end a here-string body exactly where PowerShell does. Two verified
  // disagreements (Windows PowerShell 5.1, CPO Gate 4 review + CC re-test) are closed here:
  //  - PowerShell treats the Unicode single quotes U+2018..U+201B as quote characters, including as
  //    a here-string TERMINATOR, so a smart-quote terminator followed by `; <live code>` hid a
  //    statement from the grammar. Those four characters are rejected anywhere in the command.
  //  - A lone CR (not CRLF) before `'@` also terminates the body in PowerShell. Line endings are
  //    therefore normalised to LF before stripping and splitting.
  // Control characters other than tab/CR/LF are rejected. Other non-ASCII text (an em dash in the
  // findings table body, say) is harmless inside a stripped body and can never match a shape
  // outside one, so it is not rejected wholesale. JS trim() is not used on statements because it
  // would also strip NBSP / BOM / U+2028 that the shapes must see.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u2018-\u201b]/.test(cmd)) return false;
  const t = stripHereStrings(cmd.replace(/\r\n?/g, "\n"));
  const statements = t
    .split(/\n|;/)
    .map((s) => s.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter(Boolean);
  if (statements.length === 0) return false;
  return statements.every((s) => SCRATCH_STATEMENT_SHAPES.some((re) => re.test(s)));
}

// Classifies a port-9222 probe's tool_result text.
function classifyProbeResult(text) {
  const t = String(text || "");
  if (/"Browser"\s*:\s*"Edg\//.test(t)) return "squatted";
  if (/"Browser"\s*:\s*"Chrome\//.test(t)) return "chrome-json";
  if (/"Browser"\s*:/.test(t)) return "other-json";
  if (/Unable to connect to the remote server|actively refused|No connection could be made/i.test(t)) return "no-listener";
  return "unrecognised";
}
const PROBE_RESULTS_OK = new Set(["no-listener", "chrome-json"]);

// Returns { ok, reason }: `reason` is null when ok, otherwise the FIRST thing that broke the
// documented sequence, worded so a human (or a later hook message) can see exactly what to fix.
function evaluateChromeFallback(events, lines) {
  let lastLaunch = -1;
  let lastProbe = -1;
  let lastProbeOk = false;
  let lastList = -1;
  let lastListEmpty = false;
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    if (!FALLBACK_ALLOWED_TOOLS.has(ev.name)) {
      return { ok: false, reason: `tool call #${k + 1} is not on the fallback allow-list: ${ev.name}` };
    }
    if (ev.name === POWERSHELL_TOOL) {
      const cmd = ev.input && ev.input.command;
      const shape = isChromeSetupCommand(cmd);
      if (shape) {
        if (shape.hasLaunch) lastLaunch = k;
        if (shape.hasProbe) {
          lastProbe = k;
          lastProbeOk = PROBE_RESULTS_OK.has(classifyProbeResult(findToolResultText(lines, ev.toolUseId, ev.index + 1)));
        }
      } else if (!isScratchPowerShell(cmd)) {
        return {
          ok: false,
          reason: `PowerShell call #${k + 1} is outside the allowed Chrome-setup / scratch-write grammar: ${String(cmd).replace(/\s+/g, " ").slice(0, 300)}`,
        };
      }
      continue;
    }
    if (ev.name === LIST_BROWSERS_TOOL) {
      lastList = k;
      lastListEmpty = findToolResultText(lines, ev.toolUseId, ev.index + 1).trim() === "[]";
    }
  }
  if (lastLaunch < 0) return { ok: false, reason: "no documented Chrome launch call (Start-Process chrome.exe ...) was made" };
  if (lastProbe < lastLaunch) return { ok: false, reason: "no port-9222 probe at or after the last Chrome launch" };
  if (!lastProbeOk) return { ok: false, reason: "the last port-9222 probe result was not a recognised no-listener message or Chrome JSON (WebView2 'Edg/', other JSON and unrecognised text are rejected)" };
  if (lastList <= lastProbe) return { ok: false, reason: "no list_connected_browsers call after the last probe" };
  if (!lastListEmpty) return { ok: false, reason: "the final list_connected_browsers result is not [] (a browser is connected, so the fallback does not apply)" };
  return { ok: true, reason: null };
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
    const raw = readFileCached(subPath);
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

  let currentDomain = null;
  const priorReadTexts = [];
  const provenGates = new Set();
  const issueNumbers = { breadth: null, depth: null };
  let pendingGate = null; // { gate, submitted, issueNumber }

  for (const ev of events) {
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

  // triedBlocked = the DOCUMENTED Chrome-unavailable fallback genuinely happened (#216 Step 1,
  // 2026-11-07; replaces the old "exactly one tool_use, list_connected_browsers" shape, which the
  // consultant's current Setup -- launch Chrome, probe port 9222, re-check -- can never produce).
  // See evaluateChromeFallback below for the exact ordered rule. A spawn that proved a gate by
  // real ChatGPT cycles never needs the fallback, so provenGates must be empty.
  const fallback =
    provenGates.size === 0
      ? evaluateChromeFallback(events, lines)
      : { ok: false, reason: "not applicable: this spawn completed at least one real ChatGPT query cycle" };
  // `triedBlockedReason` (null when triedBlocked) is informational only -- no hook reads it yet;
  // surfacing it in the plan-gates denial message is a hook edit and is deliberately left out of
  // Step 1 (see the #216 plan).
  return { provenGates, issueNumbers, triedBlocked: fallback.ok, triedBlockedReason: fallback.reason, unreadable: false };
}

// --- Gate 2 proof (enforce-pp-plan-gates.js's rushcut-pp-consultant WebSearch check, #156) ---
//
// Gate 2 requires >=3 distinct PRODUCTIVE WebSearch queries spanning >=2 evidence types, per
// rushcut-pp-consultant.md's "Search Engine Guidance" section.
//
// #216 Step 1 (2026-11-07) -- evidence, not intent. The old rule typed a query from a `site:`
// operator in its TEXT (and a changelog keyword), which (a) mis-typed real official-docs hosts
// (`site:code.claude.com` matched no pattern, so the consultant could not pass Gate 2), and (b)
// credited what was REQUESTED rather than what came back (a `site:code.claude.com` search really
// returned platform.claude.com and hex.pm links). Now:
//   - A WebSearch counts only if it is not an error AND its result's `Links:` array holds at least
//     one parseable http(s) URL ("productive"). Empty, missing/unparseable-Links and error results
//     earn nothing. Distinctness is by exact query string, so a repeated query counts once.
//   - A source type comes from the HOST of an actually-returned URL (and of a successful
//     WebFetch's url: not an error, >= WEBFETCH_MIN_CHARS of result). `site:` text and the
//     `allowed_domains` argument are requests, never evidence. WebFetch adds evidence TYPES only;
//     it never raises the query count.
//   - Host typing is exact-host-or-dot-suffix on the lower-cased, trailing-dot-stripped hostname
//     from `new URL()` (so github.com.evil.com, evilgithub.com and github.com@evil.com are NOT
//     github.com). Named hosts get their own type; a named list of official-documentation hosts is
//     `official-docs`; EVERY other host collapses into the single type `web-other`, however many
//     different unknown hosts appear. Changelog/releases URL paths no longer create a type.
// Documented limits: the 2-type threshold is deliberately lenient (web-other plus any one named
// type passes; replayed on 11 real consultant runs the old rule passed 3, this passes 10); the
// `Links:` line format is the harness's WebSearch output -- if it ever changes, queries become
// unproductive and Gate 2 fails loudly (closed), never silently open.
const GATE2_MIN_FETCH_CHARS = 200;
const GATE2_NAMED_HOSTS = {
  "github.com": "github-issues",
  "stackoverflow.com": "stackoverflow",
  "reddit.com": "reddit",
  "news.ycombinator.com": "hn",
};
const GATE2_OFFICIAL_DOCS_HOSTS = [
  "code.claude.com",
  "docs.claude.com",
  "platform.claude.com",
  "docs.anthropic.com",
  "developer.mozilla.org",
  "ffmpeg.org",
  "trac.ffmpeg.org",
  "tauri.app",
  "docs.rs",
  "doc.rust-lang.org",
  "learn.microsoft.com",
  "nodejs.org",
  "w3.org",
  "whatwg.org",
];

function hostIsOrUnder(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// Returns the evidence type for a URL, or null if it is not a usable http(s) URL.
function evidenceTypeForUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  for (const [domain, type] of Object.entries(GATE2_NAMED_HOSTS)) {
    if (hostIsOrUnder(host, domain)) return type;
  }
  for (const domain of GATE2_OFFICIAL_DOCS_HOSTS) {
    if (hostIsOrUnder(host, domain)) return "official-docs";
  }
  return "web-other";
}

// Extracts the URLs from a WebSearch result's one-line `Links: [{"title":..,"url":..},...]`.
function parseSearchResultUrls(resultText) {
  const m = String(resultText || "").match(/^Links:\s*(\[.*\])\s*$/m);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.map((x) => x && x.url).filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

function blockResultText(block) {
  const c = block && block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.text) || "").join("\n");
  return "";
}

// Reads a rushcut-pp-consultant spawn's own transcript and scores its WebSearch/WebFetch
// EVIDENCE. Returns { count, sourceTypes, unreadable } -- count is the number of DISTINCT
// productive query strings; sourceTypes is the set of evidence types from returned hosts.
function countWebSearchDiversity(transcriptPath, agentId) {
  const subPath = subagentTranscriptPath(transcriptPath, agentId);
  let lines;
  try {
    const raw = readFileCached(subPath);
    lines = raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return { count: 0, sourceTypes: new Set(), unreadable: true };
  }

  const pending = new Map(); // tool_use id -> { name, input }
  const productiveQueries = new Set();
  const sourceTypes = new Set();
  for (const l of lines) {
    let entry;
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    const content = entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    if (entry.type === "assistant") {
      for (const block of content) {
        if (block.type === "tool_use" && (block.name === "WebSearch" || block.name === "WebFetch")) {
          pending.set(block.id, { name: block.name, input: block.input || {} });
        }
      }
    } else if (entry.type === "user") {
      for (const block of content) {
        if (!block || block.type !== "tool_result" || !pending.has(block.tool_use_id)) continue;
        const call = pending.get(block.tool_use_id);
        if (block.is_error) continue;
        const text = blockResultText(block);
        if (call.name === "WebSearch") {
          const query = String(call.input.query || "");
          const types = parseSearchResultUrls(text).map(evidenceTypeForUrl).filter(Boolean);
          if (!query || types.length === 0) continue;
          productiveQueries.add(query);
          for (const t of types) sourceTypes.add(t);
        } else if (text.trim().length >= GATE2_MIN_FETCH_CHARS) {
          const t = evidenceTypeForUrl(call.input.url);
          if (t) sourceTypes.add(t);
        }
      }
    }
  }
  return { count: productiveQueries.size, sourceTypes, unreadable: false };
}

// Returns the VERDICT of the MOST RECENT completed spawn among `spawns` (each { spawnIndex,
// toolUseId }, as returned by findAgentSpawnsSince), or null if none are complete / none
// rendered a marker. Deliberately "most recent," not "any" -- confirmed necessary by
// rushcut-pp-consultant's own Round 4 review (2026-07-23): checking presence via `.some()`
// across ALL spawns let a stale early-round APPROVE, or an unrelated round's marker, satisfy a
// gate even when the LATEST relevant round was actually OBJECTION. "Most recent" also correctly
// handles the intended fix-and-reverify flow (Round 2 objects -> orchestrator fixes -> Round 2
// re-run approves -> the later spawn's APPROVE is what counts, not the earlier OBJECTION).
//
// #216 Step 1 (pre-commit review, 2026-11-07): a spawn that has NO verdict marker at all (e.g. the
// lightweight acceptance-checkpoint sign-off) is skipped, so an earlier verdict stands. But a spawn
// whose FINAL line is a recognisable verdict marker that the strict parser rejects (for example
// `## VERDICT: OBJECTION`) is an attempted verdict, not silence: if it is the newest, the result is
// null and no earlier APPROVE may authorise anything. The parser itself stays strict.
function latestVerdict(lines, spawns, transcriptPath) {
  let best = null; // { spawnIndex, verdict } -- verdict is null for a newest malformed marker
  for (const spawn of spawns) {
    const resolved = resolveAgentSpawn(lines, spawn, transcriptPath);
    if (!resolved) continue;
    if (!resolved.complete) {
      // A spawn whose accepted resume has not completed has an UNKNOWN verdict: it is the newest word, so it
      // yields null (blocks) instead of being skipped -- skipping would let an OLDER spawn's APPROVE become
      // authoritative while the re-review is pending. A first run that never completed is still skipped, as before.
      if (resolved.resumePending && (!best || spawn.spawnIndex > best.spawnIndex)) best = { spawnIndex: spawn.spawnIndex, verdict: null };
      continue;
    }
    let verdict = extractVerdict(resolved.resultText);
    if (verdict === null) {
      if (!finalLineIsVerdictMarker(resolved.resultText)) continue;
      verdict = null; // malformed marker: counts as the newest (invalid) verdict
    }
    if (!best || spawn.spawnIndex > best.spawnIndex) best = { spawnIndex: spawn.spawnIndex, verdict };
  }
  return best ? best.verdict : null;
}

// --- Transcript reading with a bounded retry (#216 Step 2) ---------------------------------------
//
// The hooks documentation says the transcript "is written asynchronously and may lag the in-memory
// conversation", which is also the likely cause of the #201 false "Gate 2 missing". `readTranscriptLines`
// is a single read; `readTranscriptWithRetry` retries a FAILED read only (attempts x delayMs, injectable
// readFile/sleep so tests never depend on the wall clock). Returns { ok:true, lines, attempts } or
// { ok:false, code, attempts }.
function readTranscriptLines(p, readFile = fs.readFileSync) {
  if (typeof p !== "string" || !p) return { ok: false, code: "NO_PATH" };
  try {
    const raw = readFile(p, "utf8");
    return { ok: true, lines: raw.length ? raw.split("\n").filter(Boolean) : [] };
  } catch (e) {
    return { ok: false, code: (e && e.code) || "ERR" };
  }
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin: only reached where Atomics.wait is unavailable */
    }
  }
}
function readTranscriptWithRetry({ path: p, attempts = 3, delayMs = 150, readFile = fs.readFileSync, sleep = sleepSync } = {}) {
  let last = { ok: false, code: "NO_ATTEMPT" };
  for (let i = 1; i <= attempts; i++) {
    last = readTranscriptLines(p, readFile);
    if (last.ok) return { ...last, attempts: i };
    if (last.code === "NO_PATH") return { ...last, attempts: i }; // retrying a missing path cannot help
    if (i < attempts) sleep(delayMs);
  }
  return { ...last, attempts };
}

module.exports = {
  findLastHumanMessage,
  parentTranscriptPath,
  agentFileCompletion,
  readTranscriptLines,
  readTranscriptWithRetry,
  AGENT_ID_RE,
  hasMatchingSkillCallSince,
  findLastMatchingSkillCall,
  isSkillBodyRecord,
  isGenuineHumanMessage,
  NOTIFICATION_MARKERS,
  looksLikeNotificationContent,
  hasAgentSpawnSince,
  findAgentSpawnsSince,
  resolveAgentSpawn,
  subagentTranscriptPath,
  classifySubagentEvidence,
  countGateCycles,
  countWebSearchDiversity,
  extractVerdict,
  latestVerdict,
  CHROME_SETUP_SHAPES,
  isChromeSetupCommand,
  isScratchPowerShell,
};
