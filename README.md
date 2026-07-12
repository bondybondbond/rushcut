# RushCut

A Windows desktop app for recreational filmmakers who find DaVinci Resolve and Premiere Pro too complex for what they actually want to do: turn a folder of raw clips into a watchable film. Trim, add transitions, apply Ken Burns zoom, add music, and export — all with button presses, no timeline scrubbing.

Built solo, originally as a personal tool for cutting drone/action-camera footage (DJI Osmo Pocket). Published as open source because it's useful as-is, even though it hasn't hit every original target — see [Known limitations](#known-limitations) below.

---

## What this is

- Upload a folder of clips → trim each one → arrange with transitions and music → render.
- Full local processing — no cloud, no upload, no account. Your footage never leaves your machine.
- Built for the common case (a handful of DJI/phone clips, want a shareable film in an evening), not for frame-accurate professional editing.

## What this is not

- **Not a professional editor.** No multi-track timeline, no color grading, no keyframe-level control beyond per-clip zoom/focal point.
- **Not real-time.** There's no live preview scrubbing across the full timeline the way a pro NLE has — you trim per-clip, then render.
- **Not fast.** Renders take 3–10+ minutes depending on project size and resolution. This is a leave-it-running tool, not an instant-export tool. See [Known limitations](#known-limitations).

---

## Requirements

- **Windows 11** (uses Win32-specific APIs; not cross-platform)
- **WSL2** with an Ubuntu distro (the render pipeline runs as Python inside WSL2, python3 + Pillow)
- **FFmpeg** installed in both places: inside your WSL2 distro, and as a Windows-native `ffmpeg.exe` on your Windows `PATH` (the two are used for different pipeline steps)
- **AMD GPU** recommended for hardware-accelerated encoding (AMF). Falls back to CPU encoding (libx264) automatically if AMF isn't available — slower, but works on any hardware including Nvidia/Intel.
- **Node.js + pnpm**, **Rust** (stable toolchain) for building the app itself

## Quick start

```bash
git clone https://github.com/bondybondbond/rushcut.git
cd rushcut
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite dev server, compiles the Rust backend, and opens the Tauri desktop window — this is the only way to run the app with working functionality (`pnpm dev:vite` alone will build the UI but every backend call will fail).

First run: point it at a folder of video clips, trim each one, arrange them on the Arrange screen, optionally add music on the Sound screen, then render. First render on a fresh machine will be slower while background proxy generation and the AMF hardware probe warm up.

## Known limitations

- **Render speed.** A cold render (no cached proxies) can take 10+ minutes; a warm re-render of a typical 6–9 clip project is closer to 3–5 minutes. The bottleneck is decode + compositing time in the FFmpeg pipeline, not the final encode — see `docs/speed-goal.md` for the full investigation and dead ends already ruled out before you re-propose a fix.
- **AMD-only hardware acceleration today.** The GPU encode path (AMF) is built and tested on AMD only. Nvidia (NVENC) and Intel (QSV) paths don't exist yet — if you're on Nvidia hardware, you're on the CPU (libx264) fallback, which is slower but fully functional.
- **HEVC playback depends on a Windows extension.** Some source footage (e.g. DJI HEVC) needs the Microsoft HEVC Video Extension installed for in-app preview; without it, RushCut falls back to the raw file automatically, but preview scrubbing is less smooth.
- **1080p quality parity with 4K is unverified.** Recent quality work (CQP encoding) has been tuned and TV-checked primarily against 4K DJI footage; 1080p sources haven't had the same verification pass.
- **Zoomed (Ken Burns) footage looks softer than non-zoomed footage.** Noticed during the CQP TV-check — likely in the zoom filter chain's scaling, not the encoder. Under investigation, tracked in the issues.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup and conventions. Issues labeled [`good first issue`](https://github.com/bondybondbond/rushcut/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped to be approachable without deep pipeline history.

Two problems in particular could use outside eyes:
- **Nvidia/Intel GPU encode support** — the AMF path is AMD-specific; someone with different hardware is better positioned to build and test the equivalent NVENC/QSV path.
- **GPU decode** (tracked in the issues) — the render pipeline currently decodes on CPU; probing whether Windows-native `ffmpeg.exe`'s hardware decode helps is a self-contained, well-scoped investigation.

---

## Repo structure

```
rushcut/
  src/            React + Vite renderer (the UI)
  src-tauri/      Rust backend (Tauri 2.x) — SQLite DB, process orchestration
  pipeline/       Python render pipeline, runs inside WSL2
  e2e/            WebdriverIO end-to-end tests
  docs/           DESIGN.md, LEARNINGS.md (pipeline pattern library), PRD-DEV.md (roadmap)
  scripts/        One-off dev/diagnostic scripts
```

`CLAUDE.md` (repo root) has the full architecture rundown and is kept current — worth a read if you're digging into internals or using an AI coding assistant against this repo.
