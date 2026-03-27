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

Human-like eval via chrome-devtools MCP. Full spec at `.claude/skills/rushcut-eval/SKILL.md`.

Key rules:
- UIDs go stale after any React re-render. Always take fresh `take_snapshot` / `wait_for` before clicking.
- Acceptable `invoke()` shortcuts: `scan_folder` (OS file dialog) + `create_project` (needs React state). Everything else via UI clicks.
- Upload page clip display = permanent SKIP. `invoke("scan_folder")` returns data but bypasses `setClips()`.
