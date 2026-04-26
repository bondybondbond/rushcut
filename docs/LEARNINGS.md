# LEARNINGS.md — rushcut

Pattern library. Organised by topic. Add to existing sections — do NOT add dated/batch headers.
Each bullet: problem in ≤1 sentence, fix in ≤2 sentences.

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

- **Smart Normalise Cache (Batch 14e / future): 1080p proxies as normalise intermediates** — the 3-min normalise step is the dominant render cost. Hardware acceleration is non-viable (WSL2 `/dev/dxg` present but `VK_KHR_video_decode_queue` not supported; CUDA/VDPAU absent — confirmed Batch 13c). The achievable speedup is to generate 1080p H.264 proxies that match normalise.py's output spec exactly (`-c:v libx264 -pix_fmt yuv420p -profile:v main -preset ultrafast -ar 48000`) during the idle post-render window, then skip normalise entirely in render.py for clips that already have a cached intermediate. This shifts ~3 min of work out of the critical render path for repeat renders. Trade-off: 1080p intermediates are ~4× larger than 720p playback proxies; may need separate "playback proxy" (720p) and "normalise cache" (1080p) concepts, or accept that RushCut's proxy files are intermediates rather than true lightweight proxies.
- **Concurrent FFmpeg in WSL2 causes contention** — proxy generation fired immediately at project create ran concurrently with the render pipeline (normalise + render), adding ~90s to a 5-min render. Fix: fire proxy generation only after `pipeline-done`. Never start a WSL2 FFmpeg background task while a render is in progress.
- **WSL2 HEVC normalise is I/O-bound, not CPU-bound** — running N FFmpeg normalise processes concurrently (e.g. via `ProcessPoolExecutor`) does not speed up normalisation; it makes it slower (90s → 3 min on 3×4K clips) because all processes contend for the same NTFS-via-WSL2 filesystem reads. The bottleneck is disk I/O. Do not retry parallelisation without profiling disk throughput first. The real win is reducing the per-clip work (e.g. draft proxy copy rather than full H.264 transcode).
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
- **PowerShell `Out-File` writes UTF-8 BOM** — Python's `json.loads()` raises `JSONDecodeError: Unexpected UTF-8 BOM` on any file written by PowerShell's `Out-File`. Write JSON files destined for Python via WSL (`cat > file` or `python3 -c "... write_text(...)"`) or use `-Encoding utf8NoBOM` in newer PowerShell.
- **Pipeline package relative imports** — If `pipeline/*.py` modules use `from .module import ...`, the entry script (`run.py`) must add the *parent* directory of `pipeline/` to `sys.path`, then import as `from pipeline.render import run_pipeline`. Inserting `pipeline/` itself breaks all relative imports: Python treats `render` as a top-level module without a parent package.
- **`subprocess.run(cmd, check=True)` with list args** handles paths with spaces correctly; no `shell=True` needed.
- **WSL2 `/tmp/<job_id>/` accumulates 1-3 GB per render** — `render.py` creates `TMP_BASE / job_id` for normalised intermediates; they persist until WSL2 shuts down if not explicitly deleted. Fix: `shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)` in `run.py` immediately after `shutil.copy2` succeeds. Wrapup cleans crash orphans via `wsl -- sh -c 'rm -rf /tmp/*/'`. Proxies in `%APPDATA%\rushcut\proxies\` are a persistent cache — do NOT clean those.

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

## UX / timing feedback

- **Rolling inactivity timeout beats wall-clock timeout for long pipelines** — a hard `setTimeout(10min)` fires even when the pipeline is making steady forward progress, producing a false "timed out" error. Instead: start the timer on mount and reset it on each `pipeline-stage` event. Do NOT reset on every `pipeline-progress` tick — a hung pipeline that emits noisy progress would never time out. The timer fires only when no stage change has arrived for the full timeout window.
- **ETA countdown timers are unreliable for non-linear pipelines** — a remaining-time estimate based on `elapsed / progress * (100 - progress)` grows during slow pipeline stages (e.g. loudnorm), making it worse than nothing. Use a simple count-up elapsed timer instead (`useRef<number>(Date.now())` on component mount, tick every second). Users calibrate expectations from "it took 30s last time" not from a fluctuating estimate.
- **Start elapsed timer on mount, not on first progress event** — initialise `startTimeRef = useRef<number>(Date.now())` at declaration time so the counter starts at 0 immediately; initialising lazily (e.g. on first `progress > 0`) causes a visible delay before counting starts.

---

## UX / product decisions (locked)

- **Draft-first, configure-optional** — show the first render before any configuration. Mandatory configure screens before a draft add friction at the worst moment. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **StepIndicator = mandatory steps only** — optional pages (e.g. Configure as a drawer) must not appear as steps; they signal mandatory work that doesn't exist.
- **Lock copy before prompting Claude** — if copy isn't in the prompt, Claude invents it. Copy drift across pages wastes multiple correction rounds.
