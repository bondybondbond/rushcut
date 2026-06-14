---
name: rushcut-wrapup
description: "Closes off a RushCut dev session by running the standard wrap-up routine. Use this skill ONLY when working on the RushCut project (C:\\apps\\rushcut). Do NOT use for SpotBoard or other projects. Triggers: user says 'wrap up', 'wrapup', 'project wrapup', 'close off the session', 'end the session', 'lets wrap', 'do the wrapup', 'commit and wrap', or anything that signals finishing work on RushCut. Invoke even for partial sessions — skip any step that has nothing to do."
---

# RushCut Dev Session Wrap-up

Work through each step in order. Skip any step that has nothing to do — don't invent entries. Quick routine, not a research task.

---

## Step 0 — Scan for `[TRAP]` flags

Scan the current session for any lines prefixed `[TRAP]:`. These are system bugs, broken assumptions, missing tools/plugins, or more-effective routes discovered during development — things that were not known at the start of the session.

For each `[TRAP]` found, categorise it:
- **System bug / broken API / previously-described-as-working thing that isn't** → route to `docs/LEARNINGS.md` (Step 1)
- **Path-specific technical rule (FFmpeg, Tauri, pipeline, E2E)** → route to the relevant `.claude/rules/` file (Step 2)
- **UI/design pattern gap or violation** → route to `docs/DESIGN.md` (extend it with the missing pattern)
- **Ways-of-working / tooling shortcut / workflow insight** → route to `docs/LEARNINGS.md` with a "Workflow" heading
- **Token/context waste discovered** → route to `docs/LEARNINGS.md` Workflow section (Step 0.8 handles this automatically — note it here for routing)

If no `[TRAP]` flags exist in the session, skip this step. Do not invent entries.

After routing each trap, proceed to the relevant steps below to write the actual content.

---

## Step 0.5 — Smoke test (5 min max)

Run the fast spec suite only. No screenshots. No MCP. No CDP required — just WDIO counts.

```bash
powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgedriver -Force -ErrorAction SilentlyContinue"
cmd.exe /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 && start C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"
```

Wait 5s, then:

```bash
powershell.exe -Command "Set-Location C:/apps/rushcut; pnpm test:e2e 2>&1"
```

Record PASS/FAIL count only. If the session touched editor or trimmer flows, also run those suites:

```bash
powershell.exe -Command "Set-Location C:/apps/rushcut; pnpm test:e2e:editor 2>&1"
powershell.exe -Command "Set-Location C:/apps/rushcut; pnpm test:e2e:trimmer 2>&1"
```

**On failures:** List the failing test names in the wrapup report. Do not attempt to fix during wrapup unless the cause is trivially obvious (one-line typo, wrong constant). Non-trivial failures → note as a blocker for the next session.

Skip this step if the session was docs-only, config-only, or if all specs were already run as part of the dev session's in-build eval within the last 30 minutes.

---

## Step 0.8 — Efficiency review (token & context waste)

Scan the session for patterns that burned context needlessly or caused extra round trips. Look for:

- **Unnecessary full-file reads** — was a large file (`lib.rs`, `db.rs`, `PRD-DEV.md`) read in full when scoped `Read` with line offset or `Grep` for a specific symbol would have been enough?
- **Repeated reads of the same file** — was the same file read 2+ times without a write in between?
- **Web searches that returned nothing useful** — query returned generic results; the answer was already in LEARNINGS.md or the rules files
- **Debugging loops** — the same fix was tried 2+ times with minor variation before the root cause was identified
- **Asking the user for output** — pipeline logs, stack traces, or stdout was requested from the user when it could have been read directly (`pipeline-latest.log`, WSL2 output, etc.)
- **Wrong tool for the job** — Bash used where Read/Grep/Glob would have been faster and cleaner
- **Context-heavy speculation** — large amounts of code written or read before confirming the approach with the user

For each pattern spotted, **immediately write a LEARNINGS.md Workflow entry** using:

```
## [Workflow: Pattern Name]
**Problem:** [what caused the waste]
**Solution:** [the faster/cheaper route]
**Context:** [when this applies — which file type, which task, which tool]
```

