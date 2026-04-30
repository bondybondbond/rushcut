# Tauri / Rust rules

Applies when working on `src-tauri/**`.

## Commands

- All Tauri commands in a **single** `generate_handler![]`. A second `invoke_handler()` silently drops the first.
- JS `invoke("name")` must match Rust `fn name` exactly — mismatch is a runtime error, not a compile error.

## setup() must not block on slow system calls

`setup()` runs synchronously on the main thread. Blocking calls (e.g. `std::process::Command::new("wsl").arg("--status").output()`) stall the splash/spinner for the duration of the call — confirmed 5–7s on this machine. Move slow checks to `tauri::async_runtime::spawn` and emit the result as an event, or deferred to after the first window renders. The `app-ready` event should fire as soon as DB init is done; WSL availability can be checked lazily.

## Permissions & config

- Plugin commands must be declared in `src-tauri/capabilities/default.json`. Missing = `not allowed` at runtime (silent at compile/check time).
- Plugin config in `tauri.conf.json`: use `null` for no-option plugins. Using `{}` causes a deserialization panic at startup.

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

## Serena MCP (symbol-level navigation)

For large Rust files (`lib.rs`, `db.rs`), prefer Serena over full-file reads:
- `mcp__serena__get_symbols_overview` — list all functions/structs without loading the file
- `mcp__serena__find_symbol` with `include_body=true` — read one function only
- `mcp__serena__find_referencing_symbols` — find all callers before refactoring

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

## Cargo / PATH

After `winget install Rustlang.Rustup`, `cargo` is only available in new terminals. Existing shells: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`.
