# Tauri / Rust rules

Applies when working on `src-tauri/**`.

## DB — SQLite datetime comparisons with chrono timestamps

Rust stores timestamps via `chrono::Utc::now().to_rfc3339()` as ISO 8601 (`"2026-06-06T20:12:11Z"`, T separator). SQLite `datetime('now', ...)` returns space-separated format (`"2026-06-06 20:12:11"`). Raw string comparison `created_at < datetime('now', '-N seconds')` **always fails** because `T` (ASCII 84) > ` ` (ASCII 32).

**Rule:** Always wrap the column: `datetime(created_at) < datetime('now', '-N seconds')`. SQLite `datetime()` normalises ISO 8601 input to its own format. This applies to every `WHERE created_at <` / `>` clause in `db.rs`. Detected only at runtime — `cargo check` and WDIO cannot catch it.

## Commands

- All Tauri commands in a **single** `generate_handler![]`. A second `invoke_handler()` silently drops the first.
- JS `invoke("name")` must match Rust `fn name` exactly — mismatch is a runtime error, not a compile error.
- JS invoke arg keys must match the `snake_case → camelCase` conversion of each Rust parameter name. Example: `fn update_clip_volume_cmd(clip_id: String, clip_volume: f64)` → `invoke("update_clip_volume_cmd", { clipId, clipVolume })`. Passing `{ volume }` instead of `{ clipVolume }` silently drops the call with "missing required key clipVolume" in the console — no compile-time error, easy to miss.

## `update_clip_review_cmd` — trim/zoom/focal save ONLY, never include state

`update_clip_review_cmd` persists per-clip review edits: `in_ms`, `out_ms`, `focal_x`, `focal_y`, `zoom_mode`, `clip_volume`. It also accepts `include` for technical reasons but **must never be the mechanism that changes a clip's `include` state**. Include state is owned exclusively by:
- `add_clip_cut_cmd` — sets `include=1` (adds a cut to the film)
- `delete_clip_cmd` — removes the `include=1` row (removes a cut from the film)

Source template rows (`include=0`) must never be flipped to `include=1` by `update_clip_review_cmd`. If the payload's `include` differs from the DB row, that is a bug in the caller — not a valid shortcut to add/remove a clip from the film. Defence-in-depth: any React `saveCurrentClip` should re-read canonical `include` from the top-level clips array (`clips.find(c => c.id === clip.id)?.include`) rather than trusting a possibly-decorated selected object. Root cause of V1.1 phantom-clip / pantry-undercount bugs.

## job-started event — emitted by start_job for Library live-update (T6)

`start_job` emits `"job-started"` (`{ jobId, projectId }`) immediately after `insert_job` succeeds and before `spawn`. This lets `Library.tsx` add the new job to its `jobsMap` without polling, so `pipeline-progress`/`done`/`error` events resolve correctly even if Library was already mounted before the render started. Emit point: after `.map_err(|e| ...)` on `insert_job`, before `let job_id_bg = job_id.clone()`. Both `job_id` and `project_id` are still owned at that point — neither is consumed until the `spawn` closure.

## setup() startup reset for stale proxy claims (Batch T7)

`setup()` calls `reset_all_encoding_claims(900)` (from `db.rs`) immediately after `db::init` succeeds. This resets `proxy_status='encoding'` rows whose `proxy_claimed_at` is older than 900s or NULL — covering crashes, kills, and WDIO SIGTERM. The 900s time-guard is **critical**: it prevents clobbering a live encode in the other binary (two-instances-share-one-DB). A row claimed within 15 min is never touched.

The `proxy_claimed_at INTEGER` column is stamped at claim time by `claim_clip_for_encoding` (the existing per-clip atomic claim). The startup reset is unconditional and synchronous — runs before the window shows, so no batch is ever in-flight in-process at that point.

`reset_proxy_encoding_cmd(project_id: String)` is the scoped per-project variant, called from the WDIO `after()` hook to clean up test projects.

