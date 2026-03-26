# LEARNINGS.md — rushcut

Pattern library. Organised by topic. Add to existing sections — do NOT add dated/batch headers.
Each bullet: problem in ≤1 sentence, fix in ≤2 sentences.

---

## FFmpeg — filter_complex

- **xfade transition name is `fade` not `crossfade`** — `crossfade` raises "Not yet implemented in FFmpeg". Use `xfade=transition=fade`. For dip-to-black use `xfade=transition=fadeblack` (native, no custom logic needed).
- **`scale` must be inside `-filter_complex`** — using `-vf` alongside `-filter_complex` on the same output stream raises "Simple and complex filtering cannot be used together". Append scale as the final step inside the filter chain.
- **Get durations from trimmed paths, not normalised paths** — xfade offset formula uses per-clip duration; if trim runs before transitions, re-run `get_duration()` on the trimmed files or offsets will be silently wrong.
- **Pairwise `acrossfade` breaks for 3+ clips** — chained acrossfade overlaps audio incorrectly for N>2. Use `acrossfade` only for exactly 2 clips; for 3+ use `concat=n={N}:v=0:a=1`.
- **xfade offset formula** (port verbatim from spike): `offset = cumulative + duration[i-1] - xfade_dur * i`

## FFmpeg — codec / output

- **Always specify `-c:v libx264 -pix_fmt yuv420p -profile:v main`** — omitting `-c:v` after `-filter_complex` can silently fall back to HEVC, which Windows Photos/Media Player rejects with error 0x80004005.
- **Single-clip shortcut**: use simple `-vf "scale=-2:360"` without `-filter_complex` — avoids needless complexity and the constraint that scale can't be in both `-vf` and `-filter_complex`.
- **`-map 0:a:0?` not `-map 0:a?`** — DJI clips can contain multiple audio streams; `0:a?` maps all of them. Always use the indexed form when normalising DJI footage.

## DJI OsmoPocket3

- **Dual video streams** — FFmpeg/ffprobe reports two video streams per file. Stream 0 is HEVC (real clip); stream 1 is an embedded MJPEG thumbnail. Use `-map 0:v:0` or `-select_streams v:0` to pin to the real stream.
- **Source format**: HEVC Main 10 (`yuv420p10le`), portrait (1728×3072), 29.97fps. Normalise to H.264 `yuv420p` 25fps CFR before any filter operations.
- **ffprobe `r_frame_rate`** returns a fraction string (`"30000/1001"`) — must split on `/` and divide; never a decimal float.
- **Silence detection**: DJI clips have lots of near-silent sections (camera handling noise). Threshold `-30dB` with `d=0.5` works; may need tuning per footage type.

## Lambda pipeline

- **Cards as pre-rendered video segments** — render intro/end cards as short H.264 clips before filter_complex. Avoids mixing lavfi sources with real clips inside a single filter_complex; cards pass through xfade unchanged.
- **Loudnorm timeout guard** — two-pass loudnorm adds ~2–4x real-time. Add `LAMBDA_TIMEOUT_BUFFER_S` env var (default 30s); check `context.get_remaining_time_in_millis()` before running and skip with WARNING if insufficient.
- **`run_local()` safe defaults** — synthetic job dicts must default all boolean config flags to `False` explicitly. Missing keys cause KeyError deep in the pipeline, not at the entry point.
- **Supabase REST from Lambda via `requests`** — use raw REST API with service role key (`apikey` + `Authorization: Bearer` headers); skip supabase-py. PATCH requires `Prefer: return=minimal` header.

## Python / tooling

- **`FFMPEG_BIN`/`FFPROBE_BIN` env vars** — hardcoding `/usr/local/bin/ffmpeg` blocks local testing without Docker. Read from env vars with Lambda-path as default; also makes CI flexible.
- **Windows console encoding** — `print()` on cp1252 chokes on `→`, `✅`, `❌`. Use `->`, `[PASS]`, `[FAIL]`.
- **WSL path mangling in Git Bash** — Git Bash rewrites paths starting with `/mnt/c/` to Windows paths when passed to `wsl`. Always invoke `wsl` commands from PowerShell; in Git Bash use `//mnt/c/` prefix as a workaround. **Claude Code's Bash tool runs in Git Bash** — every WSL call must be wrapped as `powershell.exe -Command "wsl -d Ubuntu-24.04 -u root -- ..."`. Glob wildcard patterns in PowerShell args also get expanded by Git Bash; use `cmd.exe /c tasklist ...` for process lookups.
- **PowerShell `Out-File` writes UTF-8 BOM** — Python's `json.loads()` raises `JSONDecodeError: Unexpected UTF-8 BOM` on any file written by PowerShell's `Out-File`. Write JSON files destined for Python via WSL (`cat > file` or `python3 -c "... write_text(...)"`) or use `-Encoding utf8NoBOM` in newer PowerShell.
- **Pipeline package relative imports** — If `pipeline/*.py` modules use `from .module import ...`, the entry script (`run.py`) must add the *parent* directory of `pipeline/` to `sys.path`, then import as `from pipeline.render import run_pipeline`. Inserting `pipeline/` itself breaks all relative imports: Python treats `render` as a top-level module without a parent package.
- **`subprocess.run(cmd, check=True)` with list args** handles paths with spaces correctly; no `shell=True` needed.

## Pipeline events — Tauri / React contract

