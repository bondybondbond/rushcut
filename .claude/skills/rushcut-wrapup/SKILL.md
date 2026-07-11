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
```

Then launch the binary with the CDP port env var. **Do NOT use `cmd.exe /c "set VAR=val && start exe"`** — confirmed (2026-07-11) it silently drops the env var and the process may not even end up running when invoked via the PowerShell tool. Use `$env:VAR = "val"; Start-Process` instead (see LEARNINGS.md "launching the debug binary with WebView2 remote-debug port"):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process "C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"
```

Wait 5s, then confirm the port is actually listening before running WDIO (`Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue`) — if not, the launch failed silently and WDIO will time out instead of giving a clear error.

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

Structure LEARNINGS.md as a **pattern library** (not a chronological diary). Each entry is a named, standalone pattern. Header format must be `## Tag — Title` (matching the tag table at the top of the file) — **never** `## [Tag: Title]` bracket style, which breaks the file's own documented `grep -nE "^## <Tag>"` lookup:

```
## Tag — Pattern Name
**Problem:** [1 sentence — what breaks or goes wrong]
**Solution:** [1–2 sentences — what to do instead]
**Context:** [where/when this applies — which file, which pipeline step, which tool]
```

Before adding: scan existing entries **for the tag you're about to use**. If a similar pattern already exists — including in `.claude/rules/*.md`, which is the canonical home for anything E2E/pipeline/Tauri-procedural — update it or link to it rather than adding a duplicate. Remove entries that are now obsolete or superseded.

**Per-tag size guard:** before appending, run `grep -c "^## <Tag>"` for the tag you're adding under. If it already returns >15 hits, do a quick dedup/split pass on that tag's existing entries first — merge duplicates, split any bucket-style entry that packs multiple unrelated facts under one header (one entry = one idea), and only then add the new entry. Scope the pass to that tag only, never a blind pass over the whole file — a global judgment pass without full context on every entry is how real failure-mode nuance gets pruned by mistake. Keep entries with unique real-world failure narrative (specific symptom, wrong hypothesis ruled out, exact incident) even if a `.claude/rules/*.md` rule covers the same "what to do" — rules are procedural, LEARNINGS is "how it failed in reality."

Use native **Edit** tool.

**Render speed:** if this session touched `render.py`, `trim.py`, `normalise.py`, `transitions.py`, `zoom.py`, or proxy gen, update `docs/speed-goal.md` — current speed log snapshot, any hypothesis tested (pass/fail), and issue status changes.

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
   $url = gh issue create --title "Short title" --body "Description." --label "<screen or subsystem label — see Labels assignment below>" --repo bondybondbond/rushcut
   $num = $url -replace '.*/issues/', ''
   gh project item-add 1 --owner bondybondbond --url $url
   # Then set fields — see GraphQL pattern below
   ```
   **Minimum required fields on every issue — do not skip any of these:** Prio, Status, Labels, Area, RICE Score. Target Batch is additional (assign when a swimlane clearly fits; skip if none do — see "Doesn't fit" row). Do not ask the user to fill these in — assign based on the guides below.

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

**When no sub-batch exists yet** (e.g. V1.3 is full and a new V1.4 is needed), add the option via `updateProjectV2Field` with ALL existing options included (with their current IDs so item assignments are preserved) plus the new one (no id, GitHub assigns one):

```bash
# Step 1 — query current options with IDs
gh api graphql -f query='{
  node(id: "PVT_kwHOC1IP7s4BanXt") {
    ... on ProjectV2 {
      field(name: "Target Batch") {
        ... on ProjectV2SingleSelectField { options { id name color description } }
      }
    }
  }
}'

