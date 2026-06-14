---
name: rushcut-dev-plan
description: "Kicks off a RushCut development session by researching the batch/request and producing a concise implementation plan. Use when the user describes new development, a new batch, or continuing an existing plan. Triggers: user says 'new batch', 'lets start', 'i want to build', 'i want to fix', 'plan this', 'plan the next batch', or pastes a batch spec or feature request at the start of a session."
---

# RushCut Dev Session — Research & Plan

Work through each step in order. Output is **bullet-points only** — no prose paragraphs.

---

## Step 1 — Ingest the request
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
5. **Design system** — `docs/DESIGN.md` — **always read this when the request touches any UI component** (new screen, modified component, copy change, colour/layout decision)
6. **GitHub backlog** — **only when the user asks "what's next?" or "plan the next batch"**: run `gh project item-list 1 --owner bondybondbond --format json` and find the highest RICE-score item(s) with Status=Todo/Planned. This is the primary source for what to work on — `docs/PRD-DEV.md` is strategic-only (Phase goal, active batch specs, Phase 3 preview) and no longer tracks individual backlog items.

Only read additional source files if a specific function, config, or data structure is directly relevant to the plan. Use scoped `Read` with line offsets or `Grep` for targeted symbol searches — do not read entire large files unless unavoidable.

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

### Design compliance (UI work only — skip if no UI changes)

For every UI element proposed (new component, modified screen, copy change):
- State which DESIGN.md tokens apply: background, surface, text colour, button pattern, chip accent
- Flag any risk of deviation — e.g. "this tooltip needs `text-[#a3a3a3]` not Tailwind `text-gray-400`"
- If DESIGN.md does not cover a pattern needed for this batch (new component type, layout pattern, animation), explicitly note: "DESIGN.md gap — `docs/DESIGN.md` should be extended with [X] before or during this batch"
- **Hard rules from DESIGN.md (never violate):**
  - No `text-gray-*` — only `#e5e5e5` (primary) or `#a3a3a3` (secondary)
  - No `text-xs` for readable content — minimum `text-sm`
  - Headings: `text-[#FF8A65]`; body: `text-[#e5e5e5]`; secondary: `text-[#a3a3a3]`
  - Primary CTA: peach `#FF8A65` on dark `#0a0a0a`; secondary: outlined `border-white/30`
  - Chip active accent: `#99B3FF` (blue); card colour picker ring: `#FF8A65` (peach only)
  - Progress bars: always green `#22c55e`

### Acceptance checks (define before building — user must confirm)

**MANDATORY:** Before writing a single line of code, ask the user:

> "Before I start — what does success look like for you? Describe what you'd need to see (or interact with) to call this done. I'll use your description to set the acceptance criteria and take screenshots as proof when I'm finished."

Wait for the user's response. Do not proceed to the implementation plan until you have it.

From the user's description, derive concrete binary pass/fail checks. These drive the targeted eval during build — not a final checklist.

Format: `[ ] Screen/component — what must be true`

Examples:
- `[ ] Trimmer — film strip starts empty on fresh project`
- `[ ] TrimBar — playhead moves when track is clicked`
- `[ ] Transitions — chip highlights in #99B3FF when selected`
- `[ ] No console errors on any navigated route`

Keep to ≤5 checks per screen. If a check can't be stated as binary pass/fail, it's too vague — rewrite it.

For UI checks, always include at minimum:
- `[ ] [Screen] — headings are peach, body text is white, no grey text visible`
- `[ ] [Screen] — no missing thumbnails or broken images`

### Refactoring consideration
- State explicitly: should any refactoring happen **before** or **after** the feature/fix?
- If before: one bullet explaining why (e.g. the fix is blocked by a structural issue)
- If after: one bullet (e.g. cleanup once the feature is proven)
- If none needed: "No refactoring required"

### Implementation plan
1. Numbered steps — each step is one atomic change (one file, one function, one config)
2. Flag any step that touches a "critical constraint" from MEMORY.md
3. If log-first is needed (from Step 5), step 1 must be: "Add [X] logging to [file/function], then render and paste output before proceeding"
4. After the last step touching each screen, insert: `→ EVAL: run targeted check on [screen name]` — this is where in-build eval happens

### Questions / blockers
- List anything that must be confirmed before starting (missing requirements, ambiguous scope)
- Ask the user directly — do not proceed past this point until answered

---

## Step 7 — In-build eval cadence

After implementing each screen or component (not at the end of the whole batch), run a targeted eval on **only that changed screen**.

**This step is MANDATORY and non-negotiable. E2E spec passing does NOT substitute for it.**
E2E tests verify DOM structure and element presence. They do NOT verify visual rendering —
broken images, invisible overlays, wrong colours, and corrupt data all pass E2E. Screenshots
are the only way to confirm what the user will actually see.