## setup() must not block on slow system calls

`setup()` runs synchronously on the main thread. Blocking calls (e.g. `std::process::Command::new("wsl").arg("--status").output()`) stall the splash/spinner for the duration of the call — confirmed 5–7s on this machine. Move slow checks to `tauri::async_runtime::spawn` and emit the result as an event, or deferred to after the first window renders. The `app-ready` event should fire as soon as DB init is done; WSL availability can be checked lazily.

## Permissions & config

- Plugin commands must be declared in `src-tauri/capabilities/default.json`. Missing = `not allowed` at runtime (silent at compile/check time).
- Plugin config in `tauri.conf.json`: use `null` for no-option plugins. Using `{}` causes a deserialization panic at startup.
- **Check for existing plugin before adding a crate** — before adding `rfd` or similar, confirm `tauri-plugin-dialog` isn't already wired (`Cargo.toml` dep + `lib.rs` `.plugin(tauri_plugin_dialog::init())`). Already wired in this project with `dialog:allow-open` capability. Use `invoke("plugin:dialog|open", ...)` from TypeScript.
- **`window.confirm` is silently broken in Tauri WebView2** — every call is rejected unless `"dialog:allow-confirm"` is in `capabilities/default.json`. No throw, no visible error (unless DevTools is open) — the gate just silently passes (`undefined` is falsy, so `if (!window.confirm(...)) return` never blocks). Fix: use `import { confirm } from "@tauri-apps/plugin-dialog"` (async) + add `"dialog:allow-confirm"` to capabilities + rebuild binary. The plugin is already wired; only the capability entry was missing.
- **Capability changes require a binary rebuild** — editing `capabilities/default.json` has no effect until `cargo build` completes. Hot-reload (HMR) does NOT apply to Tauri capability manifests.

## DB

`%APPDATA%\rushcut\rushcut.db` — created automatically on first `pnpm dev`. Schema: `projects`, `clips`, `jobs` tables.

## open_output_path

Windows-only command. Uses `std::process::Command::new("explorer").arg(format!("/select,{}", path)).spawn()`.
Comment: `// windows-only: explorer /select reveals file in Windows Explorer`

## Asset protocol scope

`tauri.conf.json` → `app.security.assetProtocol.scope` must include every directory the WebView reads files from. Missing entries silently return `403` — no build error, no warning.

Current scope: `["$APPDATA\\rushcut\\**", "C:\\**", "D:\\**", "E:\\**"]`

- `$APPDATA\\rushcut\\**` — proxy files
- `C:\\**` / `D:\\**` / `E:\\**` — source clips and processed output on any common drive

Changes to this config require rebuilding the binary (`pnpm tauri build --debug` or `pnpm dev`).

## Managed state + async spawn

`tauri::State<'_, T>` is not `Send` and cannot be moved into `tauri::async_runtime::spawn(async move { ... })`. Pattern when `T = Arc<Mutex<...>>`:

```rust
// In run() builder, before .setup():
.manage(Arc::new(Mutex::new(HashSet::<String>::new())))

// In the command:
async fn my_cmd(state: tauri::State<'_, Arc<Mutex<HashSet<String>>>>, ...) {
    let guard = Arc::clone(&*state);  // clone before spawn — State is not Send
    tauri::async_runtime::spawn(async move {
        do_work().await;
        guard.lock().unwrap().remove(&id);  // cleanup
    });
}
```

`.manage()` must appear **before** `.setup()` in the builder chain (not after `.invoke_handler()`).

## Native Win32 splash (Windows-only)

Pattern for a borderless splash that appears before WebView2 initialises:

