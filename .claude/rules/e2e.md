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

## rushcut-qa-reviewer subagent owns the CDP port during its background run

`.claude/agents/rushcut-qa-reviewer.md` is invoked by `rushcut-dev-plan` Step 6 (via the Agent tool, `run_in_background: true`) after each screen is built. It uses `preview_*` MCP tools only — it never runs WDIO, which avoids the exact conflict above recurring on every single screen (that would force process-lifecycle juggling per screen instead of per session).

**Ownership rule:** the reviewer owns `preview_*`/CDP port 9222 for the duration of its background run. The invoking session must not call any `preview_*` tool again until the reviewer's completion notification arrives. This is the same underlying conflict as the chrome-devtools/preview_*-vs-WDIO rule above, just scoped to two consumers of the same MCP browser instead of MCP-vs-WDIO.

This rule only applies when the reviewer's review actually touches `preview_*`. A pipeline-only review (PowerShell + log/ffprobe reads only, no `preview_*` calls) never claims the CDP port — the invoking session is free to keep using `preview_*` itself during that review's background run.

**Phase 2 (deferred, not built):** true concurrent QA — reviewing screen N while screen N+1's own build-eval is also touching the browser — needs a second Tauri instance on an isolated CDP/WDIO port pair (e.g. 9223/9516), a new `wdio.qa.conf.ts`, and swapping `killStaleProcesses`' `taskkill /IM rushcut.exe` for PID-scoped killing so a QA run never touches the user's live binary. Not built — file a GitHub issue if/when this becomes worth doing.

**[TRAP] `preview_*` MCP tools never reach a real Tauri IPC context, no matter how the binary is launched — confirmed on #90 (2026-07-08).** `preview_start`'s `.claude/launch.json` `"vite"` config only waits for the Vite HTTP server (port 1420) to respond, then drives Claude's own persistent Electron-embedded browser to that URL directly — it is a separate browser process from any `rushcut.exe` WebView2, full stop, regardless of whether the Tauri binary is running, freshly launched, or launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. Proof: `preview_eval`'s `navigator.userAgent` reports `Claude/... Electron/... MSIX` (not WebView2/Edge), and `window.__TAURI__` is `undefined` in that context every time. **Consequence: `rushcut-qa-reviewer` (and any orchestrator use of `preview_*`) can never exercise real `invoke()` calls, load a real project, or reach any route needing DB-backed data** — it can only verify what renders on the bare Vite page with no backend attached (static shell, layout, CSS). Confirmed via two independent attempts in the same session (plain binary, then binary + explicit CDP flag) failing identically — do not retry a third variant; if a review needs real project data or Tauri IPC, either have the user manually verify via their own `rushcut.exe` launch, or use WDIO (which *does* attach correctly via msedgedriver, per the 3-layer BiDi fix above) instead of `preview_*`.

## Never run WDIO while a user render is in progress (critical)

`beforeSession` kills ALL `rushcut.exe` processes — including the user's live binary. The pipeline keeps running in WSL and may complete, but the new binary has no Rust stdout listener for that job. `DONE:` is never received; the job stays `processing` forever. Before running any E2E suite, confirm no pipeline is running:
```powershell
wsl -d Ubuntu-24.04 -u root -- tail -5 /mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/pipeline-latest.log
```
If the last line is `DONE:` or `ERROR:`, the pipeline is idle — safe to run E2E. If the last line is `PROGRESS:` or `STAGE:`, wait for it to finish first.

## wdio.conf.ts killStaleProcesses has backslash typo — fix before re-run

`killStaleProcesses` uses `\F \IM` (backslash) instead of `/F /IM` in `taskkill`, so msedgedriver is never killed between runs. Before re-running WDIO in a fresh shell:
```powershell
taskkill /F /IM msedgedriver.exe; taskkill /F /IM rushcut.exe
```
Fix the typo in `wdio.conf.ts`: change `\F \IM` → `/F /IM` in both `taskkill` calls inside `killStaleProcesses`.

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

## Never use `browser.navigate()`

