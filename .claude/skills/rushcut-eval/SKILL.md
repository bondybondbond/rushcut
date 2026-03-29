---
name: rushcut-eval
description: Full human-like E2E evaluation of the RushCut Tauri desktop app. Run this after every batch of development to verify all UI flows work correctly -- upload, editor settings, pipeline rendering, video output, and navigation. Triggers on "run eval", "project eval", "e2e eval", "/rushcut-eval", "test the app", "does it work", "verify the app", "check everything works", or any request to validate the app end-to-end. Use this skill proactively after completing batch work, even if the user just says "wrap up" or "are we done".
---

# RushCut E2E Eval

Hybrid approach: WDIO specs for deterministic assertions (~5 tokens vs ~1000 per MCP snapshot), 3 MCP screenshots for human visual checkpoints, 1 MCP call for console errors.

## Setup

Kill stale processes before running:

```bash
powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgedriver -Force -ErrorAction SilentlyContinue"
powershell.exe -Command "$p = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"
```

## Eval Flow

### Step 1 — Run fast spec (upload + nav + basic editor)

```bash
powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e 2>&1"
```

Take a screenshot after the spec finishes (visual checkpoint 1 — editor state):

```
mcp__chrome-devtools__list_pages → select_page → take_screenshot
```

Record PASS/FAIL counts from WDIO stdout.

### Step 2 — Run editor spec (music chips, settings, clips, NavDrawer from library)

```bash
powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e:editor 2>&1"
```

Record PASS/FAIL counts from WDIO stdout.

### Step 3 — Run render spec (render pipeline, codec, output navigation)

```bash
powershell.exe -Command "cd C:/apps/rushcut && pnpm test:e2e:render 2>&1"
```

Take a screenshot after render completes (visual checkpoint 2 — output page):

```
mcp__chrome-devtools__take_screenshot
```

Take a screenshot after navigating to library (visual checkpoint 3 — Done status):

```
mcp__chrome-devtools__take_screenshot
```

Record PASS/FAIL counts from WDIO stdout.

### Step 4 — Console error check

Connect to the running app via Chrome DevTools and check for errors:

```
mcp__chrome-devtools__list_pages → select_page
mcp__chrome-devtools__list_console_messages (types: ["error"], includePreservedMessages: true)
```

- PASS if zero console errors (React Router future-flag warnings are OK to note)

## Fallback to MCP for diagnosis

If a WDIO test fails and the stdout isn't enough to diagnose:

1. Start a fresh app: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" "C:/apps/rushcut/src-tauri/target/debug/rushcut.exe" &`
2. Connect: `mcp__chrome-devtools__list_pages` → `select_page`
3. Use `take_snapshot` to inspect the failing element live

The hybrid model reduces MCP use — it does not prevent falling back when needed.

## Test Data

Standard test set: 3 DJI Osmo Pocket 3 clips in `C:\clips\`:
- DJI_01.MP4 (1.3s, portrait 1728x3072)
- DJI_02.MP4 (10.6s, portrait 1728x3072)
- DJI_03.MP4 (10.9s, portrait 1728x3072)

Output written to `C:\clips\processed\<slug>-<shortid>.mp4`.

## What Each Spec Covers

**fast.spec.ts** (`pnpm test:e2e`):
- Choose Folder + Add Files buttons visible
- NavDrawer opens/closes on hamburger click
- Nav items (New Project, My Projects) visible
- Navigation to /library
- Inline project name edit: opens on click, Escape cancels
- Back button navigates to /library

**gap-editor.spec.ts** (`pnpm test:e2e:editor`):
- Project name "Eval Test Film" displayed
- Clip list non-empty
- Music chip cycling: each mood activates on click
- Only one chip active at a time
- Intro text input accepts text
- Outro text input accepts text
- NavDrawer opens/closes from /library page

**render.spec.ts** (`pnpm test:e2e:render`):
- Choose Folder button visible
- Project creation via invoke shortcut
- Render button visible and enabled
- Render click navigates to /output/
- Stage label appears during pipeline
- Progress % increments to 100%
- "Your film is ready" heading appears
- Video src contains asset.localhost
- Output filename matches slug-shortId.mp4
- Video readyState = 4, no errors, duration > 10s
- ffprobe: h264 Main codec, 608x1080 portrait, AAC audio
- My Projects button navigates to /library
- Project shows status "Done" in library

## Report Format

After all steps, output a summary table:

```
## RushCut E2E Eval Report

| Suite | Checks | Result | Notes |
|-------|--------|--------|-------|
| fast  | X/Y    | PASS   | |
| editor| X/Y    | PASS   | |
| render| X/Y    | PASS   | |
| console | 0 errors | PASS | |

### Screenshots
- [Visual checkpoint 1 — editor]
- [Visual checkpoint 2 — output page]
- [Visual checkpoint 3 — library Done status]

### Summary
- **Total: X / Y checks passed**
- **Observations**: (anything notable)
- **Potential fixes**: (actionable items)
```

## Failure screenshots

On any WDIO test failure, a screenshot is auto-saved to `e2e/screenshots/<test-name>-FAIL.png`. Check there first before connecting MCP for live inspection.
