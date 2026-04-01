---
name: rushcut-dev-plan
description: "Kicks off a RushCut development session by activating Serena, researching the batch/request, and producing a concise implementation plan. Use when the user describes new development, a new batch, or continuing an existing plan. Triggers: user says 'new batch', 'lets start', 'i want to build', 'i want to fix', 'plan this', 'plan the next batch', or pastes a batch spec or feature request at the start of a session."
---

# RushCut Dev Session — Research & Plan

Work through each step in order. Output is **bullet-points only** — no prose paragraphs.

---

## Step 1 — Activate Serena

```
mcp__plugin_serena_serena__activate_project  path=C:\apps\rushcut
```

Confirm activation, then proceed.

---

## Step 2 — Ingest the request

Read the user's `<context>` block carefully. Identify:
- Is this a new feature, a bug fix, a performance issue, or continuing a deferred batch?
- What specific components are involved (pipeline, Tauri/Rust, React UI, E2E)?
- Are there any explicit constraints or "must not regress" callouts?

---

## Step 3 — Load existing knowledge (parallel reads)

Run these in parallel:

1. **Memory** — `C:\Users\Manasak\.claude\projects\C--apps-rushcut\memory\MEMORY.md` — current state, batch status, critical constraints
2. **Context doc** — `docs/CONTEXT.md` — current sprint state, next priority, deferred items
3. **LEARNINGS.md** — `docs/LEARNINGS.md` — known failure patterns relevant to the request
4. **Relevant rules file** — pick the matching file(s) from `.claude/rules/` (pipeline.md / rust-tauri.md / e2e.md) based on which layer is touched

Only read additional source files if a specific function, config, or data structure is directly relevant to the plan. Use Serena's `get_symbols_overview` or `find_symbol` — do not read entire files unless unavoidable.

---

## Step 4 — Web research (if needed)

If the task involves a non-trivial technical approach (FFmpeg filter, Rust crate, WebdriverIO API, performance technique):
- Run 1–2 targeted web searches
- Bullet-point the relevant findings only — no quotes, no verbatim excerpts
- Flag if the approach contradicts anything in LEARNINGS.md or the rules files

Skip this step entirely if the approach is already well-understood from the existing codebase context.

---

## Step 5 — Log data check

Before planning any fix for A/V sync, performance, pipeline output quality, or audio issues:
- Check: does the codebase already emit `[sync-check]`, timing logs, or relevant debug output for this problem?
- If **yes** and we have real log output to work from — proceed to plan the fix.
- If **no real log data exists** — add a logging-first task at the top of the plan. Instrument first, render, paste logs, then fix. State this explicitly.

---

## Step 6 — Produce the plan

Output a concise, numbered implementation plan. Use this structure:

### Findings (bullet-points)
- Key facts about the current state relevant to this task
- Any gotchas, known failure modes, or constraints that apply
- Web research highlights (if Step 4 ran)

### Refactoring consideration
- State explicitly: should any refactoring happen **before** or **after** the feature/fix?
- If before: one bullet explaining why (e.g. the fix is blocked by a structural issue)
- If after: one bullet (e.g. cleanup once the feature is proven)
- If none needed: "No refactoring required"

### Implementation plan
1. Numbered steps — each step is one atomic change (one file, one function, one config)
2. Flag any step that touches a "critical constraint" from MEMORY.md
3. If log-first is needed (from Step 5), step 1 must be: "Add [X] logging to [file/function], then render and paste output before proceeding"

### Questions / blockers
- List anything that must be confirmed before starting (missing requirements, ambiguous scope)
- Ask the user directly — do not proceed past this point until answered

---

## Step 7 — Eval reminder

End the plan with this line (always):

> **On completion:** Run `/rushcut-eval` to verify the full UI flow.

Do NOT run `/rushcut-wrapup` — the user will decide when to wrap.

---

## Rules

- Never write code during this skill — research and plan only
- Never exceed 3 levels of nesting in bullet lists
- If the request is a continuation of a deferred batch, re-state what was deferred and why before proposing the plan
- If the plan has more than 8 steps, flag it and ask the user if scope should be reduced