# Step 2 — write mutation to a temp file (PowerShell variable expansion and multi-line args break -f query=)
# Include ALL existing options by ID + the new one at the end (no id field)
# File: %TEMP%\rushcut\add-swimlane.graphql
# Then run:
QUERY=$(cat /tmp/add-swimlane.graphql)
gh api graphql -f query="$QUERY"
# Or from Bash: gh api graphql -f query="$(cat /c/Users/Manasak/AppData/Local/Temp/rushcut/add-swimlane.graphql)"
```

Example mutation body (omit projectId — UpdateProjectV2FieldInput does NOT accept it):
```graphql
mutation {
  updateProjectV2Field(input: {
    fieldId: "PVTSSF_lAHOC1IP7s4BanXtzhVdrsY"
    singleSelectOptions: [
      {id: "existing-id-1", name: "U6 — Music seek + loop", color: GRAY, description: ""},
      {id: "existing-id-2", name: "V1.1 — ...", color: GRAY, description: ""},
      # ... all existing options with their IDs ...
      {name: "V1.4 — Brief description", color: GRAY, description: ""}
    ]
  }) {
    projectV2Field {
      ... on ProjectV2SingleSelectField { options { id name } }
    }
  }
}
```

**[TRAP] `createProjectV2SingleSelectFieldOption` does NOT exist** — removed from GitHub's API. Calling it returns `Field 'createProjectV2SingleSelectFieldOption' doesn't exist on type 'Mutation'`.
**[TRAP] `updateProjectV2Field` input does NOT accept `projectId`** — only `fieldId`, `name`, and `singleSelectOptions`.
**[TRAP] PowerShell `-f query=$query` splits multi-line strings into multiple args** — write the mutation to a temp `.graphql` file and pass via Bash `$(cat file)` or PowerShell `Get-Content` piped differently.

Then add the new option to the swimlane legend table in `docs/PRD-DEV.md` and to the "Field IDs and option IDs" section below.

---

### Area assignment (main development category — field display name is "Area", was "Theme")

| Area | Use when |
|------|----------|
| Bug | Wrong behaviour, crash, silent failure, incorrect output |
| UX | Visual accuracy, interaction pattern, copy, discoverability |
| Feature | New capability that doesn't exist yet |
| Performance | Speed, memory usage, render time, proxy throughput |
| Pipeline | FFmpeg, Python pipeline, proxy gen, normalise |
| Infrastructure | Build system, DB schema, temp cleanup, Rust tooling, test infra (WDIO/E2E) |

**Note:** "E2E" is no longer a separate Area option (removed at some point) — E2E/test-infra items now go under **Infrastructure**.

### Labels assignment (GitHub issue labels — sub-category within Area, required on every issue)

Labels are plain GitHub repo labels (`gh issue create --label "..."`), not a ProjectV2 custom field — set via the `--label` flag at creation time, or `gh issue edit <number> --add-label "..." --repo bondybondbond/rushcut` afterward.

**Two-axis taxonomy, no overlap:** Area says *what kind* of work it is (bug/feature/perf/etc.). Labels say *which screen or subsystem* it's about. Labels must **never** duplicate Area's own vocabulary (`bug`, `enhancement`, `ux`, `performance`, `infrastructure` are Area's job, not a Label's) — always pick a screen/subsystem label instead, alongside the Area value. This is also why Labels work as a **swimlane/grouping axis on the roadmap**: grouping by Label shows you "everything touching Trimmer" or "everything touching Zoom" regardless of whether it's a bug, a feature, or a perf issue — Area alone can't answer that.

**Screen labels** (which UI screen):
| Label | Use when |
|-------|----------|
| `upload` | Upload/scan/import screen |
| `trimmer` | Trim screen — filmstrip, TrimBar, focal point/review |
| `arrange` | Arrange/gap-editor screen — sequencing, transitions UI |
| `sound` | Sound screen — music, mix, ducking |
| `render` | Render screen — output/export, stage labels |
| `library` | Library/project list screen |

**Subsystem labels** (cross-cutting engine/pipeline concerns, not tied to one screen):
| Label | Use when |
|-------|----------|
| `zoom` | Ken Burns / zoom effect (touches both Trimmer review and the render filter chain) |
| `transitions` | Transition/xfade engine (touches both Arrange UI and the render filter chain) |
| `proxy` | Proxy generation / background encode |
| `ai` | AI Director / smart defaults |
| `photos` | Photo montage / Ken Burns photo sequences |
| `tooling` | Engineering-facing, not user-facing: Claude Code skills/agents, dev-workflow, WDIO/E2E test infra, app-level infra/housekeeping not tied to a screen (temp cleanup, process/instance management, diagnostics export, branding/app-icon) |
| `platform` | Cloud, auth, billing, Phase 3 infra |