If the pattern is severe enough to change default behaviour in all future sessions (not just a reminder — a rule), also add a one-line bullet to CLAUDE.md under a "## Efficiency rules" section (create it if it doesn't exist).

Do NOT invent patterns. Only write entries for waste that actually occurred this session. Skip the step entirely if the session was efficient.

---

## Step 1 — LEARNINGS.md (`C:\apps\rushcut\docs\LEARNINGS.md`)

Add an entry **only** if the pattern is genuinely reusable in future sessions — a technical insight that isn't obvious and isn't already covered.

Structure LEARNINGS.md as a **pattern library** (not a chronological diary). Each entry is a named, standalone pattern:

```
## [Pattern Name]
**Problem:** [1 sentence — what breaks or goes wrong]
**Solution:** [1–2 sentences — what to do instead]
**Context:** [where/when this applies — which file, which pipeline step, which tool]
```

Before adding: scan existing entries. If a similar pattern exists, update it rather than adding a duplicate. Remove entries that are now obsolete or superseded.

Use native **Edit** tool.

---

## Step 2 — `.claude/rules/` files and `docs/DESIGN.md`

If the session introduced or confirmed path-specific technical rules (FFmpeg, pipeline, Tauri, E2E), update the relevant rules file:
- `.claude/rules/pipeline.md` — pipeline invocation, FFmpeg quirks, Python pitfalls
- `.claude/rules/rust-tauri.md` — Tauri commands, permissions, capabilities
- `.claude/rules/e2e.md` — WDIO setup, rushcut-eval skill rules

If the session added or surfaced a new UI pattern not yet in the design system (component layout, animation, new token usage, spacing convention), extend `docs/DESIGN.md`. DESIGN.md should be comprehensive enough that a fresh session never needs to invent a pattern. Add the missing pattern as a new section with a brief rationale and the exact Tailwind/CSS classes used.

Only update if a rule changed, a new constraint was discovered, or a DESIGN.md gap was found. Do NOT duplicate content from LEARNINGS.md.

Use native **Edit** tool.

---

## Step 2.5 — Backlog harvest

Scan the session for any gaps, known limitations, observed bugs, potential improvements, or "future batch" candidates that were mentioned during implementation or discussion — whether raised by the user, noted inline, or flagged as a deferred decision. This includes:

- **Known gaps stated during dev** — e.g. "this works but has a blank flash we didn't fix", "film screen avoids this but clip screen doesn't yet", "deferred to a future batch"
- **Observed side-effects** — e.g. "noticed X doesn't handle Y", "this only works for 1080p not 4K"
- **User-raised concerns that weren't actioned** — e.g. "what about the case where…", "can we also…", "we should probably…"
- **Explicit `// TODO` comments** added to source code during the session
- **Anything the user would reasonably expect to find in PRD-DEV.md backlog** after this session

For each item found:

1. **If it's a clear, actionable backlog item** → add a `## Backlog — [description]` entry to `docs/PRD-DEV.md` in the style of existing entries (problem description, root cause if known, scope/fix direction, 1–3 paragraphs max). Do not ask — just add it.

2. **If it's ambiguous** (unclear whether the user wants it tracked, or whether it's already covered elsewhere in PRD-DEV.md) → collect all ambiguous items and ask the user ONE question immediately after wrapup completes: *"I found [N] potential backlog items — should I add any of these to PRD-DEV.md? [list them]"*

Do NOT skip this step to save time. Missing backlog items from wrapup means the user has to remind you after the fact — which defeats the purpose of wrapup.

Use native **Edit** tool for any PRD-DEV.md additions.

---

## Step 3 — Planning doc

For Phase 2 work, update:
- `docs/CONTEXT.md` — current phase, immediate next task, recently completed
- `docs/PRD-DEV.md` — tick completed gate items, add changelog entry
- `docs/ARCHIVE.md` — move resolved decisions/bugs (if file exists)

If nothing changed substantially, skip.

Use native **Edit** tool.

---

## Step 4 — Memory updates (`C:\Users\Manasak\.claude\projects\C--apps-rushcut\memory\MEMORY.md`)

Update if the current state genuinely changed: a feature completed, a major constraint was discovered, the next priority shifted.

Key sections to keep current:
- **Current State** — one-line summary of where things stand now
- **Batch / Feature Status** — tick completed items
- **Critical Constraints** — add anything new that must never be regressed

Use native **Edit** tool.

---

## Step 5 — Cleanup

**Test artifacts:** Delete any failure screenshots that accumulated during the session:

```bash
powershell.exe -Command "if (Test-Path C:/apps/rushcut/e2e/screenshots) { Remove-Item C:/apps/rushcut/e2e/screenshots/* -Force -ErrorAction SilentlyContinue; Write-Host 'screenshots cleared' }"
```

