# LEARNINGS.md — rushcut

Pattern library. Organised by topic. Add to existing sections — do NOT add dated/batch headers.
Each bullet: problem in ≤1 sentence, fix in ≤2 sentences.

---

## Workflow — preview_* and chrome-devtools MCP both conflict with WDIO on port 9222

**Problem:** Calling any `mcp__chrome-devtools__*` tool OR any `preview_*` MCP tool (including `preview_start`, `preview_screenshot`) starts a Chrome/Edge browser process that squats port 9222 for the lifetime of the Claude Code session. WDIO's `waitForPort(9222)` resolves to this MCP browser instead of the Tauri WebView2 — msedgedriver attaches to the wrong target and `getUrl()` always returns `about:blank`.
**Solution:** Never call `preview_*` or `chrome-devtools` MCP tools during a session that also runs WDIO E2E tests. If already called, kill the Chrome process (`Get-NetTCPConnection -LocalPort 9222 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`) before launching the Tauri binary and running E2E.
**Context:** Any session using `pnpm test:e2e*`. Both MCP tool families are affected — not just chrome-devtools.

---

## Workflow — WebView2 cold-start race with Vite

**Problem:** If the Tauri binary starts before Vite is serving on port 1420, WebView2 navigates to localhost:1420, gets a connection-refused response, shows a chrome-error page, and does NOT retry. The window shows black forever. `wdio.conf.ts`'s `ensureViteRunning()` guards against this for WDIO runs, but manual binary launches are vulnerable.
**Solution:** Always confirm Vite is serving (`curl -s http://localhost:1420/ -o /dev/null`) before launching the binary. Use `pnpm dev` (which sequences Vite first, then cargo run) rather than launching the binary directly when possible.
**Context:** Manual debugging sessions where binary is launched from PowerShell or bash separately from Vite.

---

## Workflow — `preview_start` kills the Tauri HMR connection; Vite-only preview is useless for Tauri UI

