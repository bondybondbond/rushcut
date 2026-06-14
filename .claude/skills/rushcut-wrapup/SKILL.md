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

## Step 2.5 — Backlog harvest → GitHub Issues

Scan the session for any gaps, known limitations, observed bugs, potential improvements, or "future batch" candidates that were mentioned during implementation or discussion — whether raised by the user, noted inline, or flagged as a deferred decision. This includes:

- **Known gaps stated during dev** — e.g. "this works but has a blank flash we didn't fix", "film screen avoids this but clip screen doesn't yet", "deferred to a future batch"
- **Observed side-effects** — e.g. "noticed X doesn't handle Y", "this only works for 1080p not 4K"
- **User-raised concerns that weren't actioned** — e.g. "what about the case where…", "can we also…", "we should probably…"
- **Explicit `// TODO` comments** added to source code during the session

**GitHub Issues is now the source of truth for execution backlog** (not PRD-DEV.md). For each item found:

1. **New actionable item** → create a GitHub Issue and add to project:
   ```powershell
   $url = gh issue create --title "Short title" --body "Description." --label "bug" --repo bondybondbond/rushcut
   $num = $url -replace '.*/issues/', ''
   gh project item-add 1 --owner bondybondbond --url $url
   # Then set fields — see GraphQL pattern below
   ```
   Set Priority, RICE Score, Theme, Target Batch. Do not ask — assign based on the guides below.

2. **Item shipped this session** → add a closing comment with key session insights, then close:
   ```powershell
   gh issue comment <number> --repo bondybondbond/rushcut --body "Shipped in [batch name].

   **Key findings from this session:**
   - [What the root cause turned out to be]
   - [Any traps or non-obvious constraints discovered]
   - [Approach taken and why]
   - [Known gaps or follow-ons left open]"

   gh issue close <number> --repo bondybondbond/rushcut
   ```

3. **Item deferred** → add a comment explaining why, then update Status to Deferred:
   ```powershell
   gh issue comment <number> --repo bondybondbond/rushcut --body "Deferred: [reason — e.g. blocked by X, descoped to keep batch small, needs more investigation]."
   # Then update project Status field to Deferred via GraphQL
   gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input: { projectId: "PVT_kwHOC1IP7s4BanXt", itemId: "<item-node-id>", fieldId: "PVTSSF_lAHOC1IP7s4BanXtzhVdroo", value: { singleSelectOptionId: "0bd9395d" } }) { projectV2Item { id } } }'
   ```

4. **Observations / pre-scope notes for a future issue** → for any insight, known gap, or pre-scoped implementation note that relates to an existing ticket, add it as a comment so the next session that picks up that ticket has the context:
   ```powershell
   gh issue comment <number> --repo bondybondbond/rushcut --body "Context from [batch name] session ($(Get-Date -Format 'yyyy-MM-dd')):

   [The observation, insight, or pre-scoped note. Be specific:
   - What was observed / what broke / what the user said
   - Any hypothesis about root cause or approach
   - Relevant file paths, function names, or code locations
   - Edge cases or constraints to keep in mind]"
   ```
   This replaces what used to be inline notes in PRD-DEV.md. The next dev plan session will read these comments via `gh issue view <number> --comments` and use them as the brief.

   **What qualifies for a comment:**
   - "Deferred to a future batch" notes with context about why
   - Observed side-effects that weren't fixed ("clip mode works, film mode doesn't")
   - User-raised concerns that weren't actioned this session
   - Implementation insights discovered mid-session ("the real issue is X, not Y")
   - `// TODO` comments added to source code — copy the surrounding context here too

5. **Ambiguous item** → collect all ambiguous items and ask the user ONE question after wrapup: *"I found [N] potential backlog items — should I create GitHub Issues for any of these? [list]"*

**Do NOT add `## Backlog —` entries to PRD-DEV.md.** That file is strategic-only now.
Do NOT skip this step to save time. Missing backlog items from wrapup means the user has to remind you after the fact.

---

### Swimlane (Target Batch) assignment

Match new items to the correct series by theme. Read the description, not just the batch name.

| If the item is... | Assign to |
|-------------------|-----------|
| Crash, data corruption, wrong output content, silent render failure | **V1.x** next available sub-batch |
| Visual inaccuracy, misleading UI, missing affordance, QoL polish | **V2.x** next available sub-batch |
| Trim-screen playback feel (seek, cross-clip, dual-buffer) | **U5** (or new U5.x) |
| Music playback (seek dropout, loop, sync, volume) | **U6** |
| New editing capability requiring meaningful new UI + state | **V3** |
| Pipeline architecture (render cache, parallelism, decode/encode) | **V4.x** |
| AI automation / smart defaults / director features | **AI** |
| Photo montage / Ken Burns sequences | **Photos** |
| Cloud, auth, Stripe, music API | **Phase3** |
| Doesn't fit above, or too low-priority to schedule | **Future** |

