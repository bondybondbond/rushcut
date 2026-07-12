# Contributing to RushCut

Thanks for taking a look. This is a solo-built project opened up so others can use it and, ideally, help with the parts one person and one set of hardware can't solve alone (Nvidia/Intel GPU paths especially — see the README).

## Local dev setup

1. **Requirements**: Windows 11, WSL2 (Ubuntu distro) with `python3` + Pillow, FFmpeg installed both inside WSL2 *and* as a Windows-native `ffmpeg.exe` on your `PATH`, Node.js + pnpm, Rust (stable).
2. `pnpm install`
3. `pnpm dev` — starts Vite, compiles the Rust backend, opens the Tauri window. This is the only way to get a working app: `pnpm dev:vite` alone builds the UI but every `invoke()` call to the backend fails silently.
4. The render pipeline runs as a subprocess: Rust spawns `wsl -d <distro> -u root -- python3 pipeline/run.py --job-id <uuid> --manifest-path <path>`. If you're only working on the UI, you don't need to touch this directly — but if a render fails, `pipeline-latest.log` (written under WSL2, path in `.claude/rules/pipeline.md`) is the first place to look.
5. The SQLite DB lives at `%APPDATA%\rushcut\rushcut.db`, created automatically on first `pnpm dev`.

For anything pipeline/FFmpeg-specific — encoder quirks, WSL path gotchas, the segmented-render architecture — read `.claude/rules/pipeline.md` before diving in. It's dense but current.

## Conventions

- **Measure before you fix.** Several perf/quality issues in this repo were closed `NO-GO` after a real measurement contradicted the initial hypothesis (see `docs/LEARNINGS.md` and `docs/speed-goal.md`). If you're proposing a performance or quality change, include real numbers from this pipeline, not a general assumption about what "should" be faster.
- **Don't re-propose a closed NO-GO without new evidence.** If an issue or `docs/LEARNINGS.md` entry says something was tried and didn't work, re-litigating it needs a concrete reason the situation has changed (different hardware, different FFmpeg version, etc.) — not just "have you tried X."
- **Logs first.** For anything involving A/V sync, render timing, or encoder behavior, read the actual pipeline log output before writing a fix. `docs/LEARNINGS.md` has a running pattern library of FFmpeg/WSL/pipeline gotchas already hit once — check it before spending time rediscovering one.
- **Small, focused PRs.** This is a young open-source project with one maintainer reviewing; a PR that does one thing is much easier to merge than one that also refactors nearby code.

## Where to start

Issues labeled [`good first issue`](https://github.com/bondybondbond/rushcut/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped to not require deep pipeline history to pick up. If you want to tackle something bigger (the Nvidia/Intel GPU encode gap, for example), open an issue first to discuss approach before sinking real time into it.

## Reporting bugs

Include: what you did, what you expected, what happened, and — if it's a render/quality issue — the relevant lines from `pipeline-latest.log` if you can find them. "It's slow" or "quality looks bad" without a comparison point (source footage, another tool's output, a specific timestamp) is hard to act on.
