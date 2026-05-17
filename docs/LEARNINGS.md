# LEARNINGS.md — rushcut

Pattern library. Organised by topic. Add to existing sections — do NOT add dated/batch headers.
Each bullet: problem in ≤1 sentence, fix in ≤2 sentences.

---

## Workflow — Serena does not support TSX/JSX files

**Problem:** `mcp__serena__get_symbols_overview` and `find_symbol` return "Cannot extract symbols — Active languages: []" on `.tsx`/`.jsx` files in this project. Calling them wastes a round trip.
**Solution:** Skip Serena entirely for React component files. Use `Read` directly (small files) or `Grep` for targeted symbol searches. Serena is only useful for Rust files in this project (`lib.rs`, `db.rs`).
**Context:** Any session touching `src/**/*.tsx` or `src/**/*.ts`.

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

## Workflow — `Start-Process` in PowerShell does not inherit `$env:` vars reliably

**Problem:** Setting `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "..."` in PowerShell and then using `Start-Process -FilePath rushcut.exe` does not propagate the variable to the child process on Windows PowerShell 5.x. The variable is silently dropped, so WebView2 never enters remote-debugging mode.
**Solution:** Use Node.js `child_process.spawn()` with an explicit `env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "..." }` (as WDIO does), or use `cmd.exe /c "set VAR=val && rushcut.exe"` syntax from a shell that correctly inherits Win32 env blocks. Alternatively, run the WDIO setup which handles this correctly via `wdio.conf.ts` `beforeSession`.
**Context:** Any session that manually launches the Tauri debug binary with CDP remote-debugging flags.

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

## Workflow — Worktree sessions

- **Edits in a worktree are NOT visible to the running app** — `pnpm dev` launched from `C:\apps\rushcut` reads the main branch, not the worktree at `C:\apps\rushcut\.claude\worktrees\<name>`. Any fix applied only in the worktree appears to have no effect when the user tests. Always apply fixes to the main-branch files (`C:\apps\rushcut\src\...`) when the goal is immediate user-visible verification, or merge the worktree branch first.

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

## DJI OsmoPocket3

- **Dual video streams** — FFmpeg/ffprobe reports two video streams per file. Stream 0 is HEVC (real clip); stream 1 is an embedded MJPEG thumbnail. Use `-map 0:v:0` or `-select_streams v:0` to pin to the real stream.
- **Source format**: HEVC Main 10 (`yuv420p10le`), portrait (1728×3072), 29.97fps. Normalise to H.264 `yuv420p` 25fps CFR before any filter operations.
- **ffprobe `r_frame_rate`** returns a fraction string (`"30000/1001"`) — must split on `/` and divide; never a decimal float.
- **Silence detection**: DJI clips have lots of near-silent sections (camera handling noise). Threshold `-30dB` with `d=0.5` works; may need tuning per footage type.

## FFmpeg — music looping

- **`asetpts=PTS-STARTPTS` must come before `atrim` when using `-stream_loop -1`** — with infinite loop, FFmpeg assigns continuously rising PTS values across loop boundaries. If `atrim=0:{duration}` runs first it sees inflated timestamps and may cut too early. Always reset timestamps first: `[1:a]asetpts=PTS-STARTPTS,atrim=0:{duration:.4f},...`. Wrong order produces silent music gaps at the expected trim point.
- **Do NOT use `-af apad` in normalise.py** — `apad` without an explicit `whole_dur` in a DJI HEVC normalise command causes normalise to hang indefinitely (10+ min, never completes). Root cause: DJI HEVC containers have unreliable or N/A duration headers; `-fps_mode cfr` + `apad` together cause FFmpeg to keep encoding frames past the real EOF waiting for the audio to close, which never happens. The correct fix for the audio/video duration mismatch (64–120ms per clip) is to apply `apad=whole_dur={video_dur}` per clip inside the filter_complex at the render/concat step — where the exact video duration is already known from `get_duration()`.
- **`aresample=async=N` worsens monotonic drift from CFR resampling** — `async` mode compensates drift by inserting/dropping audio samples. DJI HEVC decoded to 25fps CFR produces *monotonic* drift (same direction every clip); `async` fights it by inserting samples, creating audible pops/jumps rather than smooth drift. Do not use `aresample=async` for this class of drift. The correct fix requires reading `[sync-check]` log output to identify where drift enters (normalise → concat → music), then correcting timestamps at that specific step.
- **`volumedetect` mean_volume is unreliable on DJI wind-noise footage** — DJI clips with wind noise register mean_volume of -14 to -16 dBFS. Using this as a relative anchor (e.g. `clip_mean + offset_db`) pushes music to -26 to -28 dBFS at "balanced" preset — effectively inaudible. Use `loudnorm` integrated LUFS instead, or clamp the measured mean to a floor (e.g. -20 dBFS) before computing the offset.

## Lambda pipeline

- **Cards as pre-rendered video segments** — render intro/end cards as short H.264 clips before filter_complex. Avoids mixing lavfi sources with real clips inside a single filter_complex; cards pass through xfade unchanged.
- **Loudnorm timeout guard** — two-pass loudnorm adds ~2–4x real-time. Add `LAMBDA_TIMEOUT_BUFFER_S` env var (default 30s); check `context.get_remaining_time_in_millis()` before running and skip with WARNING if insufficient.
- **`run_local()` safe defaults** — synthetic job dicts must default all boolean config flags to `False` explicitly. Missing keys cause KeyError deep in the pipeline, not at the entry point.
- **Supabase REST from Lambda via `requests`** — use raw REST API with service role key (`apikey` + `Authorization: Bearer` headers); skip supabase-py. PATCH requires `Prefer: return=minimal` header.

## Python / tooling