`browser.navigate()` does not exist in WebdriverIO v9 — calling it throws "browser.navigate is not a function". To navigate mid-spec, use `browser.execute(() => window.history.pushState({}, "", "/path"))` then `waitUntil(() => browser.getUrl().includes("/path"))`. This is the same `pushState` pattern used elsewhere in the specs; the permitted-shortcut caveat from e2e.md still applies (prefer real UI clicks; pushState is only for cases where a real click is impractical mid-spec).

## CDP `pushState` alone does not trigger React Router — must also dispatch `popstate`

`window.history.pushState({}, "", "/path")` updates the URL but does NOT cause BrowserRouter to re-render. The component tree stays on the old route. Always follow with: `window.dispatchEvent(new PopStateEvent("popstate", { state: null }))`. Combined form used in eval sessions: `window.history.pushState({}, "", target); window.dispatchEvent(new PopStateEvent("popstate", { state: null }))`.

## CDP `evaluate_script` `dialogAction` has no effect on Tauri plugin (Win32) dialogs

`dialogAction: "accept"` / `"dismiss"` on `evaluate_script` only intercepts JS dialogs (`window.alert/confirm/prompt`). The `confirm()` from `@tauri-apps/plugin-dialog` shows a native Win32 `MessageBox` — outside WebView2, CDP has no hook into it. To verify a Tauri plugin dialog worked: (1) JS promise suspends but renderer stays responsive; (2) computer-use `request_access` times out if the modal is blocking the desktop; (3) after user dismisses, check URL and console for correct branch + no rejection errors. Do NOT rely on `dialogAction` for plugin dialogs.

## Never use `getHTML(false)` on the full body in any spec

`$("body").getHTML(false)` fetches ~1.9MB of body HTML (MediaPantry thumbnails are base64-embedded as `src="data:image/jpeg;base64,..."` attributes) through WebDriver, causing >10 min transfers that exceed the 600s Mocha timeout. Replacement: `browser.execute(() => document.body.textContent ?? "")` — returns text nodes only, no attribute values, no base64. For targeted checks: `$('[data-testid="..."]').getText()` or `$$("button").find(b => b.getText() === "...")`.

## No `pushState` in `before()` hooks — drive the real UI

Every spec `before()` hook must navigate via real UI clicks, not `history.pushState`. Shortcuts blind tests to broken transitions and missing state; the navigation path is part of what is being tested.

**Only permitted shortcut:** `scan_folder` + `create_project` via `browser.execute(invoke(...))` — OS file dialogs cannot be automated. After calling these, navigate forward exclusively via UI clicks.

**Exception in `trimmer.spec.ts`:** `pushState` is used after `create_project` because the invoke call bypasses Upload.tsx React state (no auto-navigation fires). Documented in the spec with a `// TODO` comment. All future specs (`transitions.spec.ts`, `sound.spec.ts`) must walk the full flow from their starting screen.

## Known stale specs

None — all specs current as of 2026-06-02.

## WDIO after() hook — proxy claim cleanup (Batch T7)

`wdio.conf.ts` has an `after()` hook (fires per spec file, browser still alive) that resets `proxy_status='encoding'` claims for every test project before the binary is SIGTERM'd in `afterSession`. This prevents stuck claims accumulating in the shared DB across WDIO runs.

- Each spec calls `trackTestProject(projectId)` from `e2e/helpers/testProjects.ts` right after capturing the project id
- The `after()` hook iterates `trackedTestProjects()` and calls `reset_proxy_encoding_cmd` via `browser.execute` with `(window as any).__TAURI_INTERNALS__.invoke(...)` (the exact pattern all specs use — NOT `__TAURI__.core.invoke`)
- **Do not remove the `after()` hook** — without it, `afterSession`'s SIGTERM leaves HEVC clip claims stuck at `'encoding'` for the life of any reused binary
- **When adding a new spec** that calls `create_project`, add `trackTestProject(projectId)` immediately after the id is captured (one line + import only)

## Keep waitUntil polling conditions in sync with UI copy

When any heading or label string changes in the UI, grep `e2e/` for that exact string and update every `waitUntil` / `expect(...).toBe(...)` that references it. A `waitUntil` that checks a stale string will time out (up to 9 min for the render done-condition) but the assertions that follow may still pass if the render completed during the timeout — masking the failure until the timeout fires. Symptom: one test shows `Pipeline did not reach 100% within N minutes` even though the video player and done-state assertions all passed.

