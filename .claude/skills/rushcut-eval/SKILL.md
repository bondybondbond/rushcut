---
name: rushcut-eval
description: DEPRECATED — WDIO smoke test is now built into /rushcut-wrapup Step 0.5; visual/acceptance-check eval is now the rushcut-qa-reviewer subagent wired into rushcut-dev-plan Step 7. Run /rushcut-wrapup for the smoke test, or let dev-plan invoke the reviewer for UI work. If only a smoke test is needed mid-session (not a full wrapup), run the fast spec suite manually via the commands in wrapup Step 0.5.
---

# Deprecated

The smoke test previously in this skill is now Step 0.5 of `/rushcut-wrapup`.

Visual/acceptance-check eval (screenshots, DESIGN.md token checks, console errors, and pipeline log/ffprobe checks) is now handled by the `rushcut-qa-reviewer` subagent, invoked automatically by `rushcut-dev-plan` Step 7 after each acceptance-checked step (UI or pipeline) is built — see `.claude/agents/rushcut-qa-reviewer.md`. This replaces the old manual screenshot ritual with a cold-context, read-only reviewer that doesn't grade its own work.

Use this fallback only for sessions with no Step-6 acceptance checks at all (pure docs edits, no implementation step to review) — any session with acceptance checks, UI or pipeline, is now covered by dev-plan Step 7's `rushcut-qa-reviewer` invocation:

**To run a quick smoke test mid-session without a full wrapup:**

```bash
powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgedriver -Force -ErrorAction SilentlyContinue"
cmd.exe /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 && start C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"
```

Wait 5s, then:

```bash
powershell.exe -Command "Set-Location C:/apps/rushcut; pnpm test:e2e 2>&1"
```