**Rules:**
- Always apply **at least one** screen or subsystem label — this is one of the five minimum required fields, not optional.
- Apply **more than one** when genuinely cross-cutting (e.g. a zoom bug that also affects the Render screen's output → `zoom` + `render`). Don't force a single label if two are accurate.
- **Legacy labels are deprecated for new issues:** `bug`, `enhancement`, `ux`, `performance`, `infrastructure` still exist and remain on older issues (kept for history — do not mass-strip them), but stop applying them going forward. Area already captures that dimension; re-applying it as a Label is exactly the overlap this taxonomy removes. If you notice an old issue still needs re-tagging with a screen/subsystem label, that's a fine opportunistic fix, but a full backlog retag is a separate task — don't do it inline during a wrapup unless asked.
- `documentation`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix` are GitHub defaults, unrelated to this taxonomy — use only when literally applicable (e.g. `wontfix` on a closed-as-rejected issue).

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

# Area (replace option ID per table below)
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdrrc`", value: { singleSelectOptionId: `"df6fc6c2`" } }) { projectV2Item { id } } }"

# Target Batch — additional, not part of the 5 required minimum fields; assign only if a swimlane clearly fits
gh api graphql -f query="mutation { updateProjectV2ItemFieldValue(input: { projectId: `"$pid`", itemId: `"$itemId`", fieldId: `"PVTSSF_lAHOC1IP7s4BanXtzhVdrsY`", value: { singleSelectOptionId: `"bf4709a5`" } }) { projectV2Item { id } } }"
```

**Labels are not part of this GraphQL pattern** — set them via `gh issue create --label "..."` at creation time or `gh issue edit <number> --add-label "..." --repo bondybondbond/rushcut` afterward (see Labels assignment table above). They're a required minimum field, just set through a different command than the other four.

---

### Field IDs and option IDs (project #1, owner bondybondbond)

**Project ID:** `PVT_kwHOC1IP7s4BanXt`

**Status** (`PVTSSF_lAHOC1IP7s4BanXtzhVdroo`) — verified 2026-07-04, "Planned"/"Deferred" options no longer exist:
`f75ad846`=Backlog · `47fc9ee4`=In Progress · `98236657`=Done · `0bd9395d`=On Hold

**Priority** — field display name is now "Prio" (`PVTSSF_lAHOC1IP7s4BanXtzhVdrrU`):
`7eacb906`=P0-Critical · `69fc2074`=P1-High · `279fea12`=P2-Medium · `157b2fd6`=P3-Low

**RICE Score** (`PVTF_lAHOC1IP7s4BanXtzhVdrrY`): number field

**Theme** — field display name is now "Area" (`PVTSSF_lAHOC1IP7s4BanXtzhVdrrc`) — verified 2026-07-04, "E2E" option no longer exists:
`fe228fee`=Feature · `df6fc6c2`=Bug · `8c8ea89a`=Performance · `5d406e8e`=UX · `84bf01bd`=Pipeline · `5f5e44fd`=Infrastructure

**[TRAP] Field/option IDs drift over time — verify before trusting this table.** Query current state before a batch of mutations: `gh api graphql -f query='{ node(id: "PVT_kwHOC1IP7s4BanXt") { ... on ProjectV2 { fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { name id options { id name } } } } } } }'`

**[TRAP] "Target Batch" field no longer exists on the project (confirmed removed 2026-07-04).** Querying all 19 fields on `PVT_kwHOC1IP7s4BanXt` (`fields(first: 30) { nodes { ... on ProjectV2FieldCommon { name id } } }`) shows no "Target Batch" field at all — only Title/Assignees/Status/Labels/Linked pull requests/Milestone/Repository/Reviewers/Parent issue/Sub-issues progress/Created/Updated/Closed/Prio/RICE Score/Area/Start Date/Target Date. The field ID below (`PVTSSF_lAHOC1IP7s4BanXtzhVdrsY`) now 404s ("Could not resolve to a node"). Do not attempt to set Target Batch on new issues until this is re-added (or confirm via the field-list query above first) — the swimlane table below is kept for historical option-name reference only.

**Target Batch** (`PVTSSF_lAHOC1IP7s4BanXtzhVdrsY` — STALE, see TRAP above):
`5162bb0a`=U5c — Dual-monitor freeze
`0c7f24e6`=U6 — Music seek + loop
`38f62851`=U6a — Master preview bug fixes
`70120dff`=U6b — Music mid-film silence fix
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

## Step 3 — Strategic doc (PRD-DEV.md)

`docs/PRD-DEV.md` is **strategic-only**: forward roadmap (AI Director, Auth/4K/Tier), AI Enablement, Phase 3 preview, swimlane legend. Update it **only** if one of those changed this session.

- **Do NOT add a changelog entry.** The PRD-DEV changelog is retired — "what shipped when" lives in git log (authoritative) + `docs/archive/completed-plans/PRD-DEV-batches-14-N-full.md` (frozen history).
- **Do NOT add individual backlog items** — those go to GitHub Issues (Step 2.5).
- Current state + next task is **not** recorded here — that is MEMORY.md only (Step 4).

If no strategic/roadmap/swimlane change, skip this step entirely.

Use native **Edit** tool.

---

## Step 4 — Memory updates (`C:\Users\Manasak\.claude\projects\C--apps-rushcut\memory\MEMORY.md`)

MEMORY.md is the **single state doc** — current phase + next task only. It is small by design (~45 lines). Keep it that way.

- **Overwrite the `## Current State` line(s) — never append a new dated block.** Replace "last shipped / next" with the new reality. History belongs in git log + `docs/archive/`, not here.
- **Do NOT add a batch-status list or a changelog stack.** If you find yourself adding a second dated entry, you are re-creating the diary this taxonomy removed — delete the old line instead.
- **New critical constraints** that must never be regressed go to **CLAUDE.md** (project-wide) or the matching `.claude/rules/` file — NOT MEMORY.md. MEMORY.md only holds the one-line index pointers to topic memory files plus the Current State.
- Topic memory files (`feedback_*`, `project_*`, etc.) follow the standard memory format; add a one-line index pointer here if you create a new one.

