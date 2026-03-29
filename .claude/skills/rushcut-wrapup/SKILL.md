---
name: rushcut-wrapup
description: "Closes off a RushCut dev session by running the standard wrap-up routine. Use this skill ONLY when working on the RushCut project (C:\\apps\\rushcut). Do NOT use for SpotBoard or other projects. Triggers: user says 'wrap up', 'wrapup', 'project wrapup', 'close off the session', 'end the session', 'lets wrap', 'do the wrapup', 'commit and wrap', or anything that signals finishing work on RushCut. Invoke even for partial sessions — skip any step that has nothing to do."
---

# RushCut Dev Session Wrap-up

Work through each step in order. Skip any step that has nothing to do — don't invent entries. Quick routine, not a research task.

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

## Step 2 — `.claude/rules/` files

If the session introduced or confirmed path-specific technical rules (FFmpeg, pipeline, Tauri, E2E), update the relevant rules file:
- `.claude/rules/pipeline.md` — pipeline invocation, FFmpeg quirks, Python pitfalls
- `.claude/rules/rust-tauri.md` — Tauri commands, permissions, capabilities
- `.claude/rules/e2e.md` — WDIO setup, rushcut-eval skill rules

Only update if a rule changed or a new important constraint was discovered. Do NOT duplicate content from LEARNINGS.md.

Use native **Edit** tool.

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

## Step 7 — Prompt tips

Give 2–3 concise, specific recommendations on how the user could have prompted more efficiently this session — fewer round trips, earlier use of the right tool, clearer scope. Reference actual exchanges from the session. Skip if nothing notable.

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
