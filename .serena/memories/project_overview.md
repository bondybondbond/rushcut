# RushCut — Project Overview

## Purpose
Local-first desktop video editor. Folder of clips -> AI-trimmed highlight reel.
No cloud upload required (pivot from Next.js/Supabase/Lambda in Batch 8).

## Tech Stack
- **Frontend:** React 19 + Vite + TypeScript (`src/`)
- **Backend:** Rust + Tauri 2.x (`src-tauri/`)
- **Pipeline:** Python 3 in WSL2 Ubuntu-24.04 (`pipeline/`)
- **DB:** SQLite via rusqlite (`%APPDATA%\rushcut\rushcut.db`)
- **UI:** Tailwind CSS + shadcn/ui + @dnd-kit (drag-and-drop)
- **Router:** react-router-dom (SPA, NOT Next.js)

## UX Flow
`/upload` -> `/editor/:projectId` -> `/output/:jobId`

## Current Batch: Batch 9
Building the full Tauri UX flow on top of Batch 8 scaffold.

## Key Paths
- Windows source clips: `C:\clips\`
- Output: `C:\clips\processed\<jobId>.mp4`
- WSL path prefix: `/mnt/c/`
- DB: `%APPDATA%\rushcut\rushcut.db`
