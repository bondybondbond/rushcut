# Tauri / Rust rules

Applies when working on `src-tauri/**`.

## Commands

- All Tauri commands in a **single** `generate_handler![]`. A second `invoke_handler()` silently drops the first.
- JS `invoke("name")` must match Rust `fn name` exactly — mismatch is a runtime error, not a compile error.
- JS invoke arg keys must match the `snake_case → camelCase` conversion of each Rust parameter name. Example: `fn update_clip_volume_cmd(clip_id: String, clip_volume: f64)` → `invoke("update_clip_volume_cmd", { clipId, clipVolume })`. Passing `{ volume }` instead of `{ clipVolume }` silently drops the call with "missing required key clipVolume" in the console — no compile-time error, easy to miss.

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

## DB path — not Tauri's appDataDir

The DB lives at `%APPDATA%\rushcut\rushcut.db` (set by `dirs::data_dir()` in db.rs). Tauri's own `appDataDir()` returns `%APPDATA%\com.rushcut.app` — a different directory that does NOT contain the DB. Do not confuse them.

For cross-checks while the app is running, use `invoke("list_projects_cmd")` (or another Tauri command) via CDP rather than querying the sqlite file directly. The running app holds the DB open in WAL mode; an external sqlite3 process may see a stale pre-WAL snapshot — correct file, wrong data.
