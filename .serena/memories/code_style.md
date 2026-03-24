# Code Style & Conventions

## General
- ASCII only in UI copy and console output — no Unicode arrows, no emojis (cp1252 compat)
- No hardcoded `C:\clips` paths — use constants or config
- Tauri 2.x patterns only — NOT Next.js, NOT Supabase, NOT AWS SDK

## TypeScript / React
- Functional components, hooks
- Props interfaces defined inline or exported from types file
- Path alias: `@/` maps to `src/`
- shadcn/ui + Tailwind for UI
- react-router-dom for routing (BrowserRouter in main.tsx)

## Rust
- All Tauri commands registered in a SINGLE `generate_handler![]` call
- Path translation Windows->WSL in Rust: strip drive+colon, lowercase, prepend `/mnt/`, replace `\` with `/`
- DB helpers in `src-tauri/src/db.rs`; commands in `src-tauri/src/lib.rs`

## Python (pipeline)
- WSL2 Ubuntu-24.04, Python 3
- FFmpeg at `/usr/bin/ffmpeg`
- Always `-map 0:v:0` for DJI files
- Always `-c:v libx264 -pix_fmt yuv420p -profile:v main`
- Progress stdout: `PROGRESS:N`, `DONE:/mnt/c/...`, `ERROR:msg`

## Tauri Events
```json
{ "jobId": "...", "stage": "...", "progress": 42, "message": "...", "outputPath": null }
```
Events: `pipeline-progress`, `pipeline-done`, `pipeline-error`
