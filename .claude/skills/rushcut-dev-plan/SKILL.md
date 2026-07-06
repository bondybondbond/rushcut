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

1. **Memory** — `C:\Users\Manasak\.claude\projects\C--apps-rushcut\memory\MEMORY.md` — read in full; it is the single source for current state + next task (CONTEXT.md no longer exists). Small file by design.
2. **LEARNINGS.md** — `docs/LEARNINGS.md` is a large pattern library — **do NOT read it in full.** `Grep` it for the patterns relevant to this request (e.g. the component, FFmpeg filter, or failure class involved) and read only the matching entries.
3. **Relevant rules file** — pick the matching file(s) from `.claude/rules/` (pipeline.md / rust-tauri.md / e2e.md) based on which layer is touched
4. **Design system** — `docs/DESIGN.md` — **always read this when the request touches any UI component** (new screen, modified component, copy change, colour/layout decision)
5. **GitHub Issues — always fetch the relevant ticket(s):**

   **Case A — specific batch or issue named** (e.g. "let's do U5c", "fix #29", "start V1.2"):
   - Find the issue: `gh issue list --repo bondybondbond/rushcut --search "U5c" --state open --json number,title` (or use the issue number directly)
   - Fetch the full issue with all comments: `gh issue view <number> --repo bondybondbond/rushcut --comments`
   - Read the body AND every comment — comments contain pre-scoped observations, implementation hints, known failure modes, and context from previous sessions. Treat them as the primary brief for this task.

   **Case B — "what's next?" or "plan the next batch"**:
   - Run `gh project item-list 1 --owner bondybondbond --format json` and find the highest RICE-score open items (Status=Backlog/Planned)
   - Pick the top candidate(s), then fetch each with `gh issue view <number> --repo bondybondbond/rushcut --comments` as in Case A

   `docs/PRD-DEV.md` is strategic-only (Phase goal, swimlane legend, Phase 3 preview) — it no longer tracks individual backlog items or implementation notes.

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

After completing each implementation step that has a Step-6-defined pass/fail acceptance check (not at the end of the whole batch) — whether that step is a UI screen/component, a pipeline change, or a Tauri/Rust change — get an independent review of **only that changed step** — do not grade your own work.

**This step is MANDATORY and non-negotiable. E2E spec passing does NOT substitute for it.**
E2E tests verify DOM structure and element presence. They do NOT verify visual rendering —
broken images, invisible overlays, wrong colours, and corrupt data all pass E2E. The same logic
applies to pipeline changes — a green E2E run does not verify loudness is within spec, that a
cache actually got hit, or that ffprobe's stream metadata matches expectations.

1. Immediately after finishing the step, invoke the `rushcut-qa-reviewer` subagent via the Agent tool with `run_in_background: true`. Pass it only:
   - `git diff HEAD -- <scoped path>` for this step
   - The review target:
     - **UI step:** the screen name / route
     - **Pipeline/backend step:** the function/module touched, **and** the concrete log/artifact paths to verify it against (e.g. `pipeline-latest.log`, `render-timing-log.jsonl`, the output mp4 path) — both together, since a bare function name doesn't tell the reviewer where to find proof, and bare paths don't explain what's being checked
   - The acceptance checks for this step from Step 6
   Do **not** pass it your reasoning, the plan, or why you built it this way — it must stay cold-context.
2. Then continue straight into researching/implementing the **next** step using `Read`/`Grep`/`Edit`/`Write` only. If this step's review touches `preview_*`/the browser (a UI/screen review, or a pipeline review that also needs to confirm something rendered in the app), do not call any `preview_*` tool yourself while that reviewer run is in flight — the reviewer owns the browser for the duration of its background run, and only hands it back on its completion notification. A pipeline-only review (PowerShell + log/ffprobe reads only, never touching `preview_*`) never claims the CDP port, so you're free to keep using `preview_*` yourself during that run. You can draft/code the next step while waiting, but you cannot visually build-eval it until the browser comes back (when the prior review does hold it).
3. When the reviewer's completion notification arrives, read its verdict (see the schema in `rushcut-qa-reviewer.md`) and proceed to Step 7.9.

Do NOT run `/rushcut-eval` (full smoke test) during build — that is wrapup's job.
Do NOT run `/rushcut-wrapup` — the user will decide when to wrap.

### Step 7.9 — Read verdict and get user sign-off (MANDATORY)

1. Relay the reviewer's verdict to the user: which checks passed, which failed and why (use the reviewer's own `message` text — it's already concrete, not vibes).
2. A confirmatory screenshot taken by you (the orchestrator) is **optional, not mandatory** — the reviewer already did the visual work and its own screenshots aren't shown to the user automatically. Take one yourself only if the user asks to see it directly.
3. On `status: "pass"` — ask the user: **"Does this match what you described as success? If yes, I'll proceed to wrapup. If no, describe what's still missing."** Completion is not declared until the user confirms.
4. **Hard rule — max 1 retry, no exceptions:** if the verdict is not `pass`, fix the code (when the verdict was `fail`) and re-invoke `rushcut-qa-reviewer` exactly once. Model for that one retry: `sonnet` if the verdict was `blocked` or the fail reason was ambiguous, otherwise `haiku` (the default). There is no second retry under any circumstance. If the re-invoked verdict is still not a clean `pass`, stop looping and surface an explicit accept/defer decision to the user instead of trying again.

---

## Rules

- Never write code during this skill — research and plan only
- Never exceed 3 levels of nesting in bullet lists
- If the request is a continuation of a deferred batch, re-state what was deferred and why before proposing the plan
- If the plan has more than 8 steps, flag it and ask the user if scope should be reduced
- **`[TRAP]` convention:** During implementation (after this plan is approved and dev begins), whenever a system bug, broken assumption, or more-effective route is discovered — things like "a previously described approach doesn't work", "a required plugin/tool is missing", "the documented API changed" — output a line prefixed `[TRAP]:` inline in the response. The wrapup skill will scan for these and route them to LEARNINGS.md, rules files, or DESIGN.md.
- **DESIGN.md gaps:** If implementation reveals a UI pattern not covered by `docs/DESIGN.md` (new component type, animation, responsive rule), add the gap to the "DESIGN.md gap" section in the plan output AND flag it as a `[TRAP]` so wrapup extends the design system.