- **`FFMPEG_BIN`/`FFPROBE_BIN` env vars** — hardcoding `/usr/local/bin/ffmpeg` blocks local testing without Docker. Read from env vars with Lambda-path as default; also makes CI flexible.
- **Windows console encoding** — `print()` on cp1252 chokes on `→`, `✅`, `❌`. Use `->`, `[PASS]`, `[FAIL]`.
- **WSL path mangling in Git Bash** — Git Bash rewrites paths starting with `/mnt/c/` to Windows paths when passed to `wsl`. Always invoke `wsl` commands from PowerShell; in Git Bash use `//mnt/c/` prefix as a workaround. **Claude Code's Bash tool runs in Git Bash** — every WSL call must be wrapped as `powershell.exe -Command "wsl -d Ubuntu-24.04 -u root -- ..."`. Glob wildcard patterns in PowerShell args also get expanded by Git Bash; use `cmd.exe /c tasklist ...` for process lookups.
- **PowerShell `Out-File` writes UTF-8 BOM** — Python's `json.loads()` raises `JSONDecodeError: Unexpected UTF-8 BOM` on any file written by PowerShell's `Out-File`. Write JSON files destined for Python via WSL (`cat > file` or `python3 -c "... write_text(...)"`) or use `[System.IO.File]::WriteAllText(path, content, (New-Object System.Text.UTF8Encoding $false))`. For test/debug manifests the cleanest pattern is: write via Python in WSL using `pathlib.Path(...).write_text(json.dumps(data))` — no escaping issues, no BOM, no Unicode escape errors with Windows paths (use raw strings: `r'C:\clips\...'`).
- **`bash -c 'pattern|pipe'` via PowerShell `-Command` mangles pipes** — `powershell.exe -Command "wsl -- bash -c 'grep -E \"foo|bar\" file'"` causes PowerShell to parse `|bar` as a PowerShell pipeline before the string reaches bash. Result: grep sees only `foo` and then tries to run `bar` as a command. Fix: use `python3 -c "import subprocess; r = subprocess.run(['grep', '-E', 'foo|bar', ...])"` inside WSL, or pass the grep pattern as a separate quoted arg without pipes if possible.
- **Pipeline package relative imports** — If `pipeline/*.py` modules use `from .module import ...`, the entry script (`run.py`) must add the *parent* directory of `pipeline/` to `sys.path`, then import as `from pipeline.render import run_pipeline`. Inserting `pipeline/` itself breaks all relative imports: Python treats `render` as a top-level module without a parent package.
- **`subprocess.run(cmd, check=True)` with list args** handles paths with spaces correctly; no `shell=True` needed.
- **WSL2 `/tmp/<job_id>/` accumulates 1-3 GB per render** — `render.py` creates `TMP_BASE / job_id` for normalised intermediates; they persist until WSL2 shuts down if not explicitly deleted. Fix: `shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)` in `run.py` immediately after `shutil.copy2` succeeds. Wrapup cleans crash orphans via `wsl -- sh -c 'rm -rf /tmp/*/'`. Proxies in `%APPDATA%\rushcut\proxies\` are a persistent cache — do NOT clean those.

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

## Proxy pipeline

- **Proxy encode timeout must be 600s, not 120s** — `subprocess.run(..., timeout=120)` is too short for 4K HEVC source clips longer than ~60s at software decode speeds. A 90-second 4K DJI clip with software HEVC decode takes 90–180s to encode to 480p H.264 ultrafast, depending on CPU load. Set `timeout=600` (10 min ceiling) in `generate_proxy()`. The timeout killing FFmpeg mid-write produces a corrupt file — see the moov-atom pattern below.
- **FFmpeg killed mid-write leaves a corrupt MP4 with missing moov atom** — if the proxy encode process is killed (timeout, SIGTERM, crash), FFmpeg writes partial data but never finalises the container header. The resulting file passes `Path.exists()` but `ffprobe -v quiet -show_format` returns exit code 1. `proxy.py` must validate existing files with `ffprobe` before skipping re-encode — a size check is insufficient (partial files can be several MB). Pattern: `if Path(proxy_wsl).exists() and not is_valid_proxy(proxy_wsl): Path(proxy_wsl).unlink(); generate_proxy(...)`.
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

## UX / timing feedback

- **Rolling inactivity timeout beats wall-clock timeout for long pipelines** — a hard `setTimeout(10min)` fires even when the pipeline is making steady forward progress, producing a false "timed out" error. Instead: start the timer on mount and reset it on each `pipeline-stage` event. Do NOT reset on every `pipeline-progress` tick — a hung pipeline that emits noisy progress would never time out. The timer fires only when no stage change has arrived for the full timeout window.
- **ETA countdown timers are unreliable for non-linear pipelines** — a remaining-time estimate based on `elapsed / progress * (100 - progress)` grows during slow pipeline stages (e.g. loudnorm), making it worse than nothing. Use a simple count-up elapsed timer instead (`useRef<number>(Date.now())` on component mount, tick every second). Users calibrate expectations from "it took 30s last time" not from a fluctuating estimate.
- **Start elapsed timer on mount, not on first progress event** — initialise `startTimeRef = useRef<number>(Date.now())` at declaration time so the counter starts at 0 immediately; initialising lazily (e.g. on first `progress > 0`) causes a visible delay before counting starts.

---

## UX / product decisions (locked)

- **Draft-first, configure-optional** — show the first render before any configuration. Mandatory configure screens before a draft add friction at the worst moment. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **StepIndicator = mandatory steps only** — optional pages (e.g. Configure as a drawer) must not appear as steps; they signal mandatory work that doesn't exist.
- **Lock copy before prompting Claude** — if copy isn't in the prompt, Claude invents it. Copy drift across pages wastes multiple correction rounds.
