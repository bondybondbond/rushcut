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

## Cargo / PATH

After `winget install Rustlang.Rustup`, `cargo` is only available in new terminals. Existing shells: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"`.
