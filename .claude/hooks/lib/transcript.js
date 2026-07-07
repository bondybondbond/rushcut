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

function readLines(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf8");
    return raw.length ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return null;
  }
}

function isGenuineHumanMessage(entry) {
  if (!entry || entry.type !== "user" || entry.isSidechain) return false;
  if (entry.isMeta) return false; // Skill bodies and other injected content are isMeta:true
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    // tool_result blocks are synthetic harness->model content, not human-typed text
    return content.length > 0 && content.every((b) => b && b.type === "text");
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

module.exports = { findLastHumanMessage, hasMatchingSkillCallSince };
