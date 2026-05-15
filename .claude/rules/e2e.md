# E2E testing rules

Applies when working on `e2e/**`, `wdio.conf.ts`, or running `/rushcut-eval`.

## WDIO setup

- Run `pnpm test:e2e` from **PowerShell only** — Git Bash mangles paths in wdio.conf.ts.
- **3-layer BiDi fix (do not remove):** `--disable-bidi` on msedgedriver spawn + `webSocketUrl: false` in capabilities + route-aware `waitForAppRoute()` readiness gate.
- Debug binary first (`src-tauri/target/debug/rushcut.exe`), release as fallback. Debug loads from live Vite dev server — always reflects current source without `tauri build`.
- CDP port 9222: launch binary with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`.

## chrome-devtools MCP AND preview_* MCP both conflict with WDIO (critical — do not mix in same session)

Calling any `mcp__chrome-devtools__*` tool **or** any `preview_*` tool (e.g. `preview_start`, `preview_screenshot`) starts a Chrome/Edge browser on port 9222 for the lifetime of the Claude Code session. This squats the port: WDIO's `waitForPort(9222)` resolves to the MCP browser (not the Tauri WebView2), msedgedriver attaches to the MCP browser, and `getUrl()` always returns `about:blank`. **Do not use either MCP family in any session that also runs WDIO E2E tests.**

If already called, free the port before running E2E:
```powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
```
Then re-launch the Tauri binary.

## Stale process cleanup (beforeSession)

Kill `rushcut.exe`, `msedgedriver.exe`, and the process holding port 9222:

```powershell
Get-NetTCPConnection -LocalPort 9222 | Select-Object OwningProcess | Stop-Process -Force
```

WebView2 subprocess survives `rushcut.exe` kill and holds the port.

## Never use `isExisting()` for conditionally-rendered elements

`isExisting()` returns immediately (no polling). For any element that renders after an async `useEffect` (e.g. buttons that appear after `get_project` resolves, form fields that appear after a fetch), use `waitForExist({ timeout: N })` instead. Wrap in try/catch when the element's absence is a valid code path (e.g. non-4K renders skip the `btn-render-film` gate entirely).

```typescript
// Wrong — fires before async data loads:
if (await $('[data-testid="btn-render-film"]').isExisting()) { ... }

// Correct — waits up to 10s, gracefully handles absence:
try {
  await $('[data-testid="btn-render-film"]').waitForExist({ timeout: 10_000 });
  await $('[data-testid="btn-render-film"]').click();
} catch { /* non-4K auto-starts without button */ }
```

## Never use `browser.url()`

Hangs indefinitely — Vite HMR WebSocket blocks `readyState === "complete"`. Poll via `browser.waitUntil(() => browser.getUrl())`.

## Never use `getHTML(false)` on the full body in any spec

`$("body").getHTML(false)` fetches ~1.9MB of body HTML (MediaPantry thumbnails are base64-embedded as `src="data:image/jpeg;base64,..."` attributes) through WebDriver, causing >10 min transfers that exceed the 600s Mocha timeout. Replacement: `browser.execute(() => document.body.textContent ?? "")` — returns text nodes only, no attribute values, no base64. For targeted checks: `$('[data-testid="..."]').getText()` or `$$("button").find(b => b.getText() === "...")`.

## No `pushState` in `before()` hooks — drive the real UI

Every spec `before()` hook must navigate via real UI clicks, not `history.pushState`. Shortcuts blind tests to broken transitions and missing state; the navigation path is part of what is being tested.

**Only permitted shortcut:** `scan_folder` + `create_project` via `browser.execute(invoke(...))` — OS file dialogs cannot be automated. After calling these, navigate forward exclusively via UI clicks.

**Exception in `trimmer.spec.ts`:** `pushState` is used after `create_project` because the invoke call bypasses Upload.tsx React state (no auto-navigation fires). Documented in the spec with a `// TODO` comment. All future specs (`transitions.spec.ts`, `sound.spec.ts`) must walk the full flow from their starting screen.

## Known stale specs

None — all specs current as of 2026-04-29.

## render.spec.ts duration assertion

`expect(info.duration).toBeGreaterThan(3)` — threshold is `3`, not `10`. With 1 clip added the output is ~7s. `> 3` is a "non-trivial output" check; don't tie it to expected clip count.

## rushcut-eval skill (`/rushcut-eval`)

Hybrid eval: WDIO specs for deterministic assertions + 3 MCP screenshots + 1 console check. Full spec at `.claude/skills/rushcut-eval/SKILL.md`.

Key rules:

- Run WDIO via **PowerShell** with `powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e:xxx 2>&1"`.
- Three spec suites: `test:e2e` (fast), `test:e2e:editor` (gap-editor), `test:e2e:render` (render).
- Failure screenshots auto-saved to `e2e/screenshots/` (in `.gitignore`) via `afterTest` hook.
- Acceptable `invoke()` shortcuts in specs: `scan_folder` + `create_project` (OS file dialogs can't be automated). Use `browser.execute()` for these.
- Upload page clip display = permanent SKIP. `invoke("scan_folder")` returns data but bypasses `setClips()`.
- Fall back to `mcp__chrome-devtools__take_snapshot` for live DOM inspection on failures — hybrid reduces MCP use, does not eliminate it.
