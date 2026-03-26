---
name: rushcut-eval
description: Full human-like E2E evaluation of the RushCut Tauri desktop app. Run this after every batch of development to verify all UI flows work correctly -- upload, editor settings, pipeline rendering, video output, and navigation. Triggers on "run eval", "project eval", "e2e eval", "/rushcut-eval", "test the app", "does it work", "verify the app", "check everything works", or any request to validate the app end-to-end. Use this skill proactively after completing batch work, even if the user just says "wrap up" or "are we done".
---

# RushCut E2E Eval

You are evaluating RushCut, a Tauri 2.x desktop video editor. The app runs React+Vite inside a WebView2 window. You will drive it like a real user via Chrome DevTools Protocol -- clicking buttons, filling inputs, reading page content. Avoid coding shortcuts (no `invoke()`, no `window.location.href`) except for the two cases where OS-level dialogs make it impossible.

## Philosophy

Act like a human tester, not a programmer. When you want to click a button, use `mcp__chrome-devtools__click` with the element's UID from a page snapshot. When you want to type text, use `mcp__chrome-devtools__fill`. When you want to check what's on screen, take a snapshot. Only fall back to `evaluate_script` when there's no other way (e.g., reading video element metadata, or the two invoke shortcuts below).

**Snapshot tools available (use both):**
- `take_snapshot` -- returns an accessibility tree with UIDs for all elements. Use this as your primary tool to see the page structure and get UIDs for click/fill.
- `take_screenshot` -- returns a visual screenshot of the page. Use this to visually verify layout, colours, and UI state (e.g., confirming an orange border on the active music chip, or that the video player is rendering correctly). This is your "eyes" -- use it at key moments to see what the user sees.
- `wait_for` -- waits for specific text to appear, then returns a snapshot. Use this when you need to wait for navigation or async state changes before interacting.

Use `take_snapshot` for routine element finding. Use `take_screenshot` at visual checkpoints (after page loads, after settings changes, on the output page). Use `wait_for` when waiting for navigation or async updates.

## Setup

Before testing, prepare the environment:

1. **Kill stale processes** (required -- leftover WebView2 subprocesses hold CDP port):
   ```bash
   powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue; Stop-Process -Name msedgedriver -Force -ErrorAction SilentlyContinue"
   powershell.exe -Command "$p = Get-NetTCPConnection -LocalPort 9222 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"
   ```
   Wait 2 seconds after killing.

2. **Ensure Vite is running on port 1420**. Check with curl. If not running:
   ```bash
   cd C:/apps/rushcut && npx vite --port 1420 &
   ```
   Wait for it to respond before continuing.

3. **Launch the debug binary with CDP**:
   ```bash
   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" "C:/apps/rushcut/src-tauri/target/debug/rushcut.exe" &
   ```
   Poll `http://127.0.0.1:9222/json/list` until the URL contains `/upload` (app has loaded and React Router has redirected). Timeout: 30 seconds.

4. **Connect via chrome-devtools**: `list_pages`, then `select_page` on the RushCut page.

## Important constraints

