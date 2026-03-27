# E2E testing rules

Applies when working on `e2e/**`, `wdio.conf.ts`, or running `/rushcut-eval`.

## WDIO setup

- Run `pnpm test:e2e` from **PowerShell only** — Git Bash mangles paths in wdio.conf.ts.
- **3-layer BiDi fix (do not remove):** `--disable-bidi` on msedgedriver spawn + `webSocketUrl: false` in capabilities + route-aware `waitForAppRoute()` readiness gate.
- Debug binary first (`src-tauri/target/debug/rushcut.exe`), release as fallback. Debug loads from live Vite dev server — always reflects current source without `tauri build`.
- CDP port 9222: launch binary with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.

## Stale process cleanup (beforeSession)

Kill `rushcut.exe`, `msedgedriver.exe`, and the process holding port 9222:

```powershell
Get-NetTCPConnection -LocalPort 9222 | Select-Object OwningProcess | Stop-Process -Force
```

WebView2 subprocess survives `rushcut.exe` kill and holds the port.

## Never use `browser.url()`

Hangs indefinitely — Vite HMR WebSocket blocks `readyState === "complete"`. Poll via `browser.waitUntil(() => browser.getUrl())`.

## rushcut-eval skill (`/rushcut-eval`)

Hybrid eval: WDIO specs for deterministic assertions + 3 MCP screenshots + 1 console check. Full spec at `.claude/skills/rushcut-eval/SKILL.md`.

Key rules:

- Run WDIO via **PowerShell** with `powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e:xxx 2>&1"`.
- Three spec suites: `test:e2e` (fast), `test:e2e:editor` (gap-editor), `test:e2e:render` (render).
- Failure screenshots auto-saved to `e2e/screenshots/` (in `.gitignore`) via `afterTest` hook.
- Acceptable `invoke()` shortcuts in specs: `scan_folder` + `create_project` (OS file dialogs can't be automated). Use `browser.execute()` for these.
- Upload page clip display = permanent SKIP. `invoke("scan_folder")` returns data but bypasses `setClips()`.
- Fall back to `mcp__chrome-devtools__take_snapshot` for live DOM inspection on failures — hybrid reduces MCP use, does not eliminate it.
