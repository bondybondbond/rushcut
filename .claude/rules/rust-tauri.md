# Tauri / Rust rules

Applies when working on `src-tauri/**`.

## Commands

- All Tauri commands in a **single** `generate_handler![]`. A second `invoke_handler()` silently drops the first.
- JS `invoke("name")` must match Rust `fn name` exactly — mismatch is a runtime error, not a compile error.

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

## Cargo / PATH

After `winget install Rustlang.Rustup`, `cargo` is only available in new terminals. Existing shells: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`.