**Rendered outputs** — WDIO test renders accumulate in `C:\clips\processed\` with known slugs. Delete ONLY those — never the user's real renders (stagecoach-*, zoom-test-*, etc.):

```bash
powershell.exe -NoProfile -Command "@('eval-test-film','arrange-e2e-test','library-spec-project','sound-e2e-test','trimmer-e2e-test') | ForEach-Object { Remove-Item \"C:\clips\processed\$_-*.mp4\" -Force -ErrorAction SilentlyContinue }; Write-Host 'test renders cleared'"
```

**Windows temp manifests** (job + proxy JSON files written per render — small but accumulate; .jsonl timing log is preserved):

```bash
powershell.exe -NoProfile -Command "Remove-Item \"\$env:TEMP\rushcut\*.json\" -Force -ErrorAction SilentlyContinue; Write-Host 'temp manifests cleared'"
```

**WSL2 /tmp/ intermediates** (1-3 GB per render; run.py cleans after each successful run, but crashed runs leave orphans):

```bash
powershell.exe -NoProfile -Command "wsl -d Ubuntu-24.04 -u root -- sh -c 'rm -rf /tmp/*/'"
```

**Code:** Remove `console.log` / `print()` debug statements, temp/scratch files, resolved inline TODOs.

**Docs (light prune — apply "earns its place" test):**
- LEARNINGS.md: merge near-duplicate entries; remove patterns that are now obvious or resolved
- Rules files: remove anything now inferable from code or made redundant by a recent fix
- CLAUDE.md: if over 120 lines, something must be cut or moved to a rules file — no exceptions

This is a light pass, not a deep audit. If nothing clearly stale or redundant, skip docs.
For a thorough docs cleanup (reorganise, consolidate, cull old batches from PRD-DEV.md), the user should ask explicitly — don't do it unsolicited in a wrapup.

---

## Step 6 — Commit & push

Stage only source files changed this session:

```bash
cd C:/apps/rushcut
git add src/ pipeline/ docs/ .claude/ e2e/ wdio.conf.ts package.json CLAUDE.md .gitignore
git status
git commit -m "type(scope): description

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
GIT_ASKPASS=echo GIT_TERMINAL_PROMPT=0 git push https://<token>@github.com/bondybondbond/rushcut.git main
```

Never commit: `.env.local`, `spike/tmp/`, `spike/output*`, `C:/clips/`, private keys or credentials.
The token is in the `origin` remote URL — read it with `git remote get-url origin`.

Check `git status` before staging — don't use `git add -A`.

---

## Step 7 — Session efficiency actions

Review the session for prompt or workflow patterns that caused extra round trips, unclear scope, or wasted effort on both sides.

For each pattern found, **act on it immediately** — don't just state the tip:

- If it's a recurring user prompt pattern (e.g. scope too vague, missing constraints) → save a `feedback_*` memory file noting the pattern and better phrasing
- If it's a workflow shortcut the user could use more → note it verbally as a "next session tip" (2 sentences max)
- If it revealed a gap in how the session was kicked off (e.g. no batch spec, missing context) → update the dev-plan skill's Step 2 "Ingest the request" checklist

Skip if the session was efficient and nothing stands out. Do not invent tips.

---

## Step 8 — CLAUDE.md audit (`C:\apps\rushcut\CLAUDE.md`) — LAST

This step runs **after** LEARNINGS.md and rules files are updated. By then, most new knowledge is already captured. CLAUDE.md should only receive minimal additions.

**Target: CLAUDE.md must stay under 120 lines. Treat 200 as absolute max.**

**Hard cap: CLAUDE.md must stay under 120 lines. If it's over, cut before adding.**

**Pass A — Add (be strict):** Only add if ALL of these are true:
1. It would cause a **costly mistake** if a fresh session started without knowing it
2. It's **project-wide** (path-specific detail → `.claude/rules/`)
3. It's **not already in** LEARNINGS.md, a rules file, or inferable from the code

**Pass B — Remove:** Cut anything that:
- Can be looked up in `.claude/rules/` or `docs/DESIGN.md`
- Is stale, resolved, or no longer a risk
- Is general developer knowledge not specific to RushCut
- Was added speculatively ("might be useful") rather than because a session actually needed it

Format: short bullets only. No paragraphs, no explanations, no history.
When in doubt, leave it out — LEARNINGS.md is the right place for "good to know".

Use native **Edit** tool.
