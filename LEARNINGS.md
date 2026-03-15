# LEARNINGS.md — rushcut

## 2026-03-15 — Batch 0 (pipeline spike)

### FFmpeg
- `xfade` transition name is `fade` not `crossfade` — `crossfade` raises "Not yet implemented in FFmpeg, patches welcome"
- `scale` filter must live inside `-filter_complex` when you're already using `-filter_complex`; using `-vf` alongside it causes "Simple and complex filtering cannot be used together for the same stream"
- Always specify `-c:v libx264 -pix_fmt yuv420p -profile:v main` explicitly in the concat step — omitting `-c:v` after `-filter_complex` can default to HEVC, which Windows can't play without codec packs (error 0x80004005)
- DJI OsmoPocket3: HEVC Main 10 (`yuv420p10le`), 1728×3072 portrait, 29.97fps — normalise to H.264 `yuv420p` 25fps CFR before any filter operations
- DJI files embed a 720×1280 MJPEG thumbnail as a second video stream — ffprobe reports two video streams; filter on codec name to get the real one
- `acrossfade` audio (not `crossfade`) — correct filter name for audio fade between clips in filter_complex

### Python / Windows subprocess
- Avoid Unicode in `print()` on Windows — cp1252 console chokes on `→`, `✅`, `❌`. Use `->`, `[PASS]`, `[FAIL]`
- `subprocess.run(cmd, check=True)` with list args handles paths-with-spaces correctly — no shell=True needed
- Run scripts from repo root (`C:\apps\rushcut`) — relative paths like `spike/tmp/` resolve from cwd, not script location

### Workflow
- Spike-first validated the hardest unknown (FFmpeg pipeline on DJI footage) in ~1 session before touching any infrastructure
- Draft render (360p CRF35 ultrafast) is genuinely useful for reviewing cuts/transitions — don't skip it
- Silence detection on DJI clips shows lots of near-silent sections (camera handling noise) — threshold tuning will be needed in Batch 3

## 2026-03-15 — Batch 1 (skeleton UI + copy/flow)

### UX / Flow
- **Draft-first, configure-optional**: showing the first render before any configuration is the highest-value UX move. Mandatory configure screens before a draft add friction at the worst moment — before the product has proved itself. Pattern: Upload → render with smart defaults → Preview → Configure only if user wants to tweak.
- **Lock copy before handing pages to Claude**: if copy isn't locked in the prompt, Claude invents its own. A copy-locked prompt (exact strings, no paraphrase) prevents copy drift across pages and saves multiple correction rounds.
- **Step indicator reflects actual user path, not technical structure**: StepIndicator should show the mandatory steps only. Optional/secondary pages (e.g. Configure as a drawer) must not appear as steps — they signal mandatory work that doesn't exist.
- **Re-render cost warnings belong at point-of-action**: showing "1 re-render included" on the Preview page (peak excitement moment) creates anxiety. Move it to the Configure page where the user is actually about to trigger a re-render.
