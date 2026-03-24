# Suggested Commands

## Dev
```
pnpm dev          # Tauri dev (runs Vite + Rust backend)
```
Requires `cargo` in PATH. If missing: `$env:PATH += ";$env:USERPROFILE\.cargo\bin"` in PowerShell.

## Build
```
pnpm build:vite   # Vite frontend only
cargo tauri build # Full Tauri production build
```

## Lint / Type-check
```
pnpm eslint src/  # ESLint
pnpm tsc --noEmit # TypeScript type check (no dedicated script — run manually)
```

## Pipeline (WSL2)
```
wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/run.py --job-id <uuid> --manifest-path <wsl_path>
wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/apps/rushcut/pipeline/scan.py --folder /mnt/c/clips/
```

## Git
```
git status
git add <files>
git commit -m "..."
```
Run from `C:\apps\rushcut`. ASCII only in commit messages.