Example pattern from `render.spec.ts`:
```typescript
// waitUntil done-condition — must match the current h1 copy:
if (await h1.isExisting() && (await h1.getText()) === "Your film") return true;
```

## Cross-screen display consistency — required check for any displayed value

**Root cause of recurring bugs:** A feature is implemented on one screen and works, but the same value is displayed on other screens (ChosenEffects chip, TopInfoBar, Sound Master tab, Render screen stage labels) and shows raw/wrong text. E2E tests pass because they only check the screen the feature lives on.

**Rule:** Before closing any task that introduces or changes a displayed value (transition name, music mood, clip count, project name, stage label, etc.), grep for ALL display sites:
```
grep -r "transition\|mood\|shuffle\|proxy\|normalise" src/components/ src/pages/ --include="*.tsx" -l
```
For each file that renders the value, verify the display is human-readable (not a raw enum string like `"shuffle"`, `"band_wipe"`, `"none"`). If a display-name utility doesn't exist yet, create one (`src/utils/displayName.ts`) and use it everywhere.

**Known cross-screen display sites to always check:**
- `src/components/ChosenEffects.tsx` — transition name + music mood chips shown on every editor screen
- `src/components/TopInfoBar.tsx` — project name + clip count
- `src/pages/Sound.tsx` Master tab — transition summary text in film preview area
- `src/pages/Render.tsx` — stage labels from pipeline (`STAGE:` stdout lines)
- `src/pages/Library.tsx` — project last-job status

## Resolution variants — 4K must be explicitly considered for every pipeline change

**Root cause of Batch N 4K gap:** Background proxy gen was implemented and tested at 1080p. The 4K render path uses a different normalise height (`scale=-2:2160`) and a different proxy height threshold. Any change to the proxy/normalise/render pipeline must be checked against BOTH resolutions.

**Rule:** For any change touching `pipeline/render.py`, `pipeline/normalise.py`, `src-tauri/src/lib.rs` proxy functions, or `pipeline/proxy.py`:
1. Check that the change is correct for `output_resolution = "1080p"` AND `output_resolution = "4k"`
2. Look for hardcoded height values (`1080`, `scale=-2:1080`) and ask: does this need to be `2160` or resolution-parameterised?
3. After shipping, read `render-timing-log.jsonl` and confirm a 4K render entry (look for `"resolution":"4k"`) shows expected `proxy_used` and `t_normalise_s`

**render.spec.ts 4K gap:** The render E2E only exercises the 1080p path. A full 4K render E2E is too slow for CI (>5 min). Compensate with a manual check: after any proxy/normalise change, do one real 4K render and read `render-timing-log.jsonl` before declaring done.

## render.spec.ts duration assertion

`expect(info.duration).toBeGreaterThan(3)` — threshold is `3`, not `10`. With 1 clip added the output is ~7s. `> 3` is a "non-trivial output" check; don't tie it to expected clip count.

## rushcut-eval skill (`/rushcut-eval`) — DEPRECATED, split in two

The old hybrid eval (WDIO + 3 MCP screenshots + 1 console check) is now two separate things:
- Visual/acceptance-check eval → `rushcut-qa-reviewer` subagent, invoked automatically by `rushcut-dev-plan` Step 6 (see section above)
- WDIO structural smoke test → `rushcut-wrapup` Step 0.5

`.claude/skills/rushcut-eval/SKILL.md` is kept only as a manual fallback for docs-only/pipeline-only sessions with no screen to review.

Key rules (still apply wherever WDIO runs, including wrapup and the fallback):

- Run WDIO via **PowerShell** with `powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e:xxx 2>&1"`.
- Three spec suites: `test:e2e` (fast), `test:e2e:editor` (gap-editor), `test:e2e:render` (render).
- Failure screenshots auto-saved to `e2e/screenshots/` (in `.gitignore`) via `afterTest` hook.
- Acceptable `invoke()` shortcuts in specs: `scan_folder` + `create_project` (OS file dialogs can't be automated). Use `browser.execute()` for these.
- Upload page clip display = permanent SKIP. `invoke("scan_folder")` returns data but bypasses `setClips()`.