```rust
// splash.rs — #![cfg(target_os = "windows")]
// Uses windows crate 0.58 (Win32_UI_WindowsAndMessaging, Win32_Foundation, Win32_Graphics_Gdi, Win32_System_LibraryLoader)
// HWND type in 0.58: HWND(*mut core::ffi::c_void) — NOT isize
static SPLASH_HWND: AtomicUsize = AtomicUsize::new(0);

pub fn show() { std::thread::spawn(|| unsafe { /* CreateWindowExW WS_POPUP|WS_EX_TOPMOST|WS_EX_TOOLWINDOW */ }); }
pub fn hide() { PostMessageW(hwnd, WM_CLOSE, ...) }  // thread-safe async close
// WM_DESTROY: Box::from_raw(ptr) to drop heap state, then PostQuitMessage(0)
```

- `WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_POPUP` — borderless, always-on-top, no taskbar entry
- `AtomicUsize` stores `HWND.0 as usize` for cross-thread access; reconstruct as `HWND(val as *mut core::ffi::c_void)`
- `UpdateWindow` is absent in windows 0.58 — use `ShowWindow` + let `WM_TIMER`/`InvalidateRect` trigger first paint
- `WM_DESTROY` must call `Box::from_raw(GWLP_USERDATA ptr)` before `PostQuitMessage` — prevents heap leak every close
- `PostMessageW(WM_CLOSE)` from any thread triggers `KillTimer` + `DestroyWindow` on the splash thread

## visible: false + show from setup()

For splash-covered launch: set `"visible": false` in `tauri.conf.json` window config. Show in `setup()` immediately after db::init:

```rust
if let Some(win) = app.get_webview_window("main") { win.show().ok(); }
```

This keeps the window accessible to WebDriver (E2E) at all times while the native splash (topmost) covers it visually. `use tauri::Manager;` must be imported — `get_webview_window` is not available without it.

## spawn_blocking for blocking I/O in async

`tauri::async_runtime::spawn(async move { std::process::Command::new("wsl")... })` blocks an async pool thread. Wrap with `tokio::task::spawn_blocking`:

```rust
let ok = tokio::task::spawn_blocking(|| {
    std::process::Command::new("wsl").arg("--status")
        .output().map(|o| o.status.success()).unwrap_or(false)
}).await.unwrap_or(false);
```

## dataDirectory does not redirect WebView2 user data

Adding `"dataDirectory": "webview-data"` to a window in `tauri.conf.json` has no effect — the directory is never created and WebView2 ignores it. WebView2 already persists its cache to `%LOCALAPPDATA%\<identifier>\EBWebView` by default. Do not add this key.

## Cargo / PATH

