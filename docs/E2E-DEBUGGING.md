# E2E Debugging Notes — Batch 11b

WebdriverIO v9 + msedgedriver attach to Tauri/WebView2 via CDP port 9222.

---

## Status: RESOLVED (2026-03-26)

**Fix:** 3-layer defense in `wdio.conf.ts`:

1. `--disable-bidi` flag on msedgedriver spawn (primary — kills BiDi negotiation entirely)
2. `webSocketUrl: false` in capabilities (belt-and-suspenders)
3. Route-aware readiness gate: `checkTargets` now waits for `/upload`, `/library`, or `/editor/` (not just "non-blank")

Plus: refactored `beforeSession` into named helpers, aligned timeouts to 30s, reduced blind delay 6s -> 2s.

**Verification:** 3 consecutive `pnpm test:e2e` runs from PowerShell — 7/7 all three times. Zero `BIDI COMMAND` in logs.

---

## What was failing (resolved)

**Test run: 3/5 passing, 2 failing.**

Failure 1 — `Upload page "before all" hook`:

```
Command browsingContext.navigate with id 10
({"context":"...","url":"http://localhost:1420/","wait":"complete"}) timed out
```

Failure 2 — `Editor page navigates to My Projects via NavDrawer`:

```
WebDriverError: The operation was aborted due to timeout when running "element"
```

(cascades from Failure 1 — session is in broken state)

---

## Root cause

**`wdio:enforceWebDriverClassic: true` is not disabling BiDi.**

The WDIO logs show BiDi is fully active even with the flag set:

```
Register BiDi handler for session
Connecting to webSocketUrl ws://127.0.0.1:9515/session/...
BIDI COMMAND browsingContext.getTree {}
BIDI RESULT "url":"about:blank"  <-- navigation race still unresolved
BIDI COMMAND browsingContext.navigate {"url":"http://localhost:1420/","wait":"complete"}
```

The `browsingContext.navigate` call hangs forever because:

- Vite dev server uses a persistent HMR WebSocket
- WebDriver's "page load complete" waits for `document.readyState === "complete"`
- The open HMR socket prevents that state from ever firing

The flag `wdio:enforceWebDriverClassic: true` appears to be a WDIO-level hint that doesn't actually
prevent msedgedriver from negotiating and using BiDi. In this WDIO v9 / msedgedriver 146 combo,
the session always starts with BiDi active.

---

## History of what was tried

| Attempt                                         | Result                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Default WDIO v9 — BiDi on                       | `getUrl()` always returns `about:blank` (BiDi `browsingContext.getTree` returns stale data for WebView2 attach mode)     |
| Added `wdio:enforceWebDriverClassic: true`      | First cold-start run: 7/7 PASS. Subsequent runs: still broken. Flag doesn't reliably suppress BiDi.                      |
| Removed all `browser.url()` calls from spec     | Eliminated Vite HMR hang from our own code, but WDIO internally still calls `browsingContext.navigate`                   |
| Kill stale port 9222 process in `beforeSession` | Prevents "connecting to dead WebView2" across runs                                                                       |
| 6-second delay after `checkTargets` resolves    | Intended to let navigation complete before msedgedriver attaches, but BiDi session setup itself re-triggers the navigate |
| Prefer debug binary over release binary         | Ensures `data-testid` attrs are present; release binary was stale                                                        |

---

## Why the 7/7 cold-start run worked

On a cold machine with no stale processes, the first run probably benefited from:

- No stale WebView2 subprocess (port 9222 fully clear)
- Page already at `/upload` (navigation complete) before msedgedriver attached
- BiDi's `browsingContext.getTree` happened to return the live URL rather than `about:blank`

This was a timing fluke, not a reliable fix.

---

## What was tried and what worked

### Applied (all three together):

- **Option A — `--disable-bidi` on msedgedriver spawn** — PRIMARY fix. msedgedriver 146 accepts the flag. Kills BiDi WebSocket negotiation entirely, so WDIO falls back to classic WebDriver for all operations.
- **Option B — `webSocketUrl: false` in capabilities** — defense-in-depth alongside `wdio:enforceWebDriverClassic: true`.
- **Option E — Route-aware readiness gate** — `checkTargets` now waits for `/upload`, `/library`, or `/editor/` in CDP `/json/list` (30s timeout). Stronger than "any non-blank URL".

### Not needed:

- **Option C** — No `baseUrl` existed; the navigate URL came from BiDi internals.
- **Option D** — With BiDi disabled, blind delay only covers DOM hydration (2s sufficient).

---

## Key constraints (don't lose these)

- **Never use `browser.url()`** — hangs indefinitely on Vite dev server (HMR WebSocket)
- **Never use BiDi `browsingContext.navigate`** — same reason
- **Kill port 9222 process in `beforeSession`** — WebView2 subprocess outlives `rushcut.exe`
- **Use debug binary** — release binary doesn't have current `data-testid` attrs without `tauri build`
- **Run from PowerShell** — Git Bash mangles WSL paths and wdio.conf.ts paths

---

## Current file state

- `wdio.conf.ts` — refactored: named helpers (`killStaleProcesses`, `ensureViteRunning`, `waitForAppRoute`), `--disable-bidi`, `webSocketUrl: false`, route-aware gate (30s), 2s hydration delay
- `e2e/fast.spec.ts` — `before` hook polls `getUrl()` for `/upload` or `/library` (no `browser.url()`)
- `e2e/render.spec.ts` — untouched (full pipeline E2E, ~5 min)
- `src-tauri/Cargo.toml` — `devtools` feature added
