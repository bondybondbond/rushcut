## Architecture

**Tauri 2.x local desktop app. NOT Next.js, Vercel, Lambda, or any cloud service.**

- **Renderer:** React + Vite (`src/`)
- **Backend:** Rust (`src-tauri/`)
- **Pipeline:** Python 3 in WSL2 Ubuntu-24.04 (`pipeline/`)
- **DB:** SQLite via rusqlite (`%APPDATA%\rushcut\rushcut.db`)
- No S3, no Lambda, no Supabase, no Vercel. `lambda/` is ARCHIVED — do not modify.

### UX flow

`/upload` → `/trimmer/:projectId` → `/arrange/:projectId` → `/sound/:projectId` → `/render/:projectId`

### Dev command

`pnpm dev` (starts Vite + compiles Rust + opens Tauri window). `pnpm dev:vite` alone = all `invoke()` calls fail.

---

## Critical Rules (every session)

- **`.claude/settings.json` hooks (`UserPromptSubmit` + `PreToolUse`) are enforcement infra, not sample config.** `.claude/hooks/enforce-skill-trigger.js` (soft hint) + `enforce-skill-gate.js` (hard block, denies every tool except `Skill`/`AskUserQuestion`) force `Skill(rushcut-dev-plan)`/`Skill(rushcut-wrapup)` when a message matches a trigger phrase — added after a real miss where "dev plan" was treated as generic text. `enforce-skill-gate.js` re-derives the trigger from `transcript_path` itself (no shared state file). Do not remove or bypass without the user's explicit request.
- **`Skill(rushcut-wrapup)` is a hard gate (2026-07-15) — no session ends without it, including docs-only/probe/investigation sessions.** It may never be invoked without a prior `rushcut-pp-consultant` sign-off on that session's specific outcome first — see `.claude/skills/rushcut-dev-plan/SKILL.md` Step 6.9 for the authoritative wording. **Mechanically enforced since 2026-07-23** (`enforce-pp-wrapup-signoff.js`, `enforce-pp-plan-gates.js`): a subagent must be spawned AND its own transcript must show real search/tool-call evidence AND its most recent relayed response must end with a literal `VERDICT: APPROVE` line — a claim of having searched/approved, without that proof, does not satisfy the gate.
- **`enforce-pp-plan-gates.js`'s exemption is a PRINCIPLE, not a list to keep appending to (2026-07-24).** Two categories only: (1) an exact, frozen file set for the gate's own meta-tooling machinery — self-repair must never be circularly blocked by the gate itself, but this set does not grow casually; (2) `docs/**` as a directory category — writing documentation about a change is not implementing one, so it's exempt by category, never by adding individual doc filenames. If a new file seems to need its own one-off exemption, that is itself the signal to re-derive which of these two categories it actually belongs to, not to add a tenth entry to a list.
- **Two instances share one DB.** User runs `src-tauri/target/debug/rushcut.exe` directly (always-on Vite dev server). WDIO tests launch a separate process of the same binary. Both write to `%APPDATA%\rushcut\rushcut.db`. Never confuse their generated artifacts — WDIO renders show `instance=wdio` in the timing log.
- **WSL and PowerShell: use the PowerShell tool, not Bash.** Claude Code Bash = Git Bash; it mangles `/mnt/c/` paths, `$variables`, and `|` pipes inside `powershell.exe -Command "..."`. Use the dedicated `PowerShell` tool for all WSL calls and any PowerShell with variables or pipes. Glob patterns in PowerShell args get expanded by Git Bash — use `cmd.exe /c` for those.
- **`git push`:** Use `git push origin main` — Windows Credential Manager holds the PAT (set up 2026-06-16). The old `GIT_ASKPASS=echo ...` workaround was Bash-only and no longer needed.
- **Repo is PUBLIC on GitHub (since 2026-07-12).** Never commit secrets, credentials, or personal paths — including in commit **messages**, not just file diffs (a message quoting a value being scrubbed elsewhere re-leaks it; see `docs/LEARNINGS.md` "Workflow — a commit message describing a secret/PII purge..."). `.claude/` is gitignored/untracked — keep it that way, never re-add it. **Exception (2026-07-24, explicit user decision):** exactly 6 files implementing the search-verification governance hooks ARE tracked — `.claude/hooks/enforce-pp-plan-gates.js`, `enforce-pp-wrapup-signoff.js`, `hooks/lib/transcript.js`, `transcript.test.js`, `.claude/agents/rushcut-real-pp-auditor.md`, `rushcut-pp-consultant.md`. Everything else under `.claude/` (skills, other agents, `settings.json`) stays untracked exactly as before — do not widen this list without the same explicit confirmation.
- **Asset URLs:** Always `convertFileSrc(winPath)` from `@tauri-apps/api/core`. Never construct `asset://` URLs manually — video element shows nothing.
- **`pipeline-progress` Rust event must NOT include `stage`.** Only emit `{ jobId, progress }`. Stage field clobbers human-readable labels from `pipeline-stage`.
- **`DEFAULT_CONFIG.transition = "none"`** (not "crossfade"). Three options: `"none"` / `"crossfade"` / `"dip_to_black"`.
- **Tailwind:** `src/globals.css` has `@import "tailwindcss"`, imported from `main.tsx`. Do NOT reference `src/app/globals.css` (deleted).
- **gitignore:** `src-tauri/target/` and `src-tauri/gen/` must be in `.gitignore`. Missing = 668 MB of build artifacts blocking GitHub push.
- **ASCII only** in console/UI output — no Unicode or emoji (breaks cp1252 encoding).
- **Grep before claiming "exactly one place".** Before stating that a field, prop, or identifier is consumed in a single file, run `grep -r "field_name" src/` across all `.ts`/`.tsx` files. Claiming a single display site without checking causes missed updates (type errors at best, silent wrong display at worst).
- **Design system:** Read `docs/DESIGN.md` before any UI work — canonical colour palette, typography, button patterns, and copy rules. Do not invent colours or patterns outside it.
- **Pre-flight check before any render-verification batch.** Before executing a render or E2E verification, log three things (read-only, no fixes): (1) `wsl -- free -m` available memory, (2) proxy warm status for the test project (`proxy_status='done'` count vs total `include=1` clips), (3) zoom cache entries in `%TEMP%\rushcut\zoom-cache\`. If proxies are cold or available memory is under 4 GB, report it — let the user decide whether to proceed or use a warmer project.

---

## Efficiency rules

- **Verify incrementally, not at wrapup.** Run the relevant acceptance check (targeted render, smoke test, script) right after the step that could break it lands — not once in a bundled pass near the end of the session. A big batch of steps followed by one big verification pass finds regressions 5+ steps too late and after the damage compounds.

---

## Docs model (what lives where)

`.claude/` (rules, skills, hooks, agents) is local Claude Code dev tooling — gitignored, not part of the public repo. It exists on the maintainer's own machine; a fresh clone won't have it. References to `.claude/rules/*` and `.claude/skills/*` below are for local dev sessions that have it, not a promise to public contributors.

Four buckets — keep them separate; never let one accumulate another's content:

- **State** (current phase + next task): **MEMORY.md only** (auto-loaded each session). Overwrite, never append a diary.
- **Reference** (looked up on demand, deduplicated, no chronological entries): `docs/DESIGN.md`, `docs/LEARNINGS.md`, `.claude/rules/*`.
- **Strategic** (forward roadmap only): `docs/PRD-DEV.md`.
- **History + backlog**: git log + GitHub Issues + `docs/archive/` — never duplicated into the live docs.

## Key docs (read when relevant)

| File                | When to read                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `docs/DESIGN.md`    | **Always** before touching any UI — colours, fonts, spacing, copy tone    |
| `docs/LEARNINGS.md` | Debugging a known class of problem (FFmpeg, pipeline, E2E) — pattern library; grep for the relevant pattern, don't read in full. **Read before any in-session DB verification** (MSIX container path trap) |
| `docs/PRD-DEV.md`   | Strategic direction only — forward roadmap (AI Director, Auth/4K/Tier), AI Enablement, Phase 3 preview, swimlane legend. **No changelog, no backlog** (those moved to git log + GitHub Issues). |
| `.claude/rules/`    | Path-specific technical rules — load the relevant file, not all of them   |
| GitHub Projects #1  | **Execution backlog** — `gh project item-list 1 --owner bondybondbond --format json` to read; `gh issue view <n> --repo bondybondbond/rushcut --comments` to get the full brief for a ticket (body + session comments = primary input for planning). Use `gh issue create` + `gh project item-add` to write new items; `gh issue comment` to annotate existing ones. Swimlane, RICE, and field IDs: `.claude/skills/rushcut-wrapup/SKILL.md` Step 2.5. |
| `docs/archive/`     | Historical reference only. `phase1/` = Phase 1 architecture + changelog. `completed-plans/` = shipped batch plan specs + the full pre-2026-06-18 PRD-DEV batch history/changelog (`PRD-DEV-batches-14-N-full.md`). `DECISIONS.md` / `PRD.md` / `COMPETITORS.md` = retired strategy docs. Do not modify. |

---

## Detail in `.claude/rules/`

- **Pipeline invocation, manifest, FFmpeg quirks:** `.claude/rules/pipeline.md`
- **Tauri commands, permissions, capabilities:** `.claude/rules/rust-tauri.md`
- **E2E testing (WDIO + rushcut-eval skill):** `.claude/rules/e2e.md`

---

## Retired infrastructure (do not rebuild)

- Lambda / ECR / IAM role: DELETED
- R2 bucket: DELETED
- Supabase: PAUSED (data preserved, may be needed Phase 3)
- Docker Desktop: broken, irrelevant