- **All WSL commands must use `powershell.exe -Command "wsl ..."`** -- Git Bash (Claude Code's shell) mangles `/mnt/c/` paths.
- **Never use `browser.url()` or `navigate_page` to localhost:1420** -- Vite's HMR WebSocket causes hangs.
- **Prefer page snapshots + click/fill over evaluate_script** -- this tests the real DOM interaction path.
- **UIDs go stale after React re-renders.** Every time you click something that changes React state (navigation, chip toggle, form submit), the old UIDs are invalidated. Always take a fresh snapshot via `take_snapshot` or `wait_for` before your next `click` or `fill` call. Never reuse UIDs from a previous snapshot.
- **Add ~200ms delay between sequential state-changing clicks.** React needs time to re-render after each state change. When clicking through a sequence (e.g., music chips in a loop), pause briefly between clicks or take a fresh snapshot between each one.
- **Use `take_screenshot` at visual checkpoints.** After each major page load (upload, editor, output, library) and after visual state changes (music chip selection, settings fill), take a screenshot so you can see the app as the user does. This catches visual bugs that accessibility snapshots miss.

## Eval Flow

Work through each section in order. Track results as you go: for each check, record PASS, FAIL, or SKIP with a brief note.

### 1. Upload Page

Take a snapshot of the page. Verify:
- [ ] "Choose Folder" button (`data-testid="btn-choose-folder"`) is visible and enabled
- [ ] "Add Files" button (`data-testid="btn-add-files"`) is visible and enabled

**Acceptable shortcut #1**: The OS native file dialog cannot be automated via WebDriver/CDP. Use `evaluate_script` to call:
```javascript
async () => {
  const { invoke } = window.__TAURI_INTERNALS__;
  const metas = await invoke("scan_folder", { folderPath: "C:\\clips" });
  return { count: metas.length, files: metas.map(m => m.filename) };
}
```
This simulates what happens when a user picks `C:\clips` in the folder dialog.

**Known limitation:** `invoke("scan_folder")` returns clip metadata from Rust but does NOT update the React component state on the Upload page. The Upload page's `handleScan` callback calls `setClips()` after `invoke()`, but calling `invoke()` directly via `evaluate_script` bypasses React's state setter. This means clip items will NOT appear in the UI after the invoke shortcut. Mark these checks as SKIP:
- [ ] Clip items appear on page -- **SKIP** (React state not updated by invoke shortcut; requires native file dialog)
- [ ] Clip count matches -- **SKIP** (same reason)

The scan data is still used by `create_project` in the next step, so this does not block the rest of the eval.

### 2. Project Creation

**Acceptable shortcut #2**: Creating a project requires the clips from the scan, which are in React component state. Use `evaluate_script`:
```javascript
async () => {
  const { invoke } = window.__TAURI_INTERNALS__;
  const metas = await invoke("scan_folder", { folderPath: "C:\\clips" });
  const clips = metas.map(m => ({
    filename: m.filename, local_path: m.local_path,
    size_bytes: m.size_bytes, duration_ms: m.duration_ms,
    width: m.width, height: m.height,
    has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null
  }));
  return await invoke("create_project", { name: "Eval Test Film", clips });
}
```

Now navigate **like a human** -- do NOT use `window.location.href`:
1. Take a snapshot via `wait_for` (look for "Open menu" text), find the hamburger button, **click it**
2. Take a **fresh** snapshot (UIDs changed after drawer opened), find the nav item with text containing "My Projects", **click it**
3. Wait for URL to contain `/library` (use `evaluate_script` to poll `window.location.href`)
4. Take a snapshot via `wait_for` (look for "Eval Test Film"), find the project card, **click it** (use the "Open" button if the card itself isn't clickable)
5. Wait for URL to contain `/editor/`

Verify:
- [ ] NavDrawer opens on hamburger click
- [ ] Navigation to /library works
- [ ] Project card is visible and clickable
- [ ] Editor page loads

### 3. Editor Page

Take a snapshot of the editor. Verify:
- [ ] Project name "Eval Test Film" is displayed (`data-testid="project-name"`)
- [ ] 3 clips listed with correct filenames and durations
- [ ] Render button is visible (`data-testid="btn-render"`)

**Inline name edit test**:
1. Click the project name element
2. Take snapshot -- an input field should appear (`data-testid="input-project-name"`)
3. Use `press_key` to send Escape
4. Take snapshot -- input should disappear, original name restored
- [ ] Inline edit opens on click
- [ ] Escape cancels edit and reverts name

**Music chip test**:
Click each music chip in sequence: Cinematic, Upbeat, Chill, Electronic, then back to No Music. **Critical:** After each click, take a fresh snapshot via `wait_for` before clicking the next chip. UIDs change after every React re-render, so reusing old UIDs will fail. Use `evaluate_script` to verify the active chip's border color (`FF8A65` orange) if the snapshot text doesn't distinguish active vs inactive.
- [ ] Each music chip activates on click (shows orange highlight)
- [ ] Only one chip is active at a time

**Settings input test**:
Select "Cinematic" music for the final render. Then fill the intro and outro card inputs:
1. Click `chip-music-cinematic`
2. Find `input-intro-text` in snapshot, use `fill` to type "Eval Test Film"
3. Find `input-outro-text` in snapshot, use `fill` to type "Made with RushCut"
- [ ] Intro text input accepts text
- [ ] Outro text input accepts text

**Back button test**:
1. Click the Back button (`data-testid="btn-back"`)
2. Wait for URL to contain `/library`
- [ ] Back button navigates to /library

**Return to editor**: Click the project card again to go back to the editor. Re-apply settings (Cinematic music, intro/outro text) since navigation may have reset them.

### 4. Render

1. Take a snapshot, find the Render button (`btn-render`), **click it**
2. Wait for URL to contain `/output/` (timeout: 10s)
- [ ] Render button click triggers navigation to output page

**Progress monitoring** (poll every 10 seconds, timeout 5 minutes):
Use `evaluate_script` to read progress since the elements update frequently:
```javascript
() => {
  const stage = document.querySelector('[data-testid="stage-label"]');
  const pct = document.querySelector('[data-testid="progress-pct"]');
  return {
    stage: stage ? stage.textContent : null,
    pct: pct ? pct.textContent : null
  };
}
```
- [ ] Stage labels appear and change during pipeline (e.g., "Normalising clips...", "Adding transitions...")
- [ ] Progress percentage increments toward 100%

**Completion checks** (after pipeline finishes -- stage/pct elements will disappear):
Take a snapshot and verify:
- [ ] "Your film is ready" text appears
- [ ] Output filename shown, matches pattern `[a-z0-9-]+-[a-f0-9]{8}\.mp4`

Use `evaluate_script` to check video element:
```javascript
() => {
  const v = document.querySelector('[data-testid="video-player"]');
  return v ? { src: v.src, readyState: v.readyState, duration: v.duration,
    videoWidth: v.videoWidth, videoHeight: v.videoHeight, error: v.error?.message } : null;
}
```
- [ ] Video element has src containing "asset.localhost"
- [ ] Video readyState is 4 (fully loaded)
- [ ] No video errors
- [ ] Duration is reasonable (>10s for 3 clips + cards)

**ffprobe the output** (verify codec compliance):
```bash
powershell.exe -Command "wsl -d Ubuntu-24.04 -u root -- ffprobe -v quiet -print_format json -show_streams '<wsl_path_to_output>' 2>&1"
```
- [ ] Video codec is h264, profile Main, pix_fmt yuv420p
- [ ] Resolution is 608x1080 (correct portrait normalisation)
- [ ] Audio stream present (AAC)

### 5. Navigation

1. Take a **fresh** snapshot on the output page (UIDs from the progress-polling phase are stale), find "My Projects" button (`btn-my-projects`), **click it**
2. Wait for URL to contain `/library`
- [ ] My Projects navigation works from output page

Take a snapshot of the library:
- [ ] "Eval Test Film" project shows status "Done"

**NavDrawer test from library**:
1. Click hamburger (`btn-nav-open`)
2. Take snapshot -- verify nav items visible
3. Click hamburger again to close
4. Take snapshot -- verify nav items hidden
- [ ] NavDrawer opens and closes correctly

### 6. Console Check

Use `list_console_messages` with `types: ["error", "warn"]` and `includePreservedMessages: true`.
- [ ] Zero console errors (warnings are OK to note but don't count as failures)

Report any warnings (React Router future flags, etc.) as informational observations.

### 7. Cleanup

Kill the rushcut.exe process after testing:
```bash
powershell.exe -Command "Stop-Process -Name rushcut -Force -ErrorAction SilentlyContinue"
```

## Report Format

After all checks, output a summary table:

```
## RushCut E2E Eval Report

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Choose Folder button visible | PASS | |
| 2 | Add Files button visible | PASS | |
| ... | ... | ... | ... |

### Summary
- **X / Y checks passed**
- **Observations**: (list anything notable -- slow renders, UI glitches, warnings)
- **Potential fixes**: (actionable items for the next batch)
```

If any check FAILs, investigate: take additional snapshots, read console messages, check the Rust logs. Include diagnostic details in the Notes column.

## Test Data

The standard test set uses 3 DJI Osmo Pocket 3 clips in `C:\clips\`:
- DJI_01.MP4 (1.3s, portrait 1728x3072)
- DJI_02.MP4 (10.6s, portrait 1728x3072)
- DJI_03.MP4 (10.9s, portrait 1728x3072)

Output is written to `C:\clips\processed\<slug>-<shortid>.mp4`.

If the clips folder is empty or missing, SKIP the render eval and note it in the report.

## Troubleshooting (from dry runs)

- **"Element with uid X no longer exists"** -- You used a stale UID. Take a fresh snapshot with `wait_for` and get the new UID.
- **Music chips all show same state after clicking** -- You clicked too fast without letting React re-render. Take a fresh snapshot between each chip click.
- **Upload page clips don't appear after scan_folder invoke** -- This is expected. The invoke shortcut bypasses React's state setter. Mark clip display checks as SKIP and proceed to `create_project`.
- **Output page "My Projects" button click fails** -- The progress polling phase invalidated UIDs. Take a fresh snapshot after pipeline completion before clicking anything.
- **NavDrawer items not found in snapshot** -- Make sure you took a NEW snapshot after clicking the hamburger. The drawer opens asynchronously.
- **Audio sample rate shows 96kHz** -- Known issue (backlog item). Not a test failure -- DJI source audio is 96kHz and pipeline doesn't force `-ar 48000` yet.