After `winget install Rustlang.Rustup`, `cargo` is only available in new terminals. Existing shells: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`.

## cargo build from repo root silently ignores src-tauri/.cargo/config.toml

`src-tauri/.cargo/config.toml` holds MSVC `-L` lib paths (this machine's VC install only has `msvcrt.lib` under `lib\onecore\x64`, not the standard `lib\x64` path the linker expects). Cargo discovers config by walking up from the **current working directory**, not the manifest path. Running `cargo build --manifest-path src-tauri\Cargo.toml` from the repo root skips the config entirely → `LNK1104: cannot open file 'msvcrt.lib'`.

Fix: always run from inside `src-tauri/`, or pass `--config src-tauri\.cargo\config.toml` explicitly:
```
cargo build --manifest-path src-tauri\Cargo.toml --config src-tauri\.cargo\config.toml
```

## Proxy batch concurrency guard — one normal-priority boost per project

The `generate_proxies_cmd` concurrency guard uses a single `HashSet<String>` (state key = `project_id`). A normal-priority "boost" call is allowed through even when a low-priority batch is running — but only ONE boost should ever run at a time. React can fire the same invoke twice in rapid succession (strict-mode double-invoke, re-render during readiness poll); if two boosts both pierce the guard, three concurrent AMF sessions run and encode time inflates 3–5×.

Pattern: use a secondary key `{project_id}:normal` to track whether a boost is already active:
```rust
let boost_key = format!("{}:normal", project_id);
// inside the mutex lock:
if !low_priority {
    if set.contains(&boost_key) { return Ok(()); }  // already boosting — skip
    set.insert(boost_key.clone());
}
// On batch complete, remove BOTH keys:
s.remove(&pid);
s.remove(&format!("{}:normal", pid));
```

Symptom of the bug: `proxy-bg.log` shows two identical `batch-start` lines with `low_priority=false` at the same timestamp.

**This in-memory guard pattern was NOT sufficient for `start_job`'s single-in-flight-job guard (#89, fixed 2026-07-08).** `start_job` checked `get_active_job()` (a `SELECT`) then much later called `insert_job()` (a separate `INSERT`) with no transaction and no DB constraint between them — a check-then-insert race, not a check-then-set-in-memory-flag race. Confirmed live: three duplicate renders fired at once, spawned three concurrent 4K WSL pipelines, all died together from WSL memory pressure. Fixed with a DB-level constraint: `CREATE UNIQUE INDEX idx_jobs_active_per_project ON jobs(project_id) WHERE status IN ('pending','processing')` (added in `db::init()`, alongside a self-healing migration for any pre-existing duplicates), plus a `ConstraintViolation` catch in `start_job` that re-attaches to the winning job's id instead of erroring. Any new "prevent duplicate X" guard backed by SQLite needs the same DB-level constraint (unique index, or check+insert inside one transaction) — an in-memory `Mutex`/`HashSet` only closes the race when every caller path shares the same in-process guard state with no `await` between check and act.

## DB path — not Tauri's appDataDir

The DB lives at `%APPDATA%\rushcut\rushcut.db` (set by `dirs::data_dir()` in db.rs). Tauri's own `appDataDir()` returns `%APPDATA%\com.rushcut.app` — a different directory that does NOT contain the DB. Do not confuse them.

For cross-checks while the app is running, use `invoke("list_projects_cmd")` (or another Tauri command) via CDP rather than querying the sqlite file directly. The running app holds the DB open in WAL mode; an external sqlite3 process may see a stale pre-WAL snapshot — correct file, wrong data.

**In-session binary launches are MSIX-redirected to a different physical file.** When `rushcut.exe` is launched from inside a Claude Code session (`Start-Process`, WDIO, etc.), `%APPDATA%` is silently redirected by the MSIX container to `C:\Users\Manasak\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\rushcut\rushcut.db` — NOT the real `%APPDATA%\rushcut\rushcut.db` the user's own double-clicked `.exe` uses. `dirs::data_dir()` prints the logical path but reads/writes land in the container copy. Before seeding or verifying DB state in-session, target the container path explicitly. To verify behavior against what the real user launch will see, run the same SQL directly against the real Roaming path rather than relying on an in-session launch to touch it.

**PowerShell reads are ALSO virtualised, even outside an in-session binary launch.** Claude Code's own PowerShell tool runs inside the MSIX container, so `$env:APPDATA` in any PowerShell command resolves to the container's virtual Roaming path (a stale copy), never the real one — this applies even when checking the user's own separately-launched `.exe`. To cross-check the DB the user's own double-clicked binary actually uses, go through WSL with the absolute Roaming path instead: `wsl -- stat /mnt/c/Users/Manasak/AppData/Roaming/rushcut/rushcut.db`. A stat showing today's timestamp confirms the real file; `$env:APPDATA` will show a stale one.

**WSL `/mnt/c` reads of the DB can themselves be stale (separate from the WAL issue above).** The 9p protocol WSL uses to mount `/mnt/c` caches reads — a write made moments earlier (by WSL or Windows) is not guaranteed visible to a subsequent WSL read, even without the app open. Before trusting a WSL-side read of a recently-written `rushcut.db`, drop the 9p page cache: `wsl -u root -- sh -c "echo 1 > /proc/sys/vm/drop_caches"`. For authoritative reads, prefer running a script via `Start-Process` in the same OS context as the writer rather than reading through WSL.