**Problem:** `preview_start` on port 1420 kills any already-running Vite dev server (which the Tauri binary's WebView2 is connected to via HMR). After this, the user's open Tauri window loses HMR and never receives source updates. Additionally, the Vite-only preview cannot render Tauri UI pages because all `invoke()` calls fail immediately without the backend — every editor page shows "No clips found" or the loading spinner, making screenshots meaningless.
**Solution:** For UI verification of Tauri screens, use `chrome-devtools` MCP against the running Tauri WebView2 (port 9222) — NOT `preview_*` MCP. Do NOT call `preview_start` if the user has `pnpm dev` already running. HMR alone is sufficient proof of delivery; take screenshots via `mcp__chrome-devtools__take_screenshot` only when the user confirms the Tauri app is open.
**Context:** Any session touching React UI components (`src/**/*.tsx`) with a running Tauri binary. Do not mix `preview_*` and E2E in the same session (port 9222 conflict — already documented above).

---

## Workflow — user always launches the .exe directly; never pnpm dev

**Problem:** `pnpm dev` is NOT how this user runs RushCut. Suggesting it wastes a round trip and breaks trust. The user has an always-on Vite dev server; they launch `C:\apps\rushcut\src-tauri\target\debug\rushcut.exe` directly by double-click. That debug binary connects to the live Vite server on port 1420 and picks up TS/TSX changes via HMR — no rebuild or relaunch needed for React changes.
**Solution:** For React/TS-only changes: HMR picks them up automatically — no action needed, just navigate in the running app. For Rust changes (`src-tauri/**`): rebuild via `cargo build --manifest-path src-tauri\Cargo.toml --config src-tauri\.cargo\config.toml`, then tell the user to kill and re-launch the .exe. Never say "run pnpm dev".
**Context:** Every session. This applies to screenshot verification, build instructions, and any step that involves reloading the app.

---

## Workflow — `Start-Process` in PowerShell does not inherit `$env:` vars reliably

**Problem:** Setting `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "..."` in PowerShell and then using `Start-Process -FilePath rushcut.exe` does not propagate the variable to the child process on Windows PowerShell 5.x. The variable is silently dropped, so WebView2 never enters remote-debugging mode.
**Solution:** Use Node.js `child_process.spawn()` with an explicit `env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "..." }` (as WDIO does), or use `cmd.exe /c "set VAR=val && rushcut.exe"` syntax from a shell that correctly inherits Win32 env blocks. Alternatively, run the WDIO setup which handles this correctly via `wdio.conf.ts` `beforeSession`.
**Context:** Any session that manually launches the Tauri debug binary with CDP remote-debugging flags.

---

## Workflow — use `cargo check` not `cargo build` to verify Rust syntax mid-session

**Problem:** `cargo build` on this project fails with a linker error (`msvcrt.lib not found`) when called from bash/PowerShell without the full VS2019 environment. This triggers a false "compile failure" even when the Rust code is valid.
**Solution:** Use `cargo check` to validate syntax and types — it skips linking entirely and returns in <2s. Only use `cargo build` when you need the actual binary (e.g. before E2E tests).
**Context:** Any session editing `src-tauri/src/lib.rs` or other Rust files.

---

## Workflow — DB cross-check: use invoke() not sqlite3 while app is running

**Problem:** Running `sqlite3 rushcut.db` via WSL while the app holds the DB open in WAL mode returns a stale snapshot — correct file, wrong data. The WAL file has uncommitted/uncheckpointed writes that sqlite3 doesn't see, so project rows appear missing or outdated.
**Solution:** For cross-checks during an active session, call `invoke("list_projects_cmd")` (or another Tauri command) via `mcp__chrome-devtools__evaluate_script` — the app's own connection reads through the WAL and returns current data. Use sqlite3 directly only when the app is NOT running.
**Context:** Any session that needs to verify DB content while the Tauri binary is open. Also note: the app DB is at `%APPDATA%\rushcut\rushcut.db` (from `dirs::data_dir()`) — NOT `%APPDATA%\com.rushcut.app` (that's Tauri's own managed dir, which the DB does not use).

---

## Workflow — In-session binary uses a Claude MSIX container DB, not the user's real Roaming file

**Problem:** When the rushcut debug binary is launched *in-session* (via `Start-Process` from Claude Code's packaged context), Windows MSIX filesystem virtualisation redirects its `%APPDATA%` writes to `C:\Users\Manasak\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\rushcut\rushcut.db` — a separate physical file. `dirs::data_dir()` prints the *logical* Roaming path in logs, but that is a lie on this machine. WSL `/mnt/c/.../Roaming/rushcut/rushcut.db` is the user's real file; the Windows Store `python.exe` alias has its own container too. All three disagree.
**Solution:** To verify DB state against the in-session binary: inject and read using WSL python pointed at the **container path** (`/mnt/c/Users/Manasak/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache\Roaming\rushcut\rushcut.db`), not the real Roaming path. Drop WSL caches before reading (`echo 1 > /proc/sys/vm/drop_caches`) — 9p reads are stale even after the container DB changes. Confirm the right file by temporarily adding `eprintln!("[dbpath] {}", db::db_path().display())` to `setup()` and reading binary stderr.
**Critical addendum — PowerShell `$env:APPDATA` is ALSO virtualised:** Claude's own PowerShell tool runs inside the MSIX container, so `$env:APPDATA` in any PowerShell command resolves to the container's virtual Roaming path (yesterday's timestamp, stale file). It does NOT point to the user's real binary's DB. To cross-check the DB used by the user's own double-clicked binary, always use WSL with the absolute Roaming path: `wsl -- stat /mnt/c/Users/Manasak/AppData/Roaming/rushcut/rushcut.db`. A stat showing today's timestamp confirms the real file; `$env:APPDATA` will show yesterday's.
**Context:** In-session DB verification when the binary is launched via `Start-Process` (i.e. from Claude Code). For the user's own launched binary (normal double-click outside any package), this does NOT apply — the real Roaming file is used, but PowerShell reads are still virtualised and stale.

---

## Workflow — WSL `/mnt/c` SQLite reads are stale; writes land but reads need cache drop

**Problem:** Reading `rushcut.db` via WSL2 `/mnt/c` 9p protocol returns a cached view that does not reflect recent Windows-side writes (or even recent WSL writes visible to Windows). Specifically, a WSL python commit that inserts rows can be immediately visible to the Windows binary but NOT visible to a subsequent WSL python read — leading to false "rows missing" conclusions.
**Solution:** Before any WSL read of a DB that was recently written (by WSL or Windows), drop the 9p page cache: `wsl -u root -- sh -c "echo 1 > /proc/sys/vm/drop_caches"`. For authoritative reads, prefer writing a Python script and running it via `Start-Process` in the same OS context as the binary, rather than via WSL.
**Context:** Any in-session DB verification using WSL python or WSL sqlite3 against a file that was recently opened or written by a Windows process.

---

## React — `useRef` initial value is reset on every component remount

**Problem:** `useRef(initialValue)` is only called once per *component instance*. A route transition that unmounts and remounts a component creates a fresh instance — every `useRef` reverts to its initial value. This silently resets any ref that was updated by effects or event listeners in the previous mount, including timestamps, flags, and accumulated state.
**Solution:** For any ref that represents "last known state of something that continues across navigations" (e.g. last-pipeline-activity timestamp, accumulated scroll offset), seed the correct value inside a `useEffect` that runs shortly after mount — not as the `useRef` initial value. The effect fires after mount and before any polling interval can read the ref, so it always overwrites the stale default before it matters. Do NOT hoist the seed into the `useRef(...)` call or `useState` init, where it captures only the value at mount time (which may itself be stale).
**Context:** `Render.tsx` `lastProgressAtRef` stall detection (U1e). Any component with a ref that tracks "ongoing external state" across navigations — the typical case is a timestamp or index seeded from DB/API data loaded by a `useEffect`.

---

## React — imperative DOM updates for high-frequency media events

**Problem:** React `setState` inside `onTimeUpdate` (fires 4–66 Hz) causes a re-render per tick. For a progress bar fill + elapsed label, this floods the React reconciler every 15–250ms, degrading playback smoothness.
**Solution:** Keep `isFilmPlaying` / `isFilmPaused` as React state for render-gating. Use `useRef<HTMLDivElement>` + `useRef<HTMLSpanElement>` for the fill div and label; update via `ref.current.style.width` and `ref.current.textContent` in the handler. Zero re-renders during playback; React re-renders only on play/pause/stop state transitions.
**Context:** Any media progress bar or elapsed timer updated from `onTimeUpdate`. Pattern confirmed in `Sound.tsx` `handleFilmTimeUpdate`.

---

## React — `onEnded` does not respect `out_ms` trim boundary

**Problem:** `onEnded` fires when the video source file reaches its natural end — NOT at the user's `out_ms` trim point. A clip trimmed to stop at 8s in a 30s source will play to 30s (the source end), not 8s, before `onEnded` fires.
**Solution:** In `onTimeUpdate`, check `if (v.currentTime >= outSec) { advanceClip(); return; }` before any other time-based logic. This is the primary clip-end detector for trimmed clips. `onEnded` is a fallback for untrimmed clips.
**Context:** Any screen with sequential clip playback where clips have `out_ms` trim points. Confirmed in `Sound.tsx` rough-mix playback.

---

## React — double-advance guard for clip boundary race

**Problem:** When a clip ends at its `out_ms` boundary, both `onTimeUpdate` (which detects `v.currentTime >= outSec`) and `onEnded` (which fires at file end when `out_ms === duration_ms`) can both trigger `advanceClip` in the same JS event loop tick, causing double-advance (skips a clip).
**Solution:** Use a ref guard: `const isAdvancingRef = useRef(false)`. At the top of `advanceClip`, check `if (isAdvancingRef.current) return; isAdvancingRef.current = true;`. After loading the new clip, clear it: `setTimeout(() => { isAdvancingRef.current = false; }, 250)`. The 250ms window covers the time between the two events firing.
**Context:** Any sequential clip player where `onTimeUpdate` and `onEnded` both drive clip advance. Confirmed in `Sound.tsx` `advanceFilmClipRough`.

---

## React — per-clip video player must seek to in_ms on loadedmetadata

**Problem:** Loading a raw clip or proxy into a `<video>` element with `video.load()` starts playback from `currentTime=0` (the beginning of the raw file). If the trimmed section starts at `in_ms > 0`, `currentMs` never reaches `in_ms`, so derived film-time formulas (`currentMs - in_ms`) stay negative (clamped to 0) and any playhead or timeline feature appears frozen.
**Solution:** In `handleLoadedMetadata`, after setting `durationMs`, immediately seek: `video.currentTime = inMs / 1000`. Also set `currentMs` to `inMs` so the scrubber initialises at the trim start. In `handleTimeUpdate`, check `ms >= outMs` and stop+clamp there. Set scrubber `min={inMs}` / `max={outMs}`, and display `currentMs - inMs` / `outMs - inMs` for elapsed/total. In `togglePlay`, if `currentTime * 1000 >= outMs`, seek back to `inMs` before calling `play()` to allow replay.
**Context:** Any screen with per-clip video playback that respects `clip.in_ms` / `clip.out_ms` (Arrange zoom tab).

---

## React — conditional render unmounts media elements

**Problem:** `{condition && <video>}` unmounts the `<video>` element when `condition` becomes false, dropping the browser's decoded buffer and seek state. When `condition` becomes true again and a `useEffect` with that condition as a dependency re-fires, `video.load()` is called on a fresh element — causing a full reload stutter even if the source file hasn't changed.
**Solution:** Replace `{condition && <div>...</div>}` with `<div className={condition ? "flex" : "hidden"}>...</div>` (or `display:none`). The element stays in the DOM with its src and `currentTime` intact. Add a loaded-src ref (`loadedSrcRef`) to the `useEffect` and skip `video.load()` when returning to the same clip.
**Context:** Any screen where a `<video>` (or `<audio>`) is inside a conditionally rendered block that gets toggled by tab switches, drawer toggles, or modal state.

---

## React — IIFE in JSX causes stray-closing-tag compile errors

**Problem:** Wrapping JSX in an IIFE (`{(() => { const x = ...; return (<JSX />); })()}`) to define local variables inline is fragile — the surrounding `return` and the JSX opening/closing tags must perfectly balance. A single extra or missing `</div>` inside the outer component produces a cryptic Babel "Adjacent JSX elements must be wrapped" error that points at the wrong line, making root cause non-obvious.
**Solution:** Derive local variables in the component body above `return` (or in a small helper function), then reference them in the render path normally. Only use an IIFE if the variable depends on other JSX-internal context that truly can't be hoisted; if so, isolate it to the smallest possible scope and comment the intent.
**Context:** Any JSX block where you need computed values (derived from state/props) that aren't worth a new component or a `useMemo`. Spotted during Batch M1 transition card-chip implementation.

---

## Tauri — `window.confirm` silently fails without `dialog:allow-confirm`

**Problem:** In a Tauri WebView2, `window.confirm(...)` is internally routed to the `dialog` plugin. Without `"dialog:allow-confirm"` in `capabilities/default.json`, every call is rejected with a console error `"dialog.confirm not allowed"` and the dialog never appears. The confirm call returns `undefined` (falsy), so any gate of the form `if (!window.confirm(...)) return` will silently allow navigation rather than blocking it — the bug is invisible unless you specifically watch the console.
**Solution:** Replace `window.confirm` with `import { confirm } from "@tauri-apps/plugin-dialog"` (async), and add `"dialog:allow-confirm"` to `capabilities/default.json`. Requires a binary rebuild — capability changes in JSON have no effect until the binary is recompiled.
**Context:** `src/components/BottomTabBar.tsx` render-gate confirm. Any component that needs a blocking user choice. The `tauri-plugin-dialog` crate is already a dependency; only the capability entry was missing.

---

## Tauri plugin dialog — CDP cannot verify Win32 modal dialogs

**Problem:** The native `confirm()` from `@tauri-apps/plugin-dialog` shows a Win32 `MessageBox` — a native OS modal outside the WebView2 renderer. CDP tools (`evaluate_script` with `dialogAction`, `handle_dialog`) only intercept JavaScript dialogs (`window.alert/confirm/prompt`). They have no hook into Win32 modals. Additionally, computer-use `request_access` approval dialogs also appear in the same desktop space — if a Win32 modal is already blocking the screen, the `request_access` dialog cannot appear, causing it to time out.
**Solution:** Proof of a working Tauri plugin dialog is necessarily indirect: (1) the JS promise suspends → subsequent evaluate_script executions still run (renderer is alive) but the promise chain is blocked; (2) desktop interaction is blocked (computer-use `request_access` times out while the modal is open); (3) after the user dismisses it, the promise resolves and the correct branch executes (confirm=No → stays on Trimmer; confirm=Yes → navigate fires); (4) no console rejection errors. Together this constitutes strong but indirect proof. Do NOT expect a screenshot of the dialog itself from CDP.
**Context:** Any session verifying dialog-gated navigation in Tauri. The `dialogAction: "accept"` parameter on `evaluate_script` only handles JS dialogs — it has no effect on Win32 modals.

---

## React — localStorage.setItem does not trigger re-render; stale closure captures old value

**Problem:** Setting `localStorage.setItem(key, val)` in `evaluate_script` and then immediately clicking a button uses the React component's *last-rendered* closure over the `useConfiguredTabs` result — the hook re-reads localStorage only on the next render, which hasn't happened yet. Any inline condition in the `onClick` handler that reads from that hook sees the old value.
**Solution:** After setting localStorage from outside React (e.g. CDP `evaluate_script`), trigger a re-render before clicking: either dispatch a `storage` event (`window.dispatchEvent(new StorageEvent("storage", {key}))`) or navigate to the same route to force a remount. For in-session test setups, prefer using `popstate` navigation to force a full remount cycle.
**Context:** Any CDP-driven test that sets localStorage to change displayed state before clicking. Confirmed in `BottomTabBar` `useConfiguredTabs` during U1d verification.

---

## Workflow — Visual eval bail-out when user is absent

**Problem:** `request_access` for computer-use shows a dialog that the user must approve within 5 minutes. If the user isn't at their desk, two consecutive 5-minute timeouts (10 min total) are burned before giving up.
**Solution:** If the first `request_access` times out, do NOT retry immediately. Treat the build compiling cleanly (exit 0) as the validation ceiling for that session; note in the summary that visual eval is deferred and the user should confirm manually. Only retry computer-use if the user explicitly responds that they are present.
**Context:** Any session where the user steps away mid-wrapup. The CDP `list_pages` returning empty is an earlier signal that the user may be absent — check it before calling `request_access`.

---

## React — SessionStorage format migration must update ALL reader sites

**Problem:** When a sessionStorage key's format changes (e.g., plain string → JSON object), pages using a canonical reader utility get the fix automatically, but pages calling `sessionStorage.getItem()` directly still receive the raw serialised value — leaking JSON strings into display contexts.
**Solution:** When changing any sessionStorage key's format, grep for ALL `sessionStorage.getItem` calls for that key across `src/pages/` and `src/components/`. Every reader must go through the canonical utility (`readTransitionConfig()`, etc.) — never raw `sessionStorage.getItem()`.
**Context:** `src/utils/buildJobConfig.ts` owns canonical readers. `Sound.tsx` and `Render.tsx` missed Batch M2's `TransitionConfig` format change and showed raw JSON in ChosenEffects chips until fixed in the post-M2 cleanup session (2026-05-20).

---

## React — Clip-ID ref guard vs. URL ref guard for same-source cuts

**Problem:** Using `if (url === loadedSrcRef.current) return` to prevent redundant video reloads fails when two clips share the same source file URL. Switching from Cut A to Cut B (same `proxy_path`, different `in_ms`/`out_ms`) triggers the guard and skips the seek — Cut B's player shows Cut A's position.
**Solution:** Guard on clip ID instead: `if (selectedClip.id === loadedClipIdRef.current) return`. IDs are always unique even for multiple cuts from the same source, yet the "return to same tab" optimisation still works because the ID also matches in that case.
**Context:** Arrange.tsx zoom tab + sound tab `useEffect` video load guards. Fixed 2026-05-20.

---

## React — Playback index vs clip ID (filmPlayIdx class of bugs)

**Problem:** Using an integer index (`filmPlayIdx`) into a reorderable array to track the currently-playing clip causes the playhead to shift to a different clip after any reorder — the index stays fixed while the array positions change.
**Solution:** After any mutation that reorders the inFilm array, update the index by finding the playing clip by ID in the new order: capture `currentlyPlayingId = inFilm[filmPlayIdx]?.id` before the mutation, compute `newIdx = newInFilm.findIndex(c => c.id === currentlyPlayingId)`, then set both `setFilmPlayIdx(newIdx)` AND `filmPlayIdxRef.current = newIdx` (the ref is read by real-time callbacks). Long-term: replace the integer with a `filmPlayClipId: string` (derive index via `findIndex` at render time, like Arrange uses `selectedClipId`). The delete-while-playing path has the same gap: after removing a clip, clamp `filmPlayIdx` to `min(filmPlayIdx, newInFilm.length - 1)`.
**Context:** `Trimmer.tsx` `filmPlayIdx` + `filmPlayIdxRef.current`. Fixed in `handleReorder` (Batch U2). `handleDeleteCut` still has the pre-existing gap.

---

## Workflow — CDP synthetic drag unreliable in film mode

**Problem:** Simulating a dnd-kit drag via CDP `pointerdown/pointermove/pointerup` on a StickyFilmStrip tile in film mode also triggers `crossSeekToClip` (the tile click handler fires during the drag sequence), which advances the film playhead mid-drag. The film then auto-advances, making the drag result indeterminate.
**Solution:** For dnd-kit drag verification on the filmstrip, use a programmatic Tauri invoke (`reorder_clips_cmd`) followed by a `get_project` assertion to confirm `sort_order` changed — not synthetic pointer events. CDP synthetic drag is reliable only when no competing pointer-event handlers exist on the draggable element.
**Context:** `StickyFilmStrip.tsx` tiles in Trimmer film mode. Applies to any E2E or CDP test of drag-to-reorder on that component.

---

## Workflow — Worktree sessions

- **Edits in a worktree are NOT visible to the running app** — `pnpm dev` launched from `C:\apps\rushcut` reads the main branch, not the worktree at `C:\apps\rushcut\.claude\worktrees\<name>`. Any fix applied only in the worktree appears to have no effect when the user tests. Always apply fixes to the main-branch files (`C:\apps\rushcut\src\...`) when the goal is immediate user-visible verification, or merge the worktree branch first.

---

## FFmpeg — filter_complex output label syntax

- **Output labels must appear directly after the filter with no preceding comma** — `afade=t=out:st=X:d=Y[mus]` is correct; `afade=t=out:st=X:d=Y,[mus]` (comma before the label) causes FFmpeg to parse `[mus]` as an input to a non-existent next filter and fail. Trailing commas in Python f-string filter fragments are the usual culprit — always move the comma to the START of optional filter fragments: `fade = f",afade=..." if enabled else ""`, then append `f"volume=0.4{fade}[mus]"` so the label abuts the last real filter regardless of which branch is taken.

---

## FFmpeg — filter_complex

- **Mixed portrait+landscape requires fixed-canvas pre-scale before concat/xfade** — `scale=-2:{h}` appended after concat/xfade produces streams of different widths (e.g. 1920px landscape vs 540px portrait); FFmpeg aborts with exit 234. Fix: pre-scale every input stream to an exact canvas with named labels `[sv0]`, `[sv1]`... before any concat or xfade reference: `[{i}:v]scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2[sv{i}]`. Both the `"none"` (concat) path and xfade path must be updated — missing one path means the crash survives for certain transition settings.
- **xfade transition name is `fade` not `crossfade`** — `crossfade` raises "Not yet implemented in FFmpeg". Use `xfade=transition=fade`. For dip-to-black use `xfade=transition=fadeblack` (native, no custom logic needed).
- **`scale` must be inside `-filter_complex`** — using `-vf` alongside `-filter_complex` on the same output stream raises "Simple and complex filtering cannot be used together". Append scale as the final step inside the filter chain.
- **Get durations from trimmed paths, not normalised paths** — xfade offset formula uses per-clip duration; if trim runs before transitions, re-run `get_duration()` on the trimmed files or offsets will be silently wrong.
- **Pairwise `acrossfade` chaining for 3+ clips requires `apad=whole_dur` first** — WITHOUT apad, chained acrossfade misaligns because each clip's audio is 64-120ms shorter than its video duration, causing crossfade start points to drift off the xfade offsets. WITH `apad=whole_dur=durations[i]` per clip, audio duration matches video exactly, so chained acrossfade produces perfect alignment for all N. Using `concat` for 3+ clips instead causes audio to lag 1.5s behind video from the second cut onward (hard-cut at t=sum(durations[:2]) while video xfade ends at t=sum(durations[:2])-xfade_dur).
- **xfade offset formula** (port verbatim from spike): `offset = cumulative + duration[i-1] - xfade_dur * i`
- **xfade_dur must be clamped to half the shortest clip duration** — a 1.5s xfade consumes a 1s clip entirely (both the preceding xfade and the next one eat the same clip). Clamp: `effective_dur = min(xfade_dur, min(durations) / 2.0)` before building the filter chain. Log a warning if clamping occurs.

## FFmpeg — codec / output

- **Proxy reuse as normalise input (Batch C candidate)** — after B-0 + parallel normalise, the remaining 80s normalise bottleneck is 4K HEVC software decode (hardware accel not viable — `/dev/dxg` present, `VK_KHR_video_decode_queue` not supported). The Trimmer already generates H.264 1080p proxies per clip. If render.py uses those proxies as normalise input instead of raw 4K HEVC, it reads H.264 (fast decode, ~5× faster than HEVC software) and skips the HEVC decode entirely. Estimated normalise: 80s → ~20-30s with no parallelism. Spec: proxy must match normalise output exactly (`-c:v libx264 -pix_fmt yuv420p -profile:v main -preset ultrafast -ar 48000 -r 25 -fps_mode cfr`). If proxy resolution is 480p (current), render.py scale step still upscales — acceptable for 1080p output. Flag as Batch C candidate once B is shipped.
- **Concurrent FFmpeg in WSL2 causes contention** — proxy generation fired immediately at project create ran concurrently with the render pipeline (normalise + render), adding ~90s to a 5-min render. Fix: fire proxy generation only after `pipeline-done`. Never start a WSL2 FFmpeg background task while a render is in progress.
- **WSL2 HEVC normalise: I/O-bound from NTFS, CPU-bound from tmpfs** — the original warning (ProcessPoolExecutor slows things down) applied when normalise read full 4K source clips from NTFS. After the B-0 pre-trim step copies only the needed segment to WSL2 `/tmp` (tmpfs = RAM), normalise reads from RAM and becomes CPU-bound (HEVC software decode). At that point `ThreadPoolExecutor(max_workers=4)` IS effective: sequential 160s → parallel 80s for 10 clips. Cap threads per worker with `-threads N` (global FFmpeg flag before `-i`) to avoid over-subscription: `threads_per_worker = max(1, os.cpu_count() // max_workers)`. NOTE: the global `-threads` flag in FFmpeg does not reliably cap libx264's internal thread pool — libx264 manages its own threads independently. Measured effect on this machine (16 CPUs, 4 workers, `-threads 4`): no further improvement beyond the 2× already gained from the 4-worker pool.
- **B-0 pre-trim before normalise: biggest single render speedup** — normalise.py processes whatever files it receives. If full 4K source clips (1–5 min) are passed, it wastes 4–10× time normalising footage the user trimmed away. Fix: before calling `normalise()`, FFmpeg copy-trim each clip to `[in_s - 2s, out_s + 0.5s]` using `-ss before -i -c copy` (fast, ~1-3s per clip). Adjust `in_ms`/`out_ms` in the pipeline_clips dict to be relative to the pre-trimmed file's timeline. Result: 10 min normalise → 3 min total pipeline for a 1m26s DJI 4K film (10 clips). The 2s pre-roll ensures keyframe alignment so the copy trim doesn't cut mid-GOP.
- **Use `-preset ultrafast` for normalised intermediates** — normalise.py produces temp files that are re-encoded again by the xfade/concat render step. Using `-preset fast` for these intermediates wastes 3–4× CPU on motion estimation for files that will be re-encoded anyway. `ultrafast` produces the same final output quality at ~3–4× lower normalise time (confirmed: ~3 min → ~60–90s on 3×4K clips). Always use `ultrafast` for intermediate normalise; `fast`/`medium` is only meaningful for the final render output.
- **Always specify `-c:v libx264 -pix_fmt yuv420p -profile:v main`** — omitting `-c:v` after `-filter_complex` can silently fall back to HEVC, which Windows Photos/Media Player rejects with error 0x80004005.
- **Single-clip shortcut**: use simple `-vf "scale=-2:360"` without `-filter_complex` — avoids needless complexity and the constraint that scale can't be in both `-vf` and `-filter_complex`.
- **`-map 0:a:0?` not `-map 0:a?`** — DJI clips can contain multiple audio streams; `0:a?` maps all of them. Always use the indexed form when normalising DJI footage.
- **Force `-ar 48000` at every re-encode site** — DJI Osmo Pocket 3 records at 96kHz; some players (including certain mobile decoders) reject non-48kHz AAC. Add `-ar 48000` to every FFmpeg call that re-encodes audio: normalise, inject_silence, single-clip render, multi-clip render, music mix, loudnorm. One missed site means the final output inherits 96kHz from the concat stream.
- **Multi-clip render path needs explicit audio codec args** — the filter_complex concat output has no implicit codec; omitting `-c:a aac -b:a 128k -ar 48000` causes FFmpeg to auto-select, inheriting the source sample rate. Always include audio codec args on every FFmpeg output regardless of path taken.
- **Single-pass loudnorm LUFS accuracy: real bar is +-2.0 on acrossfade content** — two-pass loudnorm (linear=true) hits -14 LUFS within +-0.3 LU on any content. Single-pass (dynamic mode, fused into the encode) hits -14 +-0.5 on single-clip and music-on paths, but lands ~-15.7 (1.7 LU low) on multi-clip acrossfade chains where the dynamic compressor undershoots on level transitions. This is inherent to single-pass; it is not distortion, just quieter. Accepted bar for consumer output: +-2.0 LUFS (i.e. -12 to -16). If precise loudness is required (broadcast or streaming platform delivery), revert to two-pass or add a volumedetect correction pass.

## DJI OsmoPocket3

- **Dual video streams** — FFmpeg/ffprobe reports two video streams per file. Stream 0 is HEVC (real clip); stream 1 is an embedded MJPEG thumbnail. Use `-map 0:v:0` or `-select_streams v:0` to pin to the real stream.
- **Source format**: HEVC Main 10 (`yuv420p10le`), portrait (1728×3072), 29.97fps. Normalise to H.264 `yuv420p` 25fps CFR before any filter operations.
- **ffprobe `r_frame_rate`** returns a fraction string (`"30000/1001"`) — must split on `/` and divide; never a decimal float.
- **Silence detection**: DJI clips have lots of near-silent sections (camera handling noise). Threshold `-30dB` with `d=0.5` works; may need tuning per footage type.

## SQLite — ISO 8601 T-separator breaks datetime() comparisons

**Problem:** `created_at` timestamps stored via Rust `chrono::Utc::now().to_rfc3339()` are ISO 8601 format (`"2026-06-06T20:12:11Z"`, T separator and Z suffix). SQLite's `datetime('now', ...)` function returns space-separated format (`"2026-06-06 20:12:11"`, no Z). A raw `created_at < datetime('now', '-900 seconds')` string comparison always fails for ISO 8601 values because ASCII `T` (84) > ` ` (32) — so every stored timestamp appears "greater than" the threshold regardless of age.
**Solution:** Wrap the column in `datetime()` to normalise before comparison: `datetime(created_at) < datetime('now', '-900 seconds')`. SQLite's `datetime()` accepts ISO 8601 input (formats 5–7 in the spec, including T separator and Z/UTC suffix) and normalises to space-separated output, making both sides comparable. This applies to every SQL query that compares a chrono-written timestamp against a SQLite `datetime()` expression — audit any `WHERE created_at <` / `>` clause that was written before this was discovered.
**Context:** `src-tauri/src/db.rs` — confirmed in `get_stuck_processing_jobs()` (U1c) and the 60-min backstop `UPDATE` in `list_projects()`. Both were silently non-functional; the self-heal never fired until the fix. Detectable only via live test — `cargo check` and WDIO fast suite cannot catch this.

---

## Pipeline Python — manifest numeric field falsiness trap

**Problem:** `float(d.get("clip_volume", 1.0) or 1.0)` coerces Python's falsy `0.0` (muted clip) to `1.0` (full volume) because `0.0 or 1.0 == 1.0`. The mute feature appeared non-functional despite DB, manifest, and Rust all being correct — the bug was purely in how `render.py` consumed the manifest value.
**Solution:** For any numeric manifest field where `0` / `0.0` is a valid non-default, use an explicit None check: `float(v) if v is not None else default`. One pattern that avoids the trap in a list comprehension: `for cm in clips for v in (cm.get("clip_volume"),)`. The outer loop captures the lookup once; `if v is not None` correctly distinguishes "absent key (use default)" from "present but zero (use zero)".
**Context:** `pipeline/render.py` `clip_volumes` list (line ~588) and `volume_custom` ANALYSIS flag. Applies to any pipeline manifest read where zero is semantically meaningful: volume, start offsets, crop ratios, card opacity.

---

## FFmpeg — `aevalsrc` sample-rate option renamed `r=` → `s=` in FFmpeg 6.1.1

**Problem:** `aevalsrc=0:c=stereo:d=5.0:r=48000` raises `Error applying option 'r' to filter 'aevalsrc': Option not found` (exit 8) under FFmpeg 6.1.1 (the version installed via `apt-get` on Ubuntu 24.04). Earlier FFmpeg versions accepted `r=` as the sample-rate param; 6.1.1 renamed it to `s=`.
**Solution:** Use `s=48000` (not `r=48000`) in all `aevalsrc` filter strings. Grep `pipeline/` for `aevalsrc` before any mute/silence-injection work — there are 3 occurrences in `transitions.py` `build_audio_only_fc()`. The `inject_silence` commands elsewhere already used `s=` correctly; only `build_audio_only_fc` had the old name.
**Context:** `pipeline/transitions.py` — any `aevalsrc` filter used to generate silence for muted clips or boundary segments in the U1g segmented audio pass. Also affects the monolithic fallback path if silence generation is ever triggered there.

---

## FFmpeg — music looping

- **`asetpts=PTS-STARTPTS` must come before `atrim` when using `-stream_loop -1`** — with infinite loop, FFmpeg assigns continuously rising PTS values across loop boundaries. If `atrim=0:{duration}` runs first it sees inflated timestamps and may cut too early. Always reset timestamps first: `[1:a]asetpts=PTS-STARTPTS,atrim=0:{duration:.4f},...`. Wrong order produces silent music gaps at the expected trim point.
- **Do NOT use `-af apad` in normalise.py** — `apad` without an explicit `whole_dur` in a DJI HEVC normalise command causes normalise to hang indefinitely (10+ min, never completes). Root cause: DJI HEVC containers have unreliable or N/A duration headers; `-fps_mode cfr` + `apad` together cause FFmpeg to keep encoding frames past the real EOF waiting for the audio to close, which never happens. The correct fix for the audio/video duration mismatch (64–120ms per clip) is to apply `apad=whole_dur={video_dur}` per clip inside the filter_complex at the render/concat step — where the exact video duration is already known from `get_duration()`.
- **`aresample=async=N` worsens monotonic drift from CFR resampling** — `async` mode compensates drift by inserting/dropping audio samples. DJI HEVC decoded to 25fps CFR produces *monotonic* drift (same direction every clip); `async` fights it by inserting samples, creating audible pops/jumps rather than smooth drift. Do not use `aresample=async` for this class of drift. The correct fix requires reading `[sync-check]` log output to identify where drift enters (normalise → concat → music), then correcting timestamps at that specific step.
- **`volumedetect` mean_volume is unreliable on DJI wind-noise footage** — DJI clips with wind noise register mean_volume of -14 to -16 dBFS. Using this as a relative anchor (e.g. `clip_mean + offset_db`) pushes music to -26 to -28 dBFS at "balanced" preset — effectively inaudible. Use `loudnorm` integrated LUFS instead, or clamp the measured mean to a floor (e.g. -20 dBFS) before computing the offset.
- **`crop` filter has NO `eval` option in FFmpeg 6.1.1** — adding `:eval=frame` to a `crop` filter raises `Error applying option 'eval' to filter 'crop': Option not found`. Only the `scale` filter requires `eval=frame` for time-varying dimensions. The `crop` filter's `x` and `y` expressions re-evaluate every frame natively without any flag — pass the time-varying expressions as the x/y arguments directly.

## Workflow — WSL inline commands: use script files not nested quoting

**Problem:** Passing complex bash commands through PowerShell → WSL → bash requires three layers of quoting. Variables, semicolons, and tee/pipe operators all have characters that get swallowed or mis-escaped by each shell layer, causing silent failures or syntax errors that are very hard to diagnose.
**Solution:** Write the command to a `.sh` file in a Windows temp path (e.g. `/mnt/c/Users/Manasak/AppData/Local/Temp/`), then invoke `wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/.../script.sh`. The script file avoids all quoting layers entirely. Use this pattern for any WSL command beyond a simple one-liner.
**Context:** Any session running multi-step FFmpeg pipelines or Python scripts via WSL from PowerShell.

---

## React — Library jobsMap staleness when render starts mid-session

**Problem:** `Library.tsx` builds its `jobsMap` (projectId → Job) from `list_projects_cmd` on mount; subsequent `pipeline-progress` events are resolved via `findProject(jobId)`. If a new render starts AFTER Library has already done its initial prefetch, the new job's ID isn't in `jobsMap` and all its progress events are silently ignored.
**Solution (T6 — FIXED):** Emit a `job-started` event from Rust `start_job` immediately after `insert_job` succeeds (`app.emit("job-started", json!({ "jobId": job_id, "projectId": project_id }))`). Library's mount-once listener fetches the new job via `get_job_cmd` and inserts it keyed by `projectId`. `jobsRef` (the mirror effect) then resolves all subsequent progress events correctly.
**Context:** `src-tauri/src/lib.rs` `start_job` (emit point: after `insert_job`, before `spawn`). `src/pages/Library.tsx` — `job-started` listener wired into the existing mount-once `useEffect` alongside `pipeline-progress/done/error` listeners.

---

## Proxy — proxy_status stuck at 'encoding' after binary kill

**Problem:** `encode_one_clip` calls `claim_clip_for_encoding` which sets `proxy_status='encoding'` via an atomic DB CAS before starting FFmpeg. If the binary is killed mid-encode (WDIO `afterSession`, force-kill, Windows crash), the `proxy_status` stays `'encoding'` in the DB. On the next launch, `claim_clip_for_encoding` returns `false` (already claimed) → `reason=encoding-in-progress` skip → those clips never get proxies → the Render screen "preparing" spinner hangs forever.
**Solution:** `reset_stale_encoding_claims(project_id)` in `db.rs` (line ~408) already clears all `proxy_status='encoding'` rows for a project. It is called in `generate_proxies_cmd` only on the FIRST batch for a project (when the concurrency `HashSet` is empty for the fresh binary). So after any clean restart the stale state is automatically cleared on the next proxy invocation. If clips appear permanently stuck in a running session (same binary), check for a concurrent low-priority batch that legitimately holds the claim — the boost guard should prevent duplicate claims but inspect `proxy-bg.log` for `batch-start/done` pairs first.
**Context:** `src-tauri/src/lib.rs` `run_bg_proxy_batch` / `encode_one_clip`. Most commonly triggered by WDIO test runs that kill the binary mid-proxy-encode. Symptom: `proxy-bg.log` shows repeated `skip clip_id=X reason=encoding-in-progress` across multiple batches for the same project.

---

## E2E — waitUntil done-condition must match current UI copy, not old copy

**Problem:** `render.spec.ts` "progress bar increments and pipeline completes" had a `waitUntil` that checked `h1.getText() === "Your film is ready"` (T4 copy). T5 changed the heading to `"Your film"`. The condition never triggered; the spec waited the full 9-minute timeout, then the subsequent done-state assertions passed anyway (because the render had long since completed). Result: 13/14 — all real pipeline tests green but the suite reported 1 failing.
**Solution:** When a heading or copy string is changed in the UI, grep `e2e/` for that exact string and update every `waitUntil` / `expect(...).toBe(...)` that references it. The done-state `waitUntil` in render.spec.ts now checks `=== "Your film"`. Note: assertions that come *after* the `waitUntil` in the same test may still pass even when `waitUntil` times out — this masks the failure in the summary count until the timeout is hit.
**Context:** `e2e/render.spec.ts` line ~185. Any spec that polls for a UI state change using `waitUntil` with a heading or label string.

---

## React/CSS — Animate a wrapper div, not the video element itself (WebView2)

**Problem:** Applying a CSS `transform: scale()` animation directly to a `<video>` element in WebView2 causes choppy playback — the video decoder and the CSS compositor compete for the same GPU layer, producing frame drops or stutter at 4K.
**Solution:** Wrap the `<video>` in a `<div ref={wrapRef} className="absolute inset-0 will-change-transform">`. Apply the CSS animation (and `transform-origin`) to the wrapper div imperatively; leave the `<video>` element completely unstyled. The video decoder gets its own layer; the scale animation composites cleanly on top.
**Context:** Any CSS animation on `<video>` in Arrange.tsx or future screens that scale/transform clips in the editor preview. Confirmed fix in the gradual zoom batch (2026-05-21).

---

## Lambda pipeline

- **Cards as pre-rendered video segments** — render intro/end cards as short H.264 clips before filter_complex. Avoids mixing lavfi sources with real clips inside a single filter_complex; cards pass through xfade unchanged.
- **Loudnorm timeout guard** — two-pass loudnorm adds ~2–4x real-time. Add `LAMBDA_TIMEOUT_BUFFER_S` env var (default 30s); check `context.get_remaining_time_in_millis()` before running and skip with WARNING if insufficient.
- **`run_local()` safe defaults** — synthetic job dicts must default all boolean config flags to `False` explicitly. Missing keys cause KeyError deep in the pipeline, not at the entry point.
- **Supabase REST from Lambda via `requests`** — use raw REST API with service role key (`apikey` + `Authorization: Bearer` headers); skip supabase-py. PATCH requires `Prefer: return=minimal` header.

## Workflow — WSL sqlite3 reads stale NTFS data; use invoke() for live DB debugging

**Problem:** Reading `%APPDATA%\rushcut\rushcut.db` via `wsl sqlite3` can show data that is one or more writes behind the live Tauri app. The WSL filesystem cache for NTFS-backed files does not flush on every write, so a query run immediately after a Tauri session may return rows from a previous session or omit recently-inserted rows entirely.
**Solution:** Use `invoke("list_projects_cmd")` or `invoke("get_project", ...)` from the running Tauri app (via `mcp__chrome-devtools__evaluate_script`) to inspect live DB state. Only fall back to WSL sqlite3 when the app itself is not running.
**Context:** Any debugging session that checks DB state after a render or project creation — especially when troubleshooting "project not found" or missing proxy_status rows.

---

## Pipeline — Zoom cache keys are resolution-specific (1080p entries don't satisfy 4K)

**Problem:** The zoom cache sha1 key includes `output_resolution`. A full set of 1080p zoom cache hits produces 0 hits on the next 4K render of the same project, because the cache files differ. This means a "warm cache" verification done at 1080p does NOT confirm 4K warm-cache behaviour.
**Solution:** When testing zoom cache persistence or warm-cache timing, always render at the SAME resolution used to populate the cache. For cross-resolution coverage, do two consecutive renders: once to populate at target resolution, once to verify hits. The `zoom_cache_hits` ANALYSIS field will confirm hits.
**Context:** `pipeline/render.py` `_zoom_cache_key()`, any session verifying Batch P/R zoom cache. Cold 4K zoom (8 clips, ~11s avg trim, 29.97fps DJI source) takes ~54s; 1080p cold zoom on longer clips (346s film) took 177s — both parallelised across 4 workers.

---

## Workflow — Diagnosing pipeline failures: check WSL /tmp state first

**Problem:** A render returns "Pipeline exited with status: exit code: 15" or similar non-zero exit. Reading `pipeline-latest.log` shows a half-complete run that ends mid-stage with no ERROR line.
**Solution:** Exit code 15 = SIGTERM — WSL2 killed the process (restart, memory pressure, or a concurrent heavy render that stressed WSL). Before assuming a code bug: (1) check `wsl -d Ubuntu-24.04 -u root -- ls /tmp/` to see if the job's temp dir exists (if not, WSL restarted and cleared `/tmp`); (2) check if another long FFmpeg process was running concurrently (background proxy gen, perftest). If `/tmp/<job_id>/` is gone, the render was killed by WSL, not by a code error. Re-run once WSL is stable.
**Context:** Any render failure with no ERROR line in the log and a numeric signal exit code (15 = SIGTERM, 9 = SIGKILL). The background perftest task running concurrently is a common trigger.

---

## WSL2 — Default 8GB memory limit kills 4K xfade encode

**Problem:** WSL2 defaults to `min(50% RAM, 8GB)`. A 4K 8-clip xfade encode (FFmpeg buffers multiple 3840×2160 frames simultaneously) combined with a concurrent background proxy AMF encode on Windows can push WSL over the 8GB limit — the pipeline process receives SIGTERM (exit code 15) mid-encode with no FFmpeg error output.
**Solution:** Create `%USERPROFILE%\.wslconfig` with `[wsl2]\nmemory=12GB\nprocessors=8` and run `wsl --shutdown` to apply. On a 16GB machine this leaves 4GB for Windows while giving WSL enough headroom for the pipeline. Confirmed fix: 4K 8-clip shuffle+xfade render completed in ~3 min on the same clips that previously crashed. For very large projects (>4 clips, U1g activated), the segmented render splits into batches of ≤4 clips — actual peak per batch: ~6–9.7 GB for 4K libx264 medium preset with 4 decoders + xfade buffers (higher than the ~2.5 GB theoretical estimate). BATCH_SIZE=4 is the confirmed safe ceiling at 12 GB WSL limit.
**Context:** Any machine with ≤16GB RAM running 4K renders with xfade transitions. File lives at `C:\Users\Manasak\.wslconfig`. Only needed once per machine — survives app updates.

---

## Proxy — Duplicate normal-priority boost causes 3× slowdown on AMF

**Problem:** The Render screen's `useEffect` can fire `generate_proxies_cmd` twice in rapid succession (React strict-mode double-invoke or re-render during readiness polling). Both calls find the concurrency guard already occupied by the low-priority Upload batch and both take the "boost is allowed" path. Result: 3 concurrent AMF encode sessions (low-prio + boost #1 + boost #2). AMD AMF supports 2 sessions before contention; the third causes all three to slow to 3–5× normal speed. A 165s expected proxy wait becomes 600s+ (e.g. 48-second clip takes 234s, 90-second clip takes 303s).
**Solution:** Track a separate `{project_id}:normal` key in the concurrency state set. Before allowing a normal-priority boost, check `set.contains(&boost_key)` — if already present, skip the duplicate. Remove `boost_key` alongside `project_id` when the batch completes. Fixed in `generate_proxies_cmd` in `src-tauri/src/lib.rs`.
**Context:** `generate_proxies_cmd` in Rust. Symptom: proxy-bg.log shows two identical `batch-start` lines at the same timestamp with `low_priority=false`. If you see this, confirm the boost_key guard is in the concurrency block.

---

## Python / tooling

- **`FFMPEG_BIN`/`FFPROBE_BIN` env vars** — hardcoding `/usr/local/bin/ffmpeg` blocks local testing without Docker. Read from env vars with Lambda-path as default; also makes CI flexible.
- **Windows console encoding** — `print()` on cp1252 chokes on `→`, `✅`, `❌`. Use `->`, `[PASS]`, `[FAIL]`.
- **WSL path mangling in Git Bash** — Git Bash rewrites paths starting with `/mnt/c/` to Windows paths when passed to `wsl`. Always invoke `wsl` commands from PowerShell; in Git Bash use `//mnt/c/` prefix as a workaround. **Claude Code's Bash tool runs in Git Bash** — every WSL call must be wrapped as `powershell.exe -Command "wsl -d Ubuntu-24.04 -u root -- ..."`. Glob wildcard patterns in PowerShell args also get expanded by Git Bash; use `cmd.exe /c tasklist ...` for process lookups. **Prefer the dedicated PowerShell tool** (`PowerShell` tool, not `Bash` + `powershell.exe -Command`) for any PowerShell code containing `$variables`, `|` pipes, or multi-line logic — Git Bash mangles both `$` (treats as shell variable) and bare `|` characters inside the `-Command` string, causing silent failures that require retries.
- **PowerShell `Out-File` writes UTF-8 BOM** — Python's `json.loads()` raises `JSONDecodeError: Unexpected UTF-8 BOM` on any file written by PowerShell's `Out-File`. Write JSON files destined for Python via WSL (`cat > file` or `python3 -c "... write_text(...)"`) or use `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))`. For test/debug manifests the cleanest pattern is: write via Python in WSL using `pathlib.Path(...).write_text(json.dumps(data))` — no escaping issues, no BOM, no Unicode escape errors with Windows paths (use raw strings: `r'C:\clips\...'`).
- **`bash -c 'pattern|pipe'` via PowerShell `-Command` mangles pipes** — `powershell.exe -Command "wsl -- bash -c 'grep -E \"foo|bar\" file'"` causes PowerShell to parse `|bar` as a PowerShell pipeline before the string reaches bash. Result: grep sees only `foo` and then tries to run `bar` as a command. Fix: use `python3 -c "import subprocess; r = subprocess.run(['grep', '-E', 'foo|bar', ...])"` inside WSL, or pass the grep pattern as a separate quoted arg without pipes if possible.
- **Concurrent `run.py` processes corrupt a shared `pipeline-latest.log`** — opening the same log file with `mode="w"` in two processes: the second process truncates the file but retains the old file offset, producing a sparse file with null-byte gaps and interleaved output from both jobs. Fix: each job writes to a per-job file (`pipeline-{job_id}.log`); `pipeline-latest.log` is a symlink (`Path.unlink(missing_ok=True)` + `Path.symlink_to(f"pipeline-{job_id}.log")`) updated atomically to the most recently started job.
- **`run.py` config dict must include every field that `render.py` reads** — `run.py` builds the config dict from manifest settings and passes it to `render.py`. Any field not explicitly added here silently defaults to `""` / `False` / `0` when `render.py` calls `config.get("field", default)`. Pattern: when adding a new `JobConfig` field, check all three of: `buildJobConfig.ts` (reads sessionStorage), `run.py` (reads manifest, builds config dict), and `render.py` (reads config). Missing `run.py` is the most common silent failure — the UI sends the value in the manifest but the pipeline never sees it.
- **Pipeline package relative imports** — If `pipeline/*.py` modules use `from .module import ...`, the entry script (`run.py`) must add the *parent* directory of `pipeline/` to `sys.path`, then import as `from pipeline.render import run_pipeline`. Inserting `pipeline/` itself breaks all relative imports: Python treats `render` as a top-level module without a parent package.
- **`subprocess.run(cmd, check=True)` with list args** handles paths with spaces correctly; no `shell=True` needed.
- **WSL2 `/tmp/<job_id>/` accumulates 1-3 GB per render** — `render.py` creates `TMP_BASE / job_id` for normalised intermediates; they persist until WSL2 shuts down if not explicitly deleted. Fix: `shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)` in `run.py` immediately after `shutil.copy2` succeeds. Wrapup cleans crash orphans via `wsl -- sh -c 'rm -rf /tmp/*/'`. Proxies in `%APPDATA%\rushcut\proxies\` are a persistent cache — do NOT clean those.

## Dual-buffer A/B slot engine — `stopFilmPlayback` must NOT hide slots

**Problem:** Calling `setSlotVisible("none")` inside `stopFilmPlayback` (or any natural-end handler) hides both video slots, turning the video area black after the film ends. The user expects to see the last frame frozen.
**Solution:** Do NOT call `setSlotVisible` in the stop/end path. Leave the active slot at opacity 1. Only reset `activeFilmSlotRef` and `slotGenRef` inside `startFilmPlayback` — the subsequent `loadIntoSlot` hides the slot before loading anyway. This preserves the last frame as a static poster until play is pressed again.
**Context:** `src/pages/Sound.tsx` and any future port of the dual-buffer engine (`gateFrameRevealThen` + A/B slots). The stop function should only pause both elements and reset playback-position refs; visibility management belongs in start/advance/cross-seek paths only.

---

## WebView2 — GPU compositor presents frame 0 first; rVFC `metadata.mediaTime` is the only reliable gate

**Problem:** After a video `src` change + `load()` + seek, WebView2's GPU compositor presents frame 0 as the first composited frame before the seek-target keyframe is decoded. Neither `seeked` nor `v.play().then(...)` (Option F) nor a bare rVFC callback (Option C) reliably guards against this — they all fire before the seek-target frame is compositor-committed. Option F specifically: `.play().then()` resolves when audio starts, not when video frame is presented; `.pause()` then freezes at frame 0; reveal shows frame 0.
**Solution (FIXED — Option H):** Use `requestVideoFrameCallback` with `metadata.mediaTime` inspection: only reveal when `metadata.mediaTime >= targetSec - 0.05`. Frame-0 leaks have `mediaTime ≈ 0` and are silently skipped; re-register rVFC for the next frame. Cap at `MAX_WAITS=30` (~500ms) to prevent infinite loops. For cross-clip seeks, load the new clip into the **opposite** (non-active) slot — the active slot keeps showing the outgoing frame while the new clip loads; swap visibility only when `metadata.mediaTime` passes the gate. This mirrors the proven `advanceFilmClip` pattern. See `gateFrameRevealThen()` + `crossSeekToClip()` in `src/pages/Trimmer.tsx`.
**Context:** `src/pages/Trimmer.tsx` film mode. Affects cross-clip seeks triggered by `seekFilmTo`. Same-clip seeks and initial film load (`loadIntoSlot`) use the same `gateFrameRevealThen` helper. `rVFC` confirmed supported in WebView2 (Edg/148): `typeof v.requestVideoFrameCallback === 'function'` → true.

---

## WebView2 — msedgedriver version must exactly match Edge version

**Problem:** After Edge/WebView2 auto-updates, the msedgedriver binary in the project becomes mismatched ("This version of Microsoft Edge WebDriver only supports Microsoft Edge version 146, Current browser version is 148") and all WDIO E2E specs fail immediately with a session creation error — no specs run, all show as FAILED.
**Solution:** Download matching msedgedriver from https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/ and replace the binary in the project (wherever `wdio.conf.ts` points — check `services: [["edgedriver", { edgedriverCustomPath: "..." }]]`). Do this before blaming code changes for a test-suite regression.
**Context:** Any session running `pnpm test:e2e*`. Check Edge version first: `(Get-Item "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\*\msedge.exe").VersionInfo.ProductVersion`.

---

## WebView2 — Web Audio API is CORS-blocked for `asset.localhost` files

**Problem:** `AudioContext.createMediaElementSource(videoEl)` and `videoEl.captureStream()` both throw a SecurityError when the video element's `src` is an `asset.localhost` URL. The asset protocol returns no `Access-Control-Allow-Origin` header; `localhost:1420` (Vite) and `asset.localhost` are treated as different origins by WebView2/Chromium, and both Web Audio APIs enforce CORS for cross-origin media. Setting `video.crossOrigin = "anonymous"` makes it worse (enforces CORS where before the request was just unauthenticated). `video.volume` is capped at 1.0 by the HTML5 spec — there is no pure-JS way to get > 100% gain for `asset.localhost` media.
**Solution:** For gain < 1.0, use `video.volume = Math.min(1.0, gain)` directly. For >100% gain preview, the only correct fix is a custom Tauri URI scheme handler in Rust that serves files with `Access-Control-Allow-Origin: *` — enabling `createMediaElementSource` to work. Until that Rust work is done, cap preview at 100% and apply real gain via FFmpeg `volume` filter on render. Do NOT ship 150%/200% chips without the Rust protocol fix — users will expect audible difference.
**Context:** Arrange Sound tab per-clip volume preview. Any future feature requiring Web Audio processing of local video files via `asset.localhost`.

---

## WebView2 — `<video>` elements in persistent HUD components autoplay on navigation

**Problem:** `<video>` elements inside `StickyFilmStrip` (or any component that persists across route changes) begin playing when the user navigates between screens, because React re-mounts the component and `autoPlay` / `loadeddata` event handlers fire again. With 7 simultaneous video elements, this creates concurrent decode/play cycles, network traffic, and audible audio bleed.
**Solution:** Never use `<video>` elements in the HUD filmstrip. Use CSS `background-image: url(thumbnail_data); background-size: auto 100%; background-repeat: repeat-x` on a plain `<div>`. The base64 thumbnail from `scan.py` tiles horizontally (DaVinci-style) with zero playback risk and no network requests.
**Context:** `src/components/StickyFilmStrip.tsx`. Any component rendered on multiple routes that needs to show video frame content.

---

## Pipeline events — Tauri / React contract

## [Stage label clobber]

**Problem:** `pipeline-progress` Rust event includes a `stage` field (e.g. `"processing"`), which immediately overwrites the human-readable label set by the `pipeline-stage` event one line earlier.
**Solution:** `pipeline-progress` must only emit `{ jobId, progress }`. The `pipeline-stage` event exclusively owns the label; the React progress handler must only call `setProgress`, not `setStage`.
**Context:** `src-tauri/src/lib.rs` `run_pipeline()`, `src/pages/Output.tsx` progress listener.

## SQLite — schema constraints

- **No `ON DELETE CASCADE` without `PRAGMA foreign_keys = ON`** — rusqlite opens each connection without enabling FK enforcement. Even if FKs are declared in the schema, `DELETE FROM projects WHERE id = ?` won't cascade. Always delete in child-first order manually: `clips` → `jobs` → `projects`. Confirm by reading the schema DDL before writing any delete logic.
- **No `ADD COLUMN IF NOT EXISTS` in SQLite** — running `ALTER TABLE t ADD COLUMN c TEXT` a second time raises "duplicate column name: c" and crashes. Use a migration guard: `SELECT COUNT(*) FROM pragma_table_info('jobs') WHERE name='column_name'` → only run ALTER if count is 0. Do this in Rust `db.rs` `init()` immediately after the initial `execute_batch` schema creation.

## UI-to-pipeline value mapping

- **Slider sends 0–100, pipeline expects 0.0–1.0** — React range inputs return integers (0–100); pipeline functions expect float factors (0.0–1.0). Scale in `run.py` at the settings boundary: `settings.get("music_volume", 40) / 100.0`. If the default in `run.py` is set as a raw float (e.g. `0.4`), it will be silently wrong the first time the UI sends an integer `40`. Always align the default unit with the source: use `40` (integer, UI scale) as the default in `run.py` and always divide. NOTE: as of Batch 12b `music_volume` is now a string union `"subtle"|"balanced"|"prominent"` — the 0–100 integer pattern no longer applies to this field specifically, but the principle remains valid for any new numeric config field.
- **Per-clip pre-processing cost is multiplicative** — adding an FFmpeg pass per clip before the encode phase (e.g. scene detection scoring) multiplies processing time by N clips. On 30 DJI clips at ~20s each, that is 10+ extra minutes before a single frame is rendered. Profile realistically on target footage size before shipping any per-clip analysis step; prefer single-pass designs where the analysis output is reused for multiple purposes (trim + score from the same FFmpeg call).

## Native Win32 splash + startup performance

- **`windows` crate 0.58: `HWND` wraps `*mut core::ffi::c_void`, not `isize`** — code that constructs `HWND(val as isize)` fails to compile. Store the raw pointer as `usize` in an `AtomicUsize`, then reconstruct as `HWND(val as *mut core::ffi::c_void)`. The `isize` constructor existed in 0.52 and earlier; 0.58 changed the type.
- **`UpdateWindow` is absent from `windows` 0.58 `Win32_UI_WindowsAndMessaging`** — removed without replacement. Use `ShowWindow` to make the window visible; the first `WM_TIMER` fires `InvalidateRect` which triggers an immediate `WM_PAINT`. No `UpdateWindow` needed.
- **`spawn_blocking` required for `std::process::Command` inside `async` context** — `tauri::async_runtime::spawn(async move { Command::new("wsl")... })` blocks an async thread-pool thread for the duration of the process (confirmed 6-8s for `wsl --status`). Wrap in `tokio::task::spawn_blocking(|| { Command::... })`.await` to run on a dedicated blocking thread without stalling the async pool.
- **`Manager` trait must be imported to call `app.get_webview_window()`** — `app.get_webview_window("main")` fails to compile with "method not found" unless `use tauri::Manager;` is in scope. It is not re-exported via `tauri::*`. Add it explicitly alongside `Emitter`.
- **`visible: false` in tauri.conf.json breaks E2E** — WebDriver (msedgedriver) cannot attach to a window that has never been shown: "Failed to create a session". Fix: set `visible: false` in config so the window starts hidden (covered by the native splash), then call `win.show()` in `setup()` immediately after db::init. The native splash (`WS_EX_TOPMOST`) covers the briefly-shown window from the user's perspective while E2E always has an accessible DOM.
- **`dataDirectory` in tauri.conf.json does NOT redirect WebView2 user data** — adding `"dataDirectory": "webview-data"` to the window config has no effect; the directory is never created. WebView2 already persists its user data (compiled shaders, code cache) to `%LOCALAPPDATA%\<identifier>\EBWebView` by default, which provides cache persistence across launches. Do not add `dataDirectory` to tauri.conf.json to "fix" cold starts — it's a no-op.
- **`app-ready` fires before React's `listen()` when WSL check is async** — with sync WSL check, `app-ready` fires ~6-8s after binary starts (after React has loaded Vite). With async check, `app-ready` fires ~50ms after binary starts — before WebView2 has even loaded `index.html` (~4-6s later). The `listen("app-ready", ...)` call never sees the event. Fix: add a short fallback timeout (500ms is sufficient — the window shows the `#rc-splash` dark overlay until then). Alternative: use `confirm_app_loaded` (React mount invoke) as the close signal instead of relying on `app-ready` timing.
- **`pnpm dev` is the wrong test vehicle for native splash** — `pnpm dev` runs `tauri dev` which compiles Rust (~15-25s) before launching any binary. No native splash can appear during compilation. Correct test workflow: `pnpm dev:vite` once (stays running), then double-click `src-tauri\target\debug\rushcut.exe` directly. Rust only needs recompiling when `.rs` files change — keep Vite running and re-launch the binary.

## Tauri — plugin audit before adding crates

**Problem:** A plan specifies adding a native Rust crate (e.g. `rfd`) for a capability (file dialog, tray, notification) that may already be wired via a `tauri-plugin-*` package.
**Solution:** Before adding any new Rust crate, check `src-tauri/Cargo.toml` for the matching `tauri-plugin-*` dependency AND `src-tauri/src/lib.rs` for `.plugin(tauri_plugin_*::init())`. A plugin that is registered in `lib.rs` and declared in `capabilities/default.json` is fully wired — calling `rfd` or similar is redundant and adds a second native file dialog stack.
**Context:** Specifically confirmed: `tauri-plugin-dialog` is already wired in this project (`dialog:allow-open` capability, `tauri_plugin_dialog::init()`). Use `invoke("plugin:dialog|open", ...)` from TypeScript rather than adding `rfd`. Check this before any Batch B2+ file-picker work.

---

## Tauri / Windows dev

- **Rustup PATH only applies to new terminals** — after `winget install Rustlang.Rustup`, `cargo` is available in newly opened terminals only. Existing CMD/PowerShell windows don't inherit the updated PATH. Fix for the current session: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`. Fix permanently: `[System.Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";$env:USERPROFILE\.cargo\bin", "Machine")` then reopen terminal.
- **`pnpm dev` = `tauri dev`** — this starts Vite (port 1420) then compiles Rust and opens the Tauri window. `pnpm dev:vite` alone starts only the React frontend; all `invoke()` calls throw "Cannot read properties of undefined (reading 'invoke')". The Preview MCP can connect to `:1420` for UI-layer testing, but no Tauri backend commands will work — use it only for layout/navigation/React state checks. Startup shows `[wsl_check] ok` in the terminal if WSL2 is available. A blank black window on first launch is expected until React routes are wired.
- **Tauri 2.x plugin permissions are runtime-only** — missing capability entries throw `not allowed` at runtime, not at compile time. Declare all needed permissions in `src-tauri/capabilities/default.json` (e.g. `"dialog:allow-open"` for the folder picker). `cargo check` passes silently even when permissions are missing.
- **Tauri plugin config: `null` not `{}`** — plugins with no options must be `"plugin-name": null` in `tauri.conf.json`. Using `{}` causes a deserialization panic at startup: `invalid type: map, expected unit`.
- **All Tauri commands must be in a single `generate_handler![]`** — only the last `invoke_handler()` call is registered. If you add a second `invoke_handler`, the first is silently dropped. Collect all commands in one list.
- **Tauri 2.x `invoke` command names must match exactly** — the JS `invoke("get_job_cmd")` string must match the Rust `#[tauri::command] fn get_job_cmd` name. Mismatches give a runtime "command not found" error, not a build error.
- **`convertFileSrc` is the only correct asset URL API on Windows** — constructing `asset://localhost/C:/clips/foo.mp4` manually produces URLs that Tauri 2.x rejects silently; the `<video>` element renders nothing. Import `convertFileSrc` from `@tauri-apps/api/core`; it outputs `https://asset.localhost/C:/clips/foo.mp4`. Always use it for any local file served to the WebView.
- **`assetProtocol.scope` must include all directories the WebView will read from** — a missing scope entry causes a silent `403 Forbidden` on the video element with no warning at build or compile time. The scope in `tauri.conf.json` must cover: processed output (`C:\\clips\\processed\\**`), source clips (any drive the user picks from — use `C:\\**`, `D:\\**`, `E:\\**` or similar), and `$APPDATA\\rushcut\\**` for proxy files. Thumbnails served as base64 data URIs bypass this entirely — only file-path assets are affected.
- **`run.py` must explicitly forward all `JobConfig` fields** — if a new field is added to the TypeScript `JobConfig` type but not added to the settings dict in `run.py`, the pipeline silently uses its own default (which may be wrong). Convention: every `JobConfig` field maps to one `settings.get(key, safe_default)` line in `run.py`.
- **`tauri::State<'_>` is not `Send` — cannot be moved into `spawn()`** — `tauri::async_runtime::spawn(async move { ... })` requires all captured values to implement `Send`. `tauri::State<'_, T>` does not. Fix: before the spawn, extract the inner `Arc` via `Arc::clone(&*state)` and move the clone into the closure instead. If `T` is already an `Arc<Mutex<...>>`, this is a single `Arc::clone` call.
- **`window.confirm()` is silently swallowed by Tauri WebView2** — `window.confirm()` returns `true` immediately without showing any dialog. Never use it for destructive-action confirmation in a Tauri app. Replace with an in-app React state `pendingConfirm` that renders an inline confirmation panel inside the component tree.

## Next.js / Turbopack

- **`@ffprobe-installer/ffprobe` needs `serverExternalPackages`** — the package bundles a README.md that Turbopack can't handle, causing `Unknown module type` 500 on first API call. Fix: add `serverExternalPackages: ['@ffprobe-installer/ffprobe']` to `next.config.ts`.
- **Supabase schema cache:** "Reload Schema" button removed from Dashboard. Run `NOTIFY pgrst, 'reload schema';` in the SQL editor after schema changes instead.
- **JSX ternary can only return one node per branch** — adding a sibling element to an existing ternary branch causes "Expected '</', got '{'" parse error. Wrap the two sibling elements in a `<>` fragment.
- **`localStorage` projectId persists across sessions** — clear it on upload page mount (`useEffect(() => localStorage.removeItem('rushcut_project_id'), [])`) so new visits always start a fresh project rather than appending to a stale one.

## Cloudflare R2

- **R2 presign with AWS SDK** — use `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` with `region: 'auto'` and `endpoint: 'https://{accountId}.r2.cloudflarestorage.com'`. No custom middleware needed.

## Git / Windows

- **`git push` hangs silently in non-interactive shells (Windows)** — Windows Credential Manager intercepts the push even when a PAT is embedded in the remote URL, blocking indefinitely with no output. Always push as `GIT_ASKPASS=echo GIT_TERMINAL_PROMPT=0 git push https://<token>@github.com/<repo>.git main`. Use `Stop-Process -Name git -Force` in PowerShell to kill hung processes.
- **Rust build artifacts block GitHub push** — `src-tauri/target/` contains files up to 668 MB; committing them triggers `GH001: Large files detected` and GitHub rejects the push. Add `src-tauri/target/` and `src-tauri/gen/` to `.gitignore` before the first commit. Recovery: `git filter-branch --tree-filter 'rm -rf src-tauri/target src-tauri/gen' -- <first-bad-commit>^..HEAD` then `git push --force`.

## Docker / WSL (Windows)

- **Docker Desktop requires WSL 2** — fresh install reports `wslUpdateRequired: true` and fails to start. Run `wsl --install --no-distribution` first, then **restart Windows**. Check state: `docker info 2>&1 | grep wslUpdateRequired`. Plan for the restart before any session where Docker is needed.
- **Docker Desktop v4.65.0 `dockerInference` socket crash** — confirmed unfixed bug. On every startup Docker tries to `remove()` a Unix socket file (`AppData\Local\Docker\run\dockerInference`); Windows rejects this and Docker crashes. `EnableInference: false` in `settings-store.json` does not suppress it. **Workaround**: install Docker Engine natively in WSL2 (`wsl --install -d Ubuntu-24.04 --no-launch`, set root as default, `curl -fsSL https://get.docker.com | sh`). All Docker commands run as: `wsl -d Ubuntu-24.04 -u root -- bash -c "service docker start && docker ..."`.
- **Lambda rejects OCI manifest lists** — `docker buildx build --platform linux/arm64` produces an OCI manifest list by default; Lambda returns "image manifest media type not supported". Fix: add `--provenance=false`. Always build Lambda images with `docker build --platform linux/arm64 --provenance=false`.
- **IAM role creation requires explicit permission** — `AWSLambda_FullAccess` does not include `iam:CreateRole`. Workaround: use AWS CloudShell (full IAM access as root account) to create the Lambda execution role; use the scoped CLI user for everything else.

## Browser / media

- **DJI HEVC + Chrome thumbnail generation:** Chrome reads the embedded MJPEG stream (stream 1) from DJI containers when generating thumbnails via `<video>` + canvas, so `generateThumbnail()` often succeeds locally. However it is unreliable across sessions and devices. Persist thumbnails as base64 in Supabase (`thumbnail_data TEXT`) at upload time; the editor reads them directly as `<img src>` — no video decode on the editor page ever.
- **`MediaError` code diagnosis:** Add `console.error('[thumbnail]', { code: video.error?.code })` in the video error handler before assuming codec failure. Code 4 = codec unsupported (HEVC/H.265); code 2 = network/CORS failure. These require different fixes.
- **WebView2 does not paint the first frame of a paused `<video>` element** — setting `currentTime` on a paused H.264 proxy at mount time does not force a visual repaint in WebView2. The frame stays black until `play()` is called at least once. Fix: after setting `currentTime`, call `v.play().then(() => v.pause())` to force a decode+paint cycle. If the video is not yet buffered at mount time (readyState < 2), attach a `loadeddata` listener first, then call play+pause inside it. This is distinct from the codec issue (error code 4) — the file loads fine, it just does not render until played.
- **`readyState: 0` at useEffect mount is common with `preload="auto"` on proxy files** — Tauri's asset protocol may not have responded by the time React's useEffect runs immediately after mount. Setting `currentTime` when `readyState === 0` is a no-op. Always gate first-frame logic on `readyState >= 2` or on the `loadeddata` event; never assume the video has buffered by the time the first effect fires.
- **`<video>` poster disappears after a failed `src` load — need explicit fallback state** — the HTML `poster` attribute only shows before the first `src` is set. Once `src` is assigned and the browser attempts to load it (even if it fails with `onError`), the poster is gone and the element shows a broken-media icon. Fix: add a `sourceFailed` boolean state, set it in `onError`, and render a sibling `<img src={thumbnailData}>` when `sourceFailed === true`. Hide the `<video>` with `style={{ display: sourceFailed ? "none" : undefined }}` — do NOT use conditional rendering (`sourceFailed ? ... : ...`) because that would unmount the video ref.

## E2E cold-start race — pre-launch app before running pnpm test:e2e

**Problem:** WDIO's `beforeSession` hook kills and relaunches the Tauri binary. On a cold system (no prior CDP session), the port 9222 can disappear in the window between `waitForPort(9222)` resolving and msedgedriver attaching — causing "cannot connect to Microsoft Edge at 127.0.0.1:9222" on the first run attempt.
**Solution:** Pre-launch the app with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` *before* running `pnpm test:e2e`. The `beforeSession` cleanup kills and relaunches it — but having an existing CDP session means the port is already warm when WDIO starts. Two failed attempts in a fresh shell = this is the cause.
**Context:** Any session that runs `pnpm test:e2e*` from a terminal that has never launched the Tauri binary with CDP flags. The fix is `cmd.exe /c "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 && start C:\apps\rushcut\src-tauri\target\debug\rushcut.exe"` then wait 5s before starting WDIO.

---

## Pipeline — AMF availability probe: encoder-list check ≠ encode capability

**Problem:** `_detect_amf()` in `pipeline/encoder.py` only runs `ffmpeg -encoders | grep h264_amf` — encoder *listed* does not mean the AMD driver bridge is *functional*. A WSL-packaged ffmpeg (e.g. Ubuntu apt ffmpeg) always fails AMF regardless of the encoder list because it was compiled without AMF support and the Windows AMD driver bridge requires Windows ffmpeg.exe.
**Solution:** Probe with a real synthetic encode: `wsl -- /mnt/c/.../ffmpeg.exe -f lavfi -i color=c=black:size=1920x1080:r=30 -t 2 -c:v h264_amf -qp 23 /tmp/amf_test.mp4`. Success = exit 0 + "Output #0, mp4" in stderr. This tests the full WSL2 → Windows ffmpeg.exe → AMD driver bridge end-to-end. WSL ubuntu ffmpeg will fail with "Unknown encoder 'h264_amf'" — that is expected and correct; retry with the Windows ffmpeg.exe at its `/mnt/c/...` WSL path.
**Context:** AMF probing in `pipeline/encoder.py`. Windows ffmpeg path resolved by Rust `resolve_win_ffmpeg_path()` (OnceLock, `where ffmpeg`). On this machine: `C:\Users\Manasak\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\bin\ffmpeg.exe`.

---

## Pipeline — h264_amf GPU encoder (AMD, Windows-native ffmpeg, Batch Q)

**AMF vs libx264 file size tradeoff:** At the default quality parity point (`-rc cqp -qp_i 20 -qp_p 20`) AMF produces ~50% larger files than libx264 `-crf 22 -preset fast` on 4K DJI footage (96 MB vs 63 MB for a 30s clip). `AMF_QP = 23` brings file size to ~6% larger (67 MB) with no measurable encode time difference — this is the shipped default in `encoder.py`.

**B-frames not supported on AMD AMF (hardware-level, not a config issue):** h264_amf with `-rc cqp` produces `has_b_frames=0` regardless of any `-bf N` flag — the AMD driver silently ignores it. This was confirmed at both CQP and VBR rate control modes on this hardware (AMD GPU, WinGet ffmpeg 8.0.1). libx264 `-preset fast` produces `has_b_frames=2`, which makes pans look noticeably smoother. There is no AMF flag combination that restores B-frames on this machine. Workaround if motion quality matters: use libx264 via `RUSHCUT_FORCE_LIBX264=1` or add a quality-mode UI selector. NVENC (Nvidia) does support B-frames and would not have this limitation.

**Encode speed:** 1.7× faster than libx264 on AMD GPU (30s 4K clip: 27.8s AMF vs 46.6s libx264). AMD AMF is structurally slower than Nvidia NVENC — do not expect 5–10× speedup on AMD hardware. On a real 8-clip 4K render, Step 5 drops by roughly 70s.

**Path translation (WSL Python → Windows ffmpeg.exe):** Windows ffmpeg.exe cannot be invoked via a `C:\...` string from WSL `subprocess.run` — it needs the `/mnt/c/...` WSL-accessible form. Conversely, file path *arguments* to Windows ffmpeg must be Windows-form (`C:\...` or `\\wsl.localhost\Ubuntu-24.04\...`). Two separate helpers handle this: `_win_to_wsl()` (binary path) and `to_win_path()` (file args) in `pipeline/encoder.py`.

**WSL tmpfs is invisible to Windows via wsl.localhost if WSL was restarted:** `/tmp` files written before a `wsl --shutdown` or OOM restart are gone; and immediately after restart, the `\\wsl.localhost\Ubuntu-24.04\tmp\` share may appear empty. The pipeline is safe because WSL stays alive for the entire render job — but benchmark scripts that regenerate test sources after a WSL restart must write to an NTFS path (`/mnt/c/...`) to be accessible from Windows ffmpeg.

**RUSHCUT_FORCE_LIBX264=1 env var bypasses AMF detection** — use this to test the libx264 fallback path without touching hardware.

**`amf_fallback` pattern for silent encoder fallback detection:** When `use_amf=True` and the initial AMF encode raises `RuntimeError`, `render.py` retries with libx264 via `_run_with_amf_fallback()`. A list-closure `amf_fallback_flag = [False]` tracks whether fallback occurred (list used for mutability inside a nested function). At pipeline end, `amf_fallback=0/1` is appended to the ANALYSIS stdout line. `src-tauri/src/lib.rs` captures `last_analysis` per job and emits it in the `pipeline-done` event's `"analysis"` JSON field. React reads `/(^|,)amf_fallback=1(,|$)/.test(analysis)` to surface a toast. This pattern is reusable for any silent fallback that must be surfaced to the user after the fact.

**`pipeline-done` event carries `analysis` field (Batch R Part C):** The `pipeline-done` Tauri event payload now includes `{ jobId, stage, progress, message, outputPath, analysis }` where `analysis` is the full ANALYSIS stdout string (or null if not emitted). React listeners must be typed `PipelineProgressEvent & { analysis?: string | null }` to access it. The field allows post-render decision surfacing (encoder used, fallback state, proxy stats) without requiring a DB query.

**`generate_proxy_file_low_priority` must use the same AMF/libx264 arg branching as the normal-priority variant:** `generate_proxy_file_normal_priority` was fixed in Batch S to branch on `is_amf = encoder == "h264_amf"` (AMF needs `-rc cqp -qp_i 30 -qp_p 30 -quality speed`; libx264 needs `-preset ultrafast -crf 23`). The low-priority function was NOT updated at the same time. It kept the libx264-style args while still calling `detect_best_encoder()` — so on AMF hardware, every low-priority encode failed silently with `elapsed=0.1s`. The fix (Batch S4) mirrors the full arg branching from the normal-priority function. **Rule:** whenever touching either proxy encode function, always check that BOTH functions stay in sync on encoder args.

---

## Proxy gate — `ready === 0` bypass condition is stale after Batch N

**Problem:** `submitJob` in `Render.tsx` contained `if (status.ready >= status.total || status.ready === 0)` to skip the proxy-wait gate. The `ready === 0` branch was correct before Batch N (no background gen existed; 0 ready = proxies not applicable). After Batch N, bg gen starts on Trimmer exit — cold 4K projects have 0 proxies ready *while encoding is in flight*. The bypass fires anyway, skips the gate, and launches the full 169s HEVC normalise immediately.
**Solution:** Change to `if (status.ready >= status.total || (status.ready === 0 && !has4K))`. Non-4K cold renders still bypass (normalise is fast at 1080p). 4K cold renders fall through to the gate and get boosted bg gen. Measured result: t_normalise_s dropped from 169s → 1s.
**Context:** `src/pages/Render.tsx` `submitJob` function. Any future change to the proxy gate condition must handle the cold-start case explicitly — `ready === 0` is NOT a safe bypass when 4K clips exist.

---

## Proxy pipeline — `HashSet` concurrency guard silently drops priority-upgrade calls

**Problem:** `generate_proxies_cmd` uses `Arc<Mutex<HashSet<project_id>>>` to prevent duplicate bg gen batches. When the render gate calls `generate_proxies_cmd(lowPriority: false)` to boost an in-flight low-priority batch, the guard detects the project is already running and returns `Ok(())` silently — the boost never reaches FFmpeg. Clips continue encoding at `-threads 1 BELOW_NORMAL_PRIORITY_CLASS` (60–110s each) instead of `-threads 0 normal` (~10–20s each).
**Solution:** Allow the normal-priority boost to bypass the guard: `if set.contains(&project_id) && low_priority { return Ok(()); }`. Both batches run concurrently; a DB atomic claim (`UPDATE clips SET proxy_status='encoding' WHERE proxy_status NOT IN ('encoding','done')` → `rows_affected == 1`) prevents two FFmpeg processes from writing the same proxy file. First batch to claim a clip owns the encode; second batch skips claimed clips via `continue`. On encode failure, reset status to `'queued'` (not `'encoding'`) so the other batch retries.
**Context:** `src-tauri/src/lib.rs` `generate_proxies_cmd` + `run_bg_proxy_batch`. `src-tauri/src/db.rs` `claim_clip_for_encoding` + `reset_stale_encoding_claims`. The `HashSet` pattern protects against duplicate runs but must NOT block priority escalation — use the DB claim for per-clip mutual exclusion instead.

---

## Proxy pipeline — background gen and render gate must both be resolution-aware

**Problem:** Background proxy gen produced 1080p proxies. `render.py` accepted any `height >= 1080` proxy for all render modes. A 4K render that reused a 1080p proxy upscaled from 1080p → 2160p, degrading output quality — AND still got ~2s normalise (wrong skip for wrong reason). Separately, `get_clips_needing_bg_proxy` filtered `proxy_status != 'done'` which prevented 1080p proxies from being upgraded to 2160p.
**Solution:** (1) Background gen always encodes at `scale=-2:2160` — a 2160p proxy qualifies for both 1080p (`h >= 1080` ✓) and 4K (`h >= 2160` ✓) renders. (2) `render.py` gate: `required_proxy_h = 2160 if output_resolution == "4k" else 1080` — rejects 1080p proxies for 4K renders and falls through to normalise from source. (3) `get_clips_needing_bg_proxy` returns ALL `include=1` clips; `run_bg_proxy_batch` calls `proxy_height_native()` to decide skip/upgrade/encode.
**Context:** Any change touching `generate_proxy_file_low_priority()` in `lib.rs`, `_proxy_height()` in `render.py`, or `get_clips_needing_bg_proxy()` in `db.rs`. Hardcoded height value `1080` anywhere in the proxy/normalise path is a latent 4K bug — always parameterise by `output_resolution`.

---

## Proxy pipeline

- **Proxy encode timeout must be 600s, not 120s** — `subprocess.run(..., timeout=120)` is too short for 4K HEVC source clips longer than ~60s at software decode speeds. A 90-second 4K DJI clip with software HEVC decode takes 90–180s to encode to 480p H.264 ultrafast, depending on CPU load. Set `timeout=600` (10 min ceiling) in `generate_proxy()`. The timeout killing FFmpeg mid-write produces a corrupt file — see the moov-atom pattern below.
- **FFmpeg killed mid-write leaves a corrupt MP4 with missing moov atom** — if the proxy encode process is killed (timeout, SIGTERM, crash), FFmpeg writes partial data but never finalises the container header. The resulting file passes `Path.exists()` but `ffprobe -v quiet -show_format` returns exit code 1. `proxy.py` must validate existing files with `ffprobe` before skipping re-encode — a size check is insufficient (partial files can be several MB). Pattern: `if Path(proxy_wsl).exists() and not is_valid_proxy(proxy_wsl): Path(proxy_wsl).unlink(); generate_proxy(...)`.
- **4K HEVC software decode is ~1x realtime — a 5-min source clip takes ~300s to proxy regardless of encoder** — AMD AMF/NVENC GPU encoders are bottlenecked by the HEVC decode stage, not the encode stage. A 246 MB, 31s 4K DJI clip at high bitrate still took 78s to proxy via AMF (2.5x realtime) due to dense intra-frame complexity. Sessions with clips longer than ~2min will exceed the 120s gate target. Mitigation: partial-ready gate entry (gate advances when all SHORT clips are done and user clicks "continue"); long-clip segmented proxy gen. Treat long-clip sessions as a separate batch.
- **480p ultrafast proxies for scrubbing: ~4–8s per 30s clip** — `-preset ultrafast -crf 28 -vf scale=-2:480` gives ~4× speedup over the FFmpeg default `medium` preset. For scrubbing use (not final output), ultrafast quality is indistinguishable. Do NOT use 720p for proxies — pixel count difference (~2.25×) adds measurable encode time with no UX benefit at the small TrimBar display size.
- **Try source first; transcode only on `onError`** — WebView2 cannot decode HEVC without the Windows HEVC Video Extension, but the extension is pre-installed on many Windows 11 machines. The correct architecture is: set `src = convertFileSrc(local_path)` always; only trigger proxy gen when WebView2 fires `onError`. For H.264/VP9/AV1 (always native in WebView2) and HEVC with extension (most Win11 users), playback is instant at source resolution — no transcode, no wait. Never pre-generate proxies for all clips upfront; this is pure waste for the majority of users.
- **GPU encoder detection via OnceLock — test once, reuse forever** — `h264_nvenc` (Nvidia), `h264_qsv` (Intel QuickSync), and `h264_amf` (AMD) cut proxy encode time from 30–40s to 3–5s on a 1.5-min 4K HEVC clip. Detect the best available encoder once with a 1-frame lavfi test encode (`-f null -`), cache in `static BEST_ENCODER: OnceLock<String>`. GPU encoders handle their own hardware decode — no separate `-hwaccel` flag needed. Fallback: `libx264`. Pattern in `src-tauri/src/lib.rs` `detect_best_encoder()`.
- **`onError` double-fire guard for lazy proxy gen** — `onError` on a `<video>` element fires every time a failed source is re-presented (e.g. React re-renders). Using `!clip.proxy_path` as the guard is insufficient: if proxy gen fails silently and proxy_path is never set, the trigger fires infinitely. Use a `Set<string>` ref (`generatingProxyRef`) keyed by clip ID; add on first trigger, check before re-triggering. Clear on clip nav so each clip gets one attempt.

## Workflow: Two-DB path confusion in Claude Code sandbox

**Problem:** When `pnpm dev` runs inside the Claude Code sandbox, Tauri's `app_data_dir()` resolves to `C:\Users\Manasak\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\rushcut\` (sandbox path), not the standard `C:\Users\Manasak\AppData\Roaming\rushcut\`. The running app's DB is at the sandbox path; direct `sqlite3` queries against the standard path see a different (often empty or stale) DB.
**Solution:** Before any `sqlite3` query during an active dev session, always use the sandbox path: `/mnt/c/Users/Manasak/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/rushcut/rushcut.db`. Run `invoke("list_projects_cmd")` in the browser console to confirm the project IDs match before writing DB update queries.
**Context:** Any wrapup or eval step that queries or patches the running app's DB directly (proxy_path, waveform_data, thumbnail_data updates). Standard AppData path is correct for builds run outside Claude Code.

## E2E Testing — Tauri + WebView2 + WDIO

## [WDIO BiDi reports stale about:blank for WebView2 attach mode]

**Problem:** WDIO v9 enables WebDriver BiDi by default; `browsingContext.getTree` returns `about:blank` even when CDP `/json/list` shows the correct URL — the BiDi protocol has a known mismatch with WebView2's CDP attach implementation.
**Solution:** Add `"wdio:enforceWebDriverClassic": true` to the capability. This disables BiDi and uses classic WebDriver protocol, which reads the correct URL.
**Context:** `wdio.conf.ts` capabilities block. Required any time msedgedriver attaches to an already-running WebView2 via `ms:edgeOptions.debuggerAddress`.

## [msedgedriver BiDi negotiation hangs on Vite HMR WebSocket]

**Problem:** WDIO v9 + msedgedriver 146 negotiate BiDi protocol despite `wdio:enforceWebDriverClassic: true`. BiDi internally calls `browsingContext.navigate` which hangs forever because Vite's HMR WebSocket prevents `readyState === "complete"`.
**Solution:** 3-layer fix: (1) `--disable-bidi` flag on msedgedriver spawn (primary — kills BiDi negotiation entirely), (2) `webSocketUrl: false` in capabilities, (3) route-aware readiness gate in `waitForAppRoute()` waits for `/upload`, `/library`, or `/editor/` in CDP `/json/list` before spawning msedgedriver. Reduced blind delay from 6s to 2s (only covers DOM hydration gap now).
**Context:** `wdio.conf.ts` — msedgedriver spawn args, capabilities block, `waitForAppRoute()` helper. See `docs/E2E-DEBUGGING.md` for full history.

## [getHTML(false) causes spec timeout when body contains base64 thumbnails]

**Problem:** `$("body").getHTML(false)` in WDIO specs transfers the entire body innerHTML (~1.9MB when MediaPantry clips have base64 thumbnail data) through WebDriver, taking >10 minutes and exceeding the Mocha 600s spec timeout.
**Solution:** Never call `getHTML(false)` to check for a string in specs — use targeted element selectors (`$('[data-testid="..."]').getText()` or `$$("button").find()`) or `browser.execute(() => document.querySelector("...").textContent)` to check specific nodes. Only use `getHTML` on small, known-bounded DOM subtrees.
**Context:** `e2e/trimmer.spec.ts` — any spec that runs after clips are loaded into MediaPantry. The thumbnail base64 data is embedded in every `<img>` in the pantry grid and makes the full body HTML enormous.

## [E2E spec route waits and text assertions rot silently after flow changes]

**Problem:** URL `waitUntil` strings and `toContain()` text checks become stale without any compile error when routing or UI copy changes. Examples: `gap-editor.spec.ts` waited for `/editor/` after "Open project" routes to `/trimmer/`; `trimmer.spec.ts` checked for `"In Film"` text that was removed in Batch 16b C3 (replaced by a green SVG dot badge with no text).
**Solution:** After any routing change or UI copy removal, grep `e2e/**/*.spec.ts` for the old URL strings and old text values and update them. `document.body.textContent` is safer than `getHTML()` but still silently misses removed text. Always verify text assertions still match current UI copy.
**Context:** Any E2E spec maintenance pass after a navigation-layer batch. Run `grep -n "toContain\|waitUntil\|includes" e2e/*.spec.ts` to surface candidates.

## [Stale WebView2 subprocess holds CDP port between test runs]

**Problem:** Killing `rushcut.exe` does not kill the WebView2 subprocess (a separate OS process). The stale subprocess holds port 9222 across test runs; the next run attaches to a dead WebView2, causing `getUrl()` to time out.
**Solution:** In `beforeSession`, use PowerShell `Get-NetTCPConnection -LocalPort 9222 | Stop-Process -Force` to kill whatever process holds the port before launching the binary.
**Context:** `wdio.conf.ts` `beforeSession` cleanup block. Also `taskkill /F /IM rushcut.exe` and `/IM msedgedriver.exe`.

## [browser.url() hangs indefinitely with Vite dev server]

**Problem:** `browser.url("http://localhost:1420/")` hangs for 2+ minutes because WDIO's `POST /session/:id/url` waits for `document.readyState === "complete"`. Vite's persistent HMR WebSocket prevents this state from ever firing.
**Solution:** Remove all `browser.url()` calls. Instead, poll `browser.getUrl()` using `browser.waitUntil()` and check for the expected route substring (e.g. `url.includes("/upload")`).
**Context:** `e2e/fast.spec.ts` `before` hook; any spec that runs against the debug binary (Vite dev server).

## [CDP /json/list URL vs WebDriver getUrl() mismatch]

**Problem:** CDP REST `/json/list[].url` reflects the browser process's pending navigation target (e.g. `http://localhost:1420/`), while WebDriver `GET /url` reflects the renderer process (which may still show `about:blank` during navigation).
**Solution:** Use `/json/list` only to confirm the app has launched and navigated away from blank — not as a proxy for what WebDriver will return. Always use `browser.waitUntil(getUrl())` after attaching msedgedriver.
**Context:** `wdio.conf.ts` `checkTargets` function.

## [Tailwind hover variants appear in class attribute — toContain() matches inactive state]

**Problem:** `expect(el.getAttribute("class")).toContain("border-white/60")` matches even when the element is *inactive*, because the inactive class string contains `hover:border-white/60`. The Tailwind class attribute is a literal space-separated string of utility names including all variants.
**Solution:** When asserting active vs inactive state with `toContain`, pick a token that exists **only** in the active class — not also present as a hover variant of the inactive class. Prefer background tokens (`bg-white/15`) over border tokens when the inactive class uses a matching hover border (`hover:border-white/60`). For inactive negation use `not.toContain("bg-white/15")`.
**Context:** Any WDIO spec asserting chip active/inactive state on elements whose inactive style has hover variants that share a colour token with the active style.

## [Prefer debug binary over release for E2E; release binary is stale after source changes]

**Problem:** The release binary has the frontend embedded at build time. After adding `data-testid` attrs, a release binary built before those changes will fail all selector-based tests.
**Solution:** In `wdio.conf.ts`, check for the debug binary first (`src-tauri/target/debug/rushcut.exe`), fall back to release. Debug binary loads the frontend from the live Vite dev server and always reflects current source without a full `tauri build`.
**Context:** `wdio.conf.ts` `APP_PATH` / `usingDebug` constants.

## [Chrome-devtools MCP UIDs go stale after React re-renders]

**Problem:** After clicking a button that changes React state (navigation, chip toggle), all UIDs from the previous `take_snapshot`/`wait_for` are invalidated. Clicking a stale UID errors with "Element with uid X no longer exists".
**Solution:** Always take a fresh snapshot (`take_snapshot` or `wait_for`) before every interaction after a state change. For sequential clicks in a loop (e.g., music chips), add ~200ms delay or take a snapshot between each click.
**Context:** `rushcut-eval` skill — applies to any chrome-devtools MCP interaction with a React app.

## [WDIO/Jest `expect(val, message)` 2-arg form not supported]

**Problem:** `expect(value, "error message").toBe(...)` throws "Expect takes at most one argument" — this Jest version doesn't accept a custom message as the second arg to `expect()`.
**Solution:** For value assertions use `expect(value).toBe(...)` without a message. For null/existence guards use `if (!x) throw new Error("x missing")` before the assertion.
**Context:** `e2e/gap-editor.spec.ts` and `e2e/render.spec.ts` — any spec using a message arg on `expect()`.

## [isExisting() returns immediately — fails on async-loaded elements]

**Problem:** `$('[data-testid="btn-render-film"]').isExisting()` returns `false` when the element renders conditionally after an async `useEffect` (e.g. `get_project` + `has_4k_clips_cmd` resolve 1–2s after mount), so a click is skipped and downstream assertions never see the expected state. The Render screen starts in `"starting"` phase (spinner only); `btn-render-film` only appears in `"ready"` phase.
**Solution:** Replace `isExisting()` with `waitForExist({ timeout: N })` wrapped in try/catch. On timeout, treat the absence as expected (non-4K path auto-starts without a button) and continue. `isExisting()` is only safe for elements that must be present synchronously.
**Context:** `e2e/render.spec.ts` — applies to any spec asserting conditional UI that renders after an async data fetch. Root cause: Render screen `useState<Phase>("starting")` + `Promise.all([get_project, has_4k_clips_cmd])` in `useEffect`.

## [Progress element disappears before poll catches 100%]

**Problem:** `waitUntil` polling for `progress-pct >= 100` times out even when the pipeline succeeds. The done state renders and removes the progress element between two 2s poll intervals — the poller never sees 100%.
**Solution:** Include the "done" state as an alternative early-exit condition: `if (await h1.getText() === "Your film is ready") return true` before checking the progress value.
**Context:** `e2e/render.spec.ts` — any spec that polls a transitional UI element that disappears on completion.

## [invoke() via evaluate_script bypasses React state]

**Problem:** Calling `window.__TAURI_INTERNALS__.invoke("scan_folder")` via `evaluate_script` returns data from Rust but doesn't update the React component's state (no `setClips()` call). Upload page shows no clips.
**Solution:** Accept this as a permanent limitation. Use `invoke("scan_folder")` only to get clip metadata for `create_project`, not to populate UI. Mark clip display checks as SKIP in eval.
**Context:** `rushcut-eval` skill — Upload page eval section.

## [Workflow: E2E spec planning requires reading routing + page components, not just spec files]

**Problem:** When planning E2E spec fixes, exploring only the spec files and `e2e.md` misses the current navigation target. The plan assumed "Open project" still routes to `/editor/` — requiring 3 planning iterations before implementation.
**Solution:** For any E2E task involving navigation: always read `src/App.tsx` (route map), the relevant page component (`Trimmer.tsx`, `Editor.tsx`, etc.), and `StepNav.tsx` in the initial Phase 1 exploration. The spec's expected URL is only correct if you verify it against the actual route registered in `App.tsx`.
**Context:** Planning phase for any spec that follows a user navigation flow. Add these to the Phase 1 parallel read list alongside the spec file itself.

---

## Workflow: CDP eval requires a pre-running app — do not orchestrate from tool calls

**Problem:** Attempts to start Vite (`pnpm dev:vite`) and the Tauri binary from inside Bash/PowerShell tool calls fail silently — the processes die between tool calls because each tool call runs in a fresh child shell. Diagnostic confusion follows when CDP port 9222 is occupied by a wrong process or is empty.
**Solution:** Visual eval (MCP screenshots) and E2E runs both require the app to already be running. Check `netstat -ano | findstr :9222` first; if not live, ask the user to run `pnpm dev` in their terminal. Do NOT attempt to orchestrate Vite + binary from within tool calls.
**If Vite + binary must be launched from tools:** Use a single PowerShell call that starts Vite as a `Start-Job` AND launches the binary before the call returns. Background jobs from PowerShell persist for the lifetime of that PowerShell invocation — they die when the shell exits. Bash `&` background processes die immediately. The only reliable pattern: `$viteJob = Start-Job { cd C:\apps\rushcut; pnpm dev:vite }; Start-Sleep 12; Start-Process rushcut.exe`. Both operations must be in the same PowerShell tool call.
**Context:** `rushcut-eval` skill — pre-flight check before any MCP screenshot or WDIO run. Confirmed Batch B Run 3 (2026-05-03): Bash background Vite died between calls, requiring 8 extra round trips.

## [Render screen: auto-start is better UX than idle-with-button]

**Problem:** An idle render screen with a single "Render Film" button adds unnecessary friction — user has already made all decisions (clips, transition, sound) on prior screens. The single button buys nothing.
**Solution:** Auto-start render on mount: `get_project` → `start_job` immediately in `useEffect`. Show a "starting" spinner state while the project loads, then transition directly to the progress bar. No idle phase. "Try Again" in the error state is the only explicit re-trigger.
**Context:** `src/pages/Render.tsx` — applies to any screen where the user has no further decisions to make before the action fires.

## E2E — WDIO beforeSession kills active user renders; do not run E2E while a render is in progress

**Problem:** `wdio.conf.ts` `beforeSession` runs `taskkill /F /IM rushcut.exe` to clear stale binaries before the test binary launches. This kills ALL `rushcut.exe` processes — including the user's live binary if it has a render in progress. The pipeline in WSL keeps running and may complete, but the new binary has no Rust stdout listener attached to that job. `DONE:` is never received; the job stays `processing` in the DB indefinitely. The user sees a stuck progress bar with no error.
**Solution:** Never run `pnpm test:e2e*` while a render is active. Before running any E2E suite, confirm no pipeline is running (`wsl -d Ubuntu-24.04 -u root -- tail -5 /mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/pipeline-latest.log`). If a job is stuck after this happens, it can be recovered via U1c startup self-heal (next launch auto-promotes done jobs) or a direct sqlite3 UPDATE.
**Context:** Any session that runs WDIO specs concurrently with a user render. Symptom: job stuck at X% after E2E run; `pipeline-latest.log` shows `DONE:` but Render screen shows frozen progress bar.

---

## E2E — Stale msedgedriver blocks WDIO re-run; wdio.conf.ts killStaleProcesses has backslash typo

**Problem:** `wdio.conf.ts` `killStaleProcesses` uses `\F \IM` (backslash) instead of `/F /IM` (forward slash) in the `taskkill` command. The command silently fails, leaving the prior msedgedriver process alive. On the next `pnpm test:e2e` run, `waitForPort(9222)` resolves to the stale msedgedriver rather than the new Tauri binary, so WDIO attaches to a dead session and all specs fail with "cannot connect to Microsoft Edge at 127.0.0.1:9222".
**Solution:** Before re-running E2E: `taskkill /F /IM msedgedriver.exe` manually in PowerShell. Fix the typo in `wdio.conf.ts` `killStaleProcesses`: change `\F \IM` → `/F /IM` in both `taskkill` calls.
**Context:** `wdio.conf.ts` `killStaleProcesses` function. Symptom: "cannot connect to microsoft edge" on first run attempt of a new session; `tasklist | findstr msedgedriver` shows it still running.

---

## UX / timing feedback

- **Rolling inactivity timeout beats wall-clock timeout for long pipelines** — a hard `setTimeout(10min)` fires even when the pipeline is making steady forward progress, producing a false "timed out" error. Instead: start the timer on mount and reset it on each `pipeline-stage` event. Do NOT reset on every `pipeline-progress` tick — a hung pipeline that emits noisy progress would never time out. The timer fires only when no stage change has arrived for the full timeout window.
- **ETA countdown timers are unreliable for non-linear pipelines** — a remaining-time estimate based on `elapsed / progress * (100 - progress)` grows during slow pipeline stages (e.g. loudnorm), making it worse than nothing. Use a simple count-up elapsed timer instead (`useRef<number>(Date.now())` on component mount, tick every second). Users calibrate expectations from "it took 30s last time" not from a fluctuating estimate.
- **Start elapsed timer on mount, not on first progress event** — initialise `startTimeRef = useRef<number>(Date.now())` at declaration time so the counter starts at 0 immediately; initialising lazily (e.g. on first `progress > 0`) causes a visible delay before counting starts.

---

## UX / product decisions (locked)

- **Draft-first, configure-optional** — show the first render before any configuration. Mandatory configure screens before a draft add friction at the worst moment. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **StepIndicator = mandatory steps only** — optional pages (e.g. Configure as a drawer) must not appear as steps; they signal mandatory work that doesn't exist.
- **Lock copy before prompting Claude** — if copy isn't in the prompt, Claude invents it. Copy drift across pages wastes multiple correction rounds.
