---
name: rushcut-eval
description: DEPRECATED — smoke test is now built into /rushcut-wrapup Step 0.5. Run /rushcut-wrapup instead. If only a smoke test is needed mid-session (not a full wrapup), run the fast spec suite manually via the commands in wrapup Step 0.5.
---

# Deprecated

The smoke test previously in this skill is now Step 0.5 of `/rushcut-wrapup`.

Visual/design eval (screenshots, acceptance checks) is handled inline during build via the dev-plan skill's acceptance check cadence.

**To run a quick smoke test mid-session without a full wrapup:**

```bash
powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgedriver -Force -ErrorAction SilentlyContinue"
cmd.exe /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 && start C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"
```

Wait 5s, then:

```bash
powershell.exe -Command "Set-Location C:/apps/rushcut; pnpm test:e2e 2>&1"
```