**When no sub-batch exists yet** (e.g. V1.3 is full and a new V1.4 is needed), create a new option:
```powershell
gh api graphql -f query='mutation { createProjectV2SingleSelectFieldOption(input: { projectId: "PVT_kwHOC1IP7s4BanXt", fieldId: "PVTSSF_lAHOC1IP7s4BanXtzhVdrsY", name: "V1.4 — Brief description", color: GRAY, description: "" }) { field { ... on ProjectV2SingleSelectField { id } } } }'
```
Then add the new option to the swimlane legend table in `docs/PRD-DEV.md`.

---

### Theme assignment

| Theme | Use when |
|-------|----------|
| Bug | Wrong behaviour, crash, silent failure, incorrect output |
| UX | Visual accuracy, interaction pattern, copy, discoverability |
| Feature | New capability that doesn't exist yet |
| Performance | Speed, memory usage, render time, proxy throughput |
| Pipeline | FFmpeg, Python pipeline, proxy gen, normalise |
| E2E | Test infrastructure, WDIO specs, eval skill |
| Infrastructure | Build system, DB schema, temp cleanup, Rust tooling |

---

### RICE scoring

Pick the midpoint of the range if unsure. Round to the nearest 5.

| Score | Priority | When to use |
|-------|----------|-------------|
| 80–100 | P0 | Crash or data corruption on a common user path; blocks shipping |
| 55–79 | P1 | High-impact bug or feature on an active flow; most users hit it |
| 25–54 | P2 | Noticeable but non-blocking; affects some users or an edge case |
| 0–24 | P3 | Low-impact, rare path, or a nice idea for later |

---

### GraphQL pattern — set all fields on a new item

```powershell
# After gh project item-add, get the item node ID:
$items = gh project item-list 1 --owner bondybondbond --format json | ConvertFrom-Json
$itemId = ($items.items | Where-Object { $_.content.number -eq $num }).id

$pid = "PVT_kwHOC1IP7s4BanXt"

# Status → Backlog
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdroo`", value: { singleSelectOptionId: `"f75ad846`" } }) { projectV2Item { id } } }"

# Priority (replace option ID per table below)
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdrrU`", value: { singleSelectOptionId: `"69fc2074`" } }) { projectV2Item { id } } }"

# RICE Score (replace 55 with actual score)
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTF_lAHOC1IP7s4BanXtzhVdrrY`", value: { number: 55 } }) { projectV2Item { id } } }"

# Theme (replace option ID per table below)
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdrrc`", value: { singleSelectOptionId: `"df6fc6c2`" } }) { projectV2Item { id } } }"

# Target Batch (replace option ID per table below)
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdrsY`", value: { singleSelectOptionId: `"bf4709a5`" } }) { projectV2Item { id } } }"
```

---

### Field IDs and option IDs (project #1, owner bondybondbond)

**Project ID:** `PVT_kwHOC1IP7s4BanXt`

**Status** (`PVTSSF_lAHOC1IP7s4BanXtzhVdroo`):
`f75ad846`=Backlog · `47fc9ee4`=In Progress · `98236657`=Done · `34c38c83`=Planned · `0bd9395d`=Deferred · `bf262634`=On Hold

**Priority** (`PVTSSF_lAHOC1IP7s4BanXtzhVdrrU`):
`7eacb906`=P0-Critical · `69fc2074`=P1-High · `279fea12`=P2-Medium · `157b2fd6`=P3-Low

**RICE Score** (`PVTF_lAHOC1IP7s4BanXtzhVdrrY`): number field

**Theme** (`PVTSSF_lAHOC1IP7s4BanXtzhVdrrc`):
`fe228fee`=Feature · `df6fc6c2`=Bug · `8c8ea89a`=Performance · `5d406e8e`=UX · `84bf01bd`=Pipeline · `384d8bd9`=E2E · `5f5e44fd`=Infrastructure

**Target Batch** (`PVTSSF_lAHOC1IP7s4BanXtzhVdrsY`):
`5162bb0a`=U5c — Dual-monitor freeze
`0c7f24e6`=U6 — Music seek + loop
`dd04dd5d`=V1 — Stability bugs [series]
`bf4709a5`=V1.1 — Unexpected clips / MediaPantry
`5832f5cd`=V1.2 — WebView2 crash + driver reset
`905b42ca`=V1.3 — Swipe + spam + instance guard
`310a0c7c`=V2 — UX polish [series]
`e7603a01`=V2.1 — Trim handles + thumbnail in-point
`215a4b61`=V2.2 — Progress bar + export folder
`5127308c`=V2.3 — Sound polish + drag-to-bin
`d52bc38c`=V3 — Add/remove clips + multi-version
`50d13c6e`=V4.1 — DaVinci-style render cache
`787b82d8`=V4.2 — Parallel decode + encode
`3af29521`=AI — Smart defaults + beat sync
`89182532`=Photos — Ken Burns montage
`8f28c9c8`=Phase3 — Cloud + auth + Stripe
`c3eb29a4`=Future — Unscheduled backlog

---

## Step 3 — Planning doc

For Phase 2 work, update:
- `docs/CONTEXT.md` — current phase, immediate next task, recently completed
- `docs/PRD-DEV.md` — tick completed gate items, add changelog entry, update Phase goal/exit gate if changed. **Do NOT add individual backlog items here** — those go to GitHub Issues (Step 2.5).
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