If current state did not change, skip.

Use native **Edit** tool.

---

## Step 5 — Cleanup

**Build cache size flag (read-only, advisory only — never auto-deletes):** `src-tauri/target/` is Rust's build cache and grows unbounded across sessions (confirmed reaching 22GB before ever being cleared). Check its size; if over 15GB, flag it in the wrapup report rather than clearing it — clearing costs the next build its incremental cache, so that's a deliberate call for the user, not an automatic wrapup action. Use `/rushcut-maintenance` for the actual cleanup.

```bash
powershell.exe -NoProfile -Command "$s = (Get-ChildItem C:/apps/rushcut/src-tauri/target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB; if ($s -gt 15) { Write-Host \"target/ is now $([math]::Round($s,1)) GB -- consider running /rushcut-maintenance\" }"
```

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

**NTFS render scratch dirs** (`%TEMP%\rushcut\<job_id>\`, holding `render.mp4` + `u1g_seg_*.mp4` — the AMF write targets introduced by #86). `run.py` deletes its own job's dir via `_resolve_render_work_dir` after every successful render, but crashed/killed jobs (WDIO SIGTERM, cancelled renders, WSL restart mid-job) leave orphans that never get swept — unlike `/tmp` above, these are NTFS and persist indefinitely. Age-gated to 24h so an in-flight render's scratch dir is never touched:

```bash
powershell.exe -NoProfile -Command "Get-ChildItem \"\$env:TEMP\rushcut\" -Directory -ErrorAction SilentlyContinue | Where-Object { \$_.LastWriteTime -lt (Get-Date).AddHours(-24) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; Write-Host 'NTFS render scratch swept'"
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
- If it revealed a gap in how the session was kicked off (e.g. no batch spec, missing context) → update the dev-plan skill's Step 1 "Ingest the request" checklist

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