## [Stage label clobber]
**Problem:** `pipeline-progress` Rust event includes a `stage` field (e.g. `"processing"`), which immediately overwrites the human-readable label set by the `pipeline-stage` event one line earlier.
**Solution:** `pipeline-progress` must only emit `{ jobId, progress }`. The `pipeline-stage` event exclusively owns the label; the React progress handler must only call `setProgress`, not `setStage`.
**Context:** `src-tauri/src/lib.rs` `run_pipeline()`, `src/pages/Output.tsx` progress listener.

## Tauri / Windows dev

- **Rustup PATH only applies to new terminals** — after `winget install Rustlang.Rustup`, `cargo` is available in newly opened terminals only. Existing CMD/PowerShell windows don't inherit the updated PATH. Fix for the current session: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`. Fix permanently: `[System.Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";$env:USERPROFILE\.cargo\bin", "Machine")` then reopen terminal.
- **`pnpm dev` = `tauri dev`** — this starts Vite (port 1420) then compiles Rust and opens the Tauri window. `pnpm dev:vite` alone starts only the React frontend; all `invoke()` calls throw "Cannot read properties of undefined (reading 'invoke')". The Preview MCP can connect to `:1420` for UI-layer testing, but no Tauri backend commands will work — use it only for layout/navigation/React state checks. Startup shows `[wsl_check] ok` in the terminal if WSL2 is available. A blank black window on first launch is expected until React routes are wired.
- **Tauri 2.x plugin permissions are runtime-only** — missing capability entries throw `not allowed` at runtime, not at compile time. Declare all needed permissions in `src-tauri/capabilities/default.json` (e.g. `"dialog:allow-open"` for the folder picker). `cargo check` passes silently even when permissions are missing.
- **Tauri plugin config: `null` not `{}`** — plugins with no options must be `"plugin-name": null` in `tauri.conf.json`. Using `{}` causes a deserialization panic at startup: `invalid type: map, expected unit`.
- **All Tauri commands must be in a single `generate_handler![]`** — only the last `invoke_handler()` call is registered. If you add a second `invoke_handler`, the first is silently dropped. Collect all commands in one list.
- **Tauri 2.x `invoke` command names must match exactly** — the JS `invoke("get_job_cmd")` string must match the Rust `#[tauri::command] fn get_job_cmd` name. Mismatches give a runtime "command not found" error, not a build error.
- **`convertFileSrc` is the only correct asset URL API on Windows** — constructing `asset://localhost/C:/clips/foo.mp4` manually produces URLs that Tauri 2.x rejects silently; the `<video>` element renders nothing. Import `convertFileSrc` from `@tauri-apps/api/core`; it outputs `https://asset.localhost/C:/clips/foo.mp4`. Always use it for any local file served to the WebView.
- **`run.py` must explicitly forward all `JobConfig` fields** — if a new field is added to the TypeScript `JobConfig` type but not added to the settings dict in `run.py`, the pipeline silently uses its own default (which may be wrong). Convention: every `JobConfig` field maps to one `settings.get(key, safe_default)` line in `run.py`.

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

## E2E Testing — Tauri + WebView2 + WDIO

## [WDIO BiDi reports stale about:blank for WebView2 attach mode]
**Problem:** WDIO v9 enables WebDriver BiDi by default; `browsingContext.getTree` returns `about:blank` even when CDP `/json/list` shows the correct URL — the BiDi protocol has a known mismatch with WebView2's CDP attach implementation.
**Solution:** Add `"wdio:enforceWebDriverClassic": true` to the capability. This disables BiDi and uses classic WebDriver protocol, which reads the correct URL.
**Context:** `wdio.conf.ts` capabilities block. Required any time msedgedriver attaches to an already-running WebView2 via `ms:edgeOptions.debuggerAddress`.

## [msedgedriver mid-navigation race resets renderer to about:blank]
**Problem:** Attaching msedgedriver to WebView2 while the app is still navigating (`about:blank` → `http://localhost:1420/`) permanently resets the renderer back to `about:blank` — WebDriver then returns `about:blank` for all subsequent `getUrl()` calls.
**Solution:** After verifying the CDP `/json/list` shows a non-blank URL, wait an additional static delay (6 seconds) before spawning msedgedriver. This ensures the React Router redirect (`/` → `/upload`) has fully completed before attachment.
**Context:** `wdio.conf.ts` `beforeSession` — the 6s delay sits between `checkTargets` resolving and `spawn("msedgedriver.exe")`.

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

## [Prefer debug binary over release for E2E; release binary is stale after source changes]
**Problem:** The release binary has the frontend embedded at build time. After adding `data-testid` attrs, a release binary built before those changes will fail all selector-based tests.
**Solution:** In `wdio.conf.ts`, check for the debug binary first (`src-tauri/target/debug/rushcut.exe`), fall back to release. Debug binary loads the frontend from the live Vite dev server and always reflects current source without a full `tauri build`.
**Context:** `wdio.conf.ts` `APP_PATH` / `usingDebug` constants.

---

## UX / product decisions (locked)

- **Draft-first, configure-optional** — show the first render before any configuration. Mandatory configure screens before a draft add friction at the worst moment. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **StepIndicator = mandatory steps only** — optional pages (e.g. Configure as a drawer) must not appear as steps; they signal mandatory work that doesn't exist.
- **Lock copy before prompting Claude** — if copy isn't in the prompt, Claude invents it. Copy drift across pages wastes multiple correction rounds.