1. Launch app if not running (`mcp__chrome-devtools__list_pages` to check, `preview_start` or launch binary if needed)
2. Navigate to the changed screen using `mcp__chrome-devtools__navigate_page`
3. `mcp__chrome-devtools__take_screenshot` — Screenshot A: **IMMEDIATE** load state (thumbnails should be visible NOW from scan.py DB data — no pipeline wait needed)
4. **Pipeline-dependent assets (waveforms, proxies):** If the screen has assets that require the proxy pipeline (waveforms, video playback), you MUST wait for the pipeline to complete before screenshotting them. Do NOT skip this wait and claim success.
   - **How to wait:** Watch for the "Preview optimised" green indicator in the Trimmer status row (polls every 4s). Use `mcp__chrome-devtools__wait_for` with a selector matching that element, or poll with `mcp__chrome-devtools__take_screenshot` every 10s until waveform is visible. Maximum wait: 120s for a 3-clip project.
   - **Thumbnails specifically:** These come from scan.py and are in the DB at load time. If thumbnails are NOT visible in Screenshot A (immediately on load), the fix has NOT worked — do not wait for the pipeline.
5. `mcp__chrome-devtools__take_screenshot` — Screenshot B: post-pipeline state (waveform visible, video playing)
6. Perform the primary interaction for that screen
7. `mcp__chrome-devtools__take_screenshot` — Screenshot C: post-interaction state
8. Check the acceptance checks defined above — mark each `[x]` or `[FAIL: reason]`
9. `mcp__chrome-devtools__list_console_messages` — note any errors

**Special rules for specific change types:**
- **Thumbnail / image rendering fixes:** Screenshot A (immediate load) must show actual image content in pantry tiles and filmstrip, not placeholder icons or broken img elements. Thumbnails come from scan.py — they are in the DB and must be visible with zero pipeline wait. If tiles show a broken-image icon or the placeholder SVG at load time, the fix has NOT worked — do not mark as passing.
- **Waveform / overlay changes:** Screenshot B (post-pipeline) must show the waveform visibly rendered on the TrimBar. You MUST wait for the pipeline to emit WAVEFORM_DONE events (watch for waveform texture in the TrimBar). If the TrimBar looks identical to before (no waveform texture) in Screenshot B, the fix has NOT worked.
- **Video playback (proxy):** Screenshot B must show a video frame playing, not a spinner. Use `mcp__chrome-devtools__click` on the play button and wait before screenshotting.
- **Colour / text changes:** Screenshot must confirm actual hex values match the design system — do not rely on Tailwind class names alone (a class can be applied and still render wrong).

**Diagnose before fixing.** If a check fails: read the source, understand why, then fix. Do not guess and re-screenshot in a loop.

### Step 7.9 — Show screenshots to user for sign-off (MANDATORY)

After all acceptance checks are marked and screenshots A/B/C are taken, **show the screenshots to the user directly**. Do not summarise or describe them — display the actual images. Then state:

- Which acceptance checks passed `[x]`
- Which failed `[FAIL: reason]`
- Whether this constitutes a pass against the user's original success description

Then explicitly ask: **"Does this match what you described as success? If yes, I'll proceed to wrapup. If no, describe what's still missing."**

**This step is non-negotiable. Completion is NOT declared until the user confirms the screenshots show success.** If the user says something is wrong or missing, treat it as a `[FAIL]` on the relevant check and iterate — do not move to wrapup.

Do NOT run `/rushcut-eval` (full smoke test) during build — that is wrapup's job.
Do NOT run `/rushcut-wrapup` — the user will decide when to wrap.

---

## Rules

- Never write code during this skill — research and plan only
- Never exceed 3 levels of nesting in bullet lists
- If the request is a continuation of a deferred batch, re-state what was deferred and why before proposing the plan
- If the plan has more than 8 steps, flag it and ask the user if scope should be reduced
- **`[TRAP]` convention:** During implementation (after this plan is approved and dev begins), whenever a system bug, broken assumption, or more-effective route is discovered — things like "a previously described approach doesn't work", "a required plugin/tool is missing", "the documented API changed" — output a line prefixed `[TRAP]:` inline in the response. The wrapup skill will scan for these and route them to LEARNINGS.md, rules files, or DESIGN.md.
- **DESIGN.md gaps:** If implementation reveals a UI pattern not covered by `docs/DESIGN.md` (new component type, animation, responsive rule), add the gap to the "DESIGN.md gap" section in the plan output AND flag it as a `[TRAP]` so wrapup extends the design system.
