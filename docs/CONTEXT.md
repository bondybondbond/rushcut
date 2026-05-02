# RushCut — Sprint Context

> This file tracks current focus, in-progress work, and immediate next steps.
> Updated at the end of every session by the wrapup skill.

---

## PIVOT — LOCAL BUILD (decided end of Batch 7)

**Root cause:** 30 Mbps upload -> 1.9 GB clip = ~8 min upload; 19 GB session = ~84 min. Unusable.
**New model:** Pipeline runs locally via WSL2. No uploads. No Lambda. Browser UI unchanged.
**Full pivot spec:** See `CLAUDE.md` -> "MAJOR PIVOT" section at the top.

---

## Current Phase

**Phase 2 — Batch B Run 1 complete. Next: Batch B Run 2 (4K chip, custom music, render resize).**

---

## Immediate Next Task

**Batch B Run 2:** 4K export chip on Render screen, custom music upload (rfd dialog), render screen video resize handle. Start in a fresh chat with the plan file: `C:\Users\Manasak\.claude\plans\run-dev-plan-skill-wise-cascade.md` (Run 2 section).

**Batch B Run 1 — Pipeline perf + music ducking (2026-05-02):**
- B-0 pre-trim: render.py copy-trims each clip to `[in_s-2s, out_s+0.5s]` before normalise → files land in WSL2 tmpfs. Biggest single speedup: 10 min → ~3 min for 1m26s DJI 4K film.
- Parallel normalise: `ThreadPoolExecutor(max_workers=min(4, os.cpu_count()))` in normalise.py. Per-worker `-threads N` cap. 4 workers, 10 clips → 80s (floor = 4K HEVC software decode speed).
- Render preset: `slow` → `medium` (-25s on 86s film).
- Music ducking: `_build_filter()` ducks movie audio by `movie_vol` before amix. Prominent = movie at 0.3×, music at 0.7× → music clearly dominates.
- Proxy reuse candidate flagged (Batch C): using H.264 1080p proxies as normalise input would cut 80s → ~20-30s.

**Startup performance — DONE (Batch A4, 2026-05-02):**
- Native Win32 splash visible ~200ms from binary launch (covers WebView2 cold start entirely)
- Async WSL check — no longer blocks `setup()`; `app-ready` fires as soon as db::init completes
- Repeat launch: ~2-3s (user-confirmed)
- `pnpm dev` is NOT the test vehicle — use `pnpm dev:vite` + direct binary double-click

**Post-15g deferred items (candidate for Batch 16):**
- Sticky filmstrip in bottom nav — updates across all screens as clips are added; render CTA lives in it
- Format selector on Render screen — 4K output, file-size presets, codec choice
- Music preview (30s loop on chip select) + Transition preview (CSS loop demo) — ship together
- Edit screen rename: `/transitions/` → `/edit/` when text cards ship; StepNav "Transitions" → "Edit"

---

## Recently Completed

**Batch A4 — Native Splash + Async WSL (2026-05-02)**

- `src-tauri/src/splash.rs` (new): Win32 borderless splash. `WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_POPUP`, GDI paint (`#0a0a0a` bg, "RushCut" Segoe UI Semibold 42pt, green progress bar), 50ms timer, `AtomicUsize` HWND cross-thread, `PostMessageW(WM_CLOSE)` async hide.
- `src-tauri/Cargo.toml`: `windows = "0.58"` Windows-platform dep (4 features).
- `src-tauri/tauri.conf.json`: `"visible": false` — window starts hidden, covered by native splash.
- `src-tauri/src/lib.rs`: `mod splash`; `splash::show()` before `tauri::Builder`; `setup()` calls `win.show()` (E2E compat) + async WSL with `spawn_blocking`; `confirm_app_loaded` command calls `splash::hide()` from React mount.
- `src/App.tsx`: `invoke("confirm_app_loaded")` in first `useEffect` — closes splash when React mounts.
- `src/main.tsx`: fallback reduced 5000ms → 500ms (async WSL fires `app-ready` ~50ms after binary start, before React loads).
- Result: ~2-3s repeat launch (user-confirmed). Native splash visible within ~200ms. Single unified loading experience (no two-window flash).
- E2E: 7/7 fast PASS.

**Batch A — Trimmer Core (2026-04-30)**

- **A1 — Multi-cut:** Source rows permanently `include=0` (pantry templates). Each "Add to Film" click INSERTs a new `include=1` cut row via `add_clip_cut_cmd`. `delete_clip_cmd` DELETEs cut rows (source stays in pantry). Duplicate handles guarded with toast. `MediaPantry` filters to `include===0` rows only.
- **A2 — Trim-selection loop:** Removed `loop` attribute from `<video>`. `onTimeUpdate` guard seeks back to `inMs` when `currentMs >= outMs`.
- **A3 — Splash screen (Step E):** Inline `#rc-splash` overlay in `index.html` (appears immediately on WebView2 load). Rust emits `app-ready` after db init + WSL check. React removes overlay on event; 5s timeout fallback. Second Tauri splash window removed from `lib.rs`.
- `docs/DESIGN.md`: Toast/snackbar pattern documented.
- `wdio.conf.ts`: `before` hook comment updated (second window removed, guard now no-op).
- E2E: 7/7 fast PASS · 12/12 trimmer PASS.

**Batch 15g — Render screen (2026-04-29)**

- `src/pages/Render.tsx` (new): `/render/:projectId`. Auto-starts render on mount — no idle phase, no "Render Film" button. Phase state machine: `"starting" | "rendering" | "done" | "error"`. `buildConfig()` reads `rc_transition_` + `rc_sound_` sessionStorage. Progress bar (green), stage label, elapsed timer, 10-min inactivity timeout. Done state: video player, output filename, Open in Explorer, My Projects. Error state: Try Again (if clips > 0).
- `src/App.tsx`: `/render/:projectId` route added; `/editor/` and `/output/` routes removed.
- `src/pages/Sound.tsx`: CTA updated to navigate to `/render/` (was `/editor/`).
- `src/pages/Library.tsx`: rename (pencil + inline input) added. Processing projects route to `/trimmer/` (was `/output/`).
- `src/pages/Review.tsx`: 3× `navigate('/editor/${projectId}')` changed to `/trimmer/`.
- Deleted: `src/pages/Editor.tsx`, `src/pages/Output.tsx`, `src/components/editor/SettingsPanel.tsx`, `src/components/editor/TimelineStrip.tsx`.
- `e2e/render.spec.ts` rewritten: full Upload→Trim→Transitions→Sound→Render pipeline flow. `btn-render-film` tests removed (auto-start). Duration threshold `> 3` (1 clip = ~7s output). 15/15 PASS in 2m 37s.
- `wdio.conf.ts`: `/render/` added to `waitForAppRoute()`.

**Batch 15f — Sound screen (2026-04-28)**

- `src/pages/Sound.tsx` (new): `/sound/:projectId` route. Music mood chips (No Music / Cinematic / Upbeat / Chill / Electronic) + conditional volume chips (Subtle / Balanced / Prominent, hidden when mood = "none"). `sessionStorage` key `rc_sound_${projectId}` stores JSON `{ mood, volume }`. StepNav `active="sound"`, CTA "Next: Render →" bridges to `/editor/` until 15g ships.
- `src/App.tsx`: `/sound/:projectId` route + `Sound` import added.
- `src/pages/Transitions.tsx`: CTA `onNext` updated to navigate to `/sound/${projectId}` (was `/editor/`). Footer text updated.
- `src/pages/Editor.tsx`: `VALID_MOODS`, `VALID_VOLUMES`, `VALID_TRANSITIONS` const arrays; `setConfig` seeded from `rc_transition_${projectId}` + `rc_sound_${projectId}` sessionStorage on project load. Strict `.includes()` validation guards.
- `wdio.conf.ts`: `/transitions/` and `/sound/` added to `waitForAppRoute()` URL check list.
- `e2e/sound.spec.ts` (new): 13 assertions — load, URL, heading, StepNav, screenshots A/B/C, chip presence, default active, volume hidden/shown, sessionStorage persistence, reload restore.
- `package.json`: `test:e2e:sound` script added.
- `docs/DESIGN.md`: Conditional chip row pattern documented (Sound screen).
- E2E: 13/13 sound PASS · 12/12 transitions PASS · 7/7 fast PASS.

**E2E spec debt + UX fixes (2026-04-26)**

- `e2e/trimmer.spec.ts`: All 3× `$("body").getHTML(false)` replaced with `browser.execute(() => document.body.textContent ?? "")`. "In Film" assertion (removed in Batch 16b C3) updated to "Total" (FilmStrip duration label). `// TODO` comment added to `pushState` block explaining the permitted exception. 12/12 PASS.
- `e2e/gap-editor.spec.ts`: Full rewrite as "Trimmer via real navigation" — `before()` drives real UI (hamburger → My Projects → "Open project"), waits for `/trimmer/` (was `/editor/`). All Editor-specific assertions replaced with 5 Trimmer assertions. 5/5 PASS.
- `src/pages/Editor.tsx`: Back button `navigate("/library")` → `navigate(projectId ? \`/trimmer/${projectId}\` : "/library")` — user returns to same project's Trimmer, not library.
- `src/components/StepNav.tsx`: Breadcrumb text colours corrected — past steps `#e5e5e5` (was `/70` opacity), future steps `#a3a3a3` (was `/20` opacity), separators `#555555` flat. No opacity tricks.
- `wdio.conf.ts`: `/trimmer/` added to `waitForAppRoute()` URL check list.
- `e2e.md` rules: "Known stale specs" cleared; "No pushState in before() hooks" rule added; `getHTML(false)` rule generalised to all specs.
- `docs/DESIGN.md`: StepNav breadcrumb pattern added (flat hex tokens, no opacity).

**Editor screen display fix (2026-04-26)**

- `src/pages/Editor.tsx`: `setClips` now filters `c.include != 0` — excluded clips no longer appear in the Editor clip strip.
- `src/components/editor/TimelineStrip.tsx`: duration badge now shows `out_ms - in_ms` when both are set, falling back to `duration_ms` when no trim data. Fixes raw durations being shown for trimmed clips.

**Batch 15c remaining (C4 + C5) — TrimBar seek + playhead pip (2026-04-26)**

- `src/components/trimmer/TrimBar.tsx`: `onSeek?: (ms: number) => void` prop added. `onTrackClick` changed to seek-only — no longer moves handles. Playhead thickened from `w-0.5` (2px) to `w-1` (4px). Triangle pip added above track (`top: -8px`, CSS border triangle, `rgba(255,255,255,0.8)`). Hint text updated to "Click to seek · drag handles to trim · saves on release". `didDrag` ref guard suppresses seek after handle drag-end.
- `src/pages/Trimmer.tsx`: `handleSeek(ms)` added — sets `videoRef.current.currentTime = ms / 1000` + `setCurrentMs(ms)`. `onSeek={handleSeek}` wired to `<TrimBar>`.
- E2E: 7/7 fast PASS. 10/12 trimmer (2 pre-existing getHTML timeouts). 0/1 editor (pre-existing /editor/ URL regression since Batch 15a).

**Batch 16 + 16b — Native FFmpeg + Source-First Playback (2026-04-26)**

- `src-tauri/src/lib.rs`: Full Rust native scan (ffprobe) and proxy pipeline — no WSL Python for media work. `detect_best_encoder()` with `OnceLock` — one-time GPU probe (`h264_nvenc → h264_qsv → h264_amf → libx264`). `run_media_batch` (thumbnail + waveform upfront only). `run_single_proxy` + `generate_proxy_for_clip` Tauri command — lazy per-clip proxy gen on demand.
- `src-tauri/src/db.rs`: `codec_name TEXT` additive migration; `Clip` struct + `get_project_with_clips` extended to 20 cols.
- `src/pages/Trimmer.tsx`: Source-first `src = proxy_path ?? local_path`. `onError` triggers lazy proxy gen gated by `generatingProxyRef`. `proxy-progress` listener (with `unlisten`) clears `sourceFailed` when proxy ready. Badge shows only on source failure + no proxy. 4s poll removed — event-driven. C2 (overflow-y-auto on right aside), C3 (always-active Add to Film), C6 (resizable video with pointer drag handle).
- `src/pages/Upload.tsx`: `waveform_data: null` added to `metaToClip`.
- GPU encoder fallback: nvenc → qsv → amf → libx264. HEVC clips with HEVC Video Extension play instantly at native resolution; without extension ~3-5s GPU encode on demand.

**Batch 15c Package 2 — UX fixes (2026-04-25)**

- `pipeline/proxy.py`: waveform: `s=800x80` (was 120×80), `scale=cbrt` with two-pass `volumedetect` normalization (boost by -peak_db so loudest = 0 dBFS = full bar height, capped at 40 dB). Codec-aware proxy: H.264/VP8/VP9 sources → emit `PROXY` with source path (WebView2 native, instant); HEVC/unknown → transcode 480p H.264.
- `src-tauri/src/db.rs`: `get_project_output_paths()` — queries `local_output_path` from `jobs` for a project.
- `src-tauri/src/lib.rs`: `delete_project_cmd` — calls `get_project_output_paths` + `remove_file` (best-effort) before DB rows deleted. Concurrency guard: `Arc<Mutex<HashSet<String>>>` managed state; `generate_proxies_cmd` skips duplicate calls for in-progress projects.
- `src/pages/Library.tsx`: `pendingDelete` state replaces `window.confirm()` (which is silently swallowed by WebView2). Inline confirmation panel per row; copy describes whether a render file will be removed.
- `src/pages/Upload.tsx`: `generate_proxies_cmd` fires immediately after `create_project`, before `navigate` — proxy gen starts while user is still on Trimmer clip 1.
- `src/pages/Trimmer.tsx`: `sourceFailed` boolean state — `onError` hides `<video>` and shows `<img src={thumbnail_data}>` fallback when WebView2 cannot decode the proxy (HEVC without extension, corrupt file). Reset on clip change. `videoCanPlay` state and disabled play button already in place.

**Batch 15c Package 1 — Pipeline + DB (C1 + C7) (2026-04-24)**

- `pipeline/proxy.py`: `extract_thumbnail()` extracts JPEG from source at 1s seek, emits `THUMBNAIL_DONE:clip_id=<id>,data=<data_uri>`. `extract_waveform()` renders 120×80 waveform PNG via `showwavespic=s=120x80:colors=0x22c55e:scale=cbrt`, emits `WAVEFORM_DONE:clip_id=<id>,data=<data_uri>`. Both run before proxy encode (fast-first ordering). `is_valid_proxy()` validates existing proxy files via ffprobe before skipping re-encode — catches corrupt files (missing moov atom). Proxy encode timeout raised to 600s. `-preset ultrafast -vf scale=-2:480`.
- `src-tauri/src/db.rs`: `waveform_data TEXT` additive migration (col 18), `update_clip_thumbnail()`, `update_clip_waveform()`. `Clip` struct + `get_project_with_clips` SELECT updated.
- `src-tauri/src/lib.rs`: manifest JSON per clip now includes `needs_thumbnail`, `needs_waveform`. `run_proxy_gen` parses `THUMBNAIL_DONE:` and `WAVEFORM_DONE:` lines, calls DB updaters, emits `thumbnail-progress` / `waveform-progress` Tauri events.
- `src/types/project.ts`: `waveform_data: string | null` added to `Clip` interface.
- `src/pages/Trimmer.tsx`: listeners for `thumbnail-progress` and `waveform-progress` events update clip state incrementally. Proxy status row ("Generating previews…" pulse + "Preview optimised" badge) removed — video player spinner overlay is sufficient feedback. `preload="auto"` + `play().then(pause)` first-frame paint fix (WebView2 black frame issue). `loadeddata` event gate ensures the paint runs after buffering.
- `src/components/trimmer/TrimBar.tsx`: `waveformData` prop renders waveform `<img>` at z-2 with `mix-blend-mode: screen` opacity 0.9.

**Batch 15a Groups A+B — Trimmer Polish (2026-04-05)**

- **A1** `src-tauri/src/db.rs`: `insert_clip` now explicitly writes `include = 0` in INSERT SQL — never relies on column DEFAULT (was `DEFAULT 1` from Batch 14c, so existing DBs still defaulted to 1). Root cause fixed.
- **A1** `src-tauri/src/lib.rs`: `include: 0` in `create_project` Clip struct for clarity
- **A1** `src/pages/Upload.tsx`: `metaToClip` `include: 0`
- **A2** `src/pages/Upload.tsx`: removed `view === "clips"` staging screen entirely — after scan completes, name modal appears directly over home view. Removed `handleContinueClick`, `ClipList` import, `handleDelete`, `handleReorder`. Derive project name inline from scan results.
- **A3** `src/components/trimmer/TrimBar.tsx`: timer row redesigned — static `0:00` far-left, static `fmtMs(durationMs)` far-right, centered `selected` label; floating handle labels above IN/OUT handles (position: absolute, `clampLabelPct` prevents overflow)
- **A4** All grey text → `#e5e5e5` in Trimmer.tsx, TrimBar.tsx, FilmStrip.tsx, MediaPantry.tsx, StepNav.tsx. Separator chars updated. Exception: TrimBar hint text stays subdued.
- **A5** `src/pages/Trimmer.tsx`: proxy status row — orange pulse during generation → green checkmark + "Preview optimised" static when `proxiesReady === true`
- **A6** `src/pages/Trimmer.tsx`: `onClick={togglePlay}` + `cursor-pointer` placed directly on `<video>` element (not wrapper div — video has no interactive children, no guard needed)
- **A7** `src/components/trimmer/TrimBar.tsx`: track base changed from `bg-black/50` to `rgba(255,255,255,0.08)` dark neutral surface; inactive regions are `rgba(0,0,0,0.55)` darker overlay on top
- **A8** `src/components/trimmer/TrimBar.tsx`: `currentMs: number` prop added; white vertical playhead line (`w-0.5 h-full bg-white/80 z-10`) positioned at `${playheadPct}%`. `src/pages/Trimmer.tsx`: `currentMs` state, `onTimeUpdate` + `onSeeked` on video element, reset to `inMs` on clip change.
- **B1** `src/components/trimmer/MediaPantry.tsx`: `draggable={true}` + `onDragStart={(e) => e.dataTransfer.setData("clipId", clip.id)}` on each tile. `src/components/trimmer/FilmStrip.tsx`: `onDragOver` + `onDrop` on container; `onAdd` prop; empty state text updated to "Drag clips here or use Add to Film". `src/pages/Trimmer.tsx`: `onAdd={(c) => handleToggleInclude(c, 1)}` wired.
- **TrimBar z-index documented:** z-0 base surface → z-1 inactive overlays → z-2 (future waveform slot) → z-3 selected region → z-10 playhead → z-20 handles
- `e2e/trimmer.spec.ts` written (12 assertions, 3 screenshots A/B/C auto-saved). `pnpm test:e2e:trimmer` added to package.json.
- E2E: 26/26 PASS (7 fast + 7 editor + 12 trimmer + 0 console errors)

**Batch 14e-core — "Build Your Film" redesign (2026-04-05)**

- `src-tauri/src/db.rs`: `reorder_clips()` helper (transaction, sort_order UPDATE per clip)
- `src-tauri/src/lib.rs`: `reorder_clips_cmd` Tauri command; registered in `generate_handler![]`
- `src/globals.css`: `rc-focal-pulse` + `rc-zoom-preview` keyframes
- `src/components/review/ClipNavStrip.tsx` (new): DnD thumbnail strip, auto-scroll, duration counter
- `src/pages/Review.tsx`: title → "Build Your Film", ClipNavStrip wired, focal animation, `saveCurrentClip()` helper, `isSaving` guard, `[review]` log instrumentation, Skip demoted to text-link, "Next →" primary CTA, autoPlay removed, progress bar removed, "Finish & Go to Editor" CTA removed
- 25/25 E2E PASS

**Batch 14e-hotfix (2026-04-05)**

- `Upload.tsx`: removed `REVIEW_THRESHOLD` — always routes to `/review/:projectId`
- Product direction pivot: task-based screen architecture decided (Upload→Trimmer→Transitions→Sound→Render)
- Explicit-add assembly model confirmed (was all-IN; changing in 15a when Trimmer ships)
- `docs/trimmer-designs.html`: Design A (pantry grid) chosen as Batch 15a blueprint

**Batch 14d — Quick Wins + Upload Delight (2026-04-03)**

- `Review.tsx`: back button `ml-10` clears fixed hamburger; proxy pending badge removed; centre focal point button removed; Skip Review gains `title` tooltip
- `Upload.tsx`: scanning overlay replaced — folder scan grows skeleton cards 1/200ms via setInterval (cap 24); file picker shows exactly N cards (`knownCount = paths.length`) with staggered fly-in (`animationDelay: i * 50ms`). Spinner + "Scanning your clips..." label retained alongside grid.
- `ClipList.tsx`: staggered `rc-fly-in` animation on cards (`index * 40ms` delay, cap 400ms)
- `src/globals.css`: `@keyframes rc-fly-in` added (opacity 0→1, translateY 10px→0)
- Skeleton cards use `aspect-video` (compact 16:9) not `aspect-square`
- E2E: 25/25 PASS

**Batch 14a — Review Screen UI (2026-04-02)**

- New route `/review/:projectId` added to App.tsx
- `src/pages/Review.tsx` (new): sequential clip review, Quick mode (Include/Skip + focal point picker), Precise mode (IN/OUT trim sliders + zoom preset chips)
- Video player: `convertFileSrc(proxy_path ?? local_path)`, "proxy pending" badge when no proxy yet
- Focal point: `position: relative` wrapper + transparent overlay div (click → focal_x/focal_y); visual dot indicator; "Centre focal point" reset
- Keyboard shortcuts: `Enter` = include, `Space` = skip; listener cleanup on unmount; `isSaving` ref guard vs rapid keypresses
- `sessionStorage` resume: `review_index_${projectId}` key — Back → return resumes at correct clip
- "Skip Review →" escape hatch in header; "Continue to Editor →" shortcut on last clip
- `update_clip_review_cmd` invoked per clip; navigates to `/editor/:projectId` on completion
- `src/lib/constants.ts` (new): `REVIEW_THRESHOLD = 5` — Upload navigates >5 clips to review, ≤5 direct to editor
- `tauri.conf.json`: asset protocol scope expanded from `C:\clips\processed\**` to `C:\**`, `D:\**`, `E:\**` — fixes 403 on source clip video playback
- E2E: 25/25 PASS (7 fast + 7 editor + 11 render)

**Batch 14b — Proxy Generation + Hygiene (2026-04-02)**

- `pipeline/proxy.py` (new): H.264 720p proxy encode per clip, `--manifest-path` protocol, per-clip `PROXY:clip_id=...,win_path=...` stdout, `-c:a copy` (audio stream-copied, not re-encoded), skips existing proxies, per-clip failure non-fatal
- `src-tauri/src/lib.rs`: `generate_proxies_cmd` (async Tauri command, filters `include!=0 && proxy_path IS NULL`, writes proxy manifest, spawns background WSL task); `run_proxy_gen` (stdout parser, calls `update_clip_proxy` per clip, emits `proxy-progress`/`proxy-done`/`proxy-error` events); registered in `generate_handler![]`; `update_clip_proxy` added to `use db::{}` imports
- `src/pages/Output.tsx`: proxy gen fires on `pipeline-done` (not on project create) — avoids WSL2 FFmpeg contention with render pipeline; `projectIdRef` captures project ID from job load
- `src/pages/Upload.tsx`: fire-and-forget removed (was firing on create, causing ~90s render slowdown)
- `pipeline/run.py`: `shutil.rmtree(f"/tmp/{job_id}", ignore_errors=True)` after copy — frees 1-3 GB WSL2 tmpfs per render immediately
- `pipeline/render.py`: rich `ANALYSIS:` line emitted at pipeline end (not mid-run): `raw_duration_s`, `output_duration_s`, `total_raw_mb`, `max_resolution`, `has_4k`, `audio_clip_count`, `normalise_s`, `render_s`, `total_s`, `music`, `cards`, `zoom`, `transition`; `t_wall_start` + named timing vars (`normalise_s`, `render_s`)
- Wrapup skill: added Windows temp manifest + WSL2 `/tmp/` cleanup commands to Step 5

**Batch 14c — Per-Clip Data Model (2026-04-01)**

- DB: 7 additive migrations on `clips` table: `in_ms`, `out_ms`, `focal_x`, `focal_y`, `zoom_mode`, `include` (default 1), `proxy_path`
- Rust: `Clip` struct extended; `get_project_with_clips` SELECT expanded to 18 cols with index comment map; `update_clip_review()` (clamps focal to 0.0-1.0); `update_clip_proxy()`
- Tauri: `update_clip_review_cmd` registered; `start_job` filters `include==0` clips, returns error on empty manifest, clamps `out_ms` to `duration_ms`, includes per-clip fields in manifest JSON
- TypeScript: `Clip` interface + 7 new fields; `metaToClip` updated with defaults
- Pipeline `render.py`: Step 2 user `in_ms`/`out_ms` override silence detection; Step 3 per-clip `zoom_mode` + focal point
- Pipeline `zoom.py`: 3 presets (gentle 1.1x / medium 1.3x / tight 1.5x), focal-aware x/y with edge clamping, diagnostic logging

**Batch 14-P — Pipeline Reliability (2026-04-01)**

- A/V sync fixed: root cause = hard-concat audio for 3+ clips assigns clip N audio a 1.5s late start at every cut after the first (audio cut at sum(durations[:N]) while xfade ends at sum(durations[:N]) − xfade_dur). Fix: pairwise chained `acrossfade` for ALL N>=2 clips. `apad=whole_dur=durations[i]` normalises each clip's audio duration to exact video frame boundary, so acrossfade start = xfade offset exactly.
- Music looping: N-copy pairwise chained acrossfade (replaced `-stream_loop -1`); `silencedetect` strips track intro/outro silence before tiling. Residual gap persists (track tail is low-energy, not silence); waveform-matching deferred.
- Per-clip normalise progress: `report_stage(f"Normalising clip {done} of {total}")` + per-clip `report()` remapping (10%→50% normalise, 52/55/60/80/88/95 for remainder).
- Library routing: processing project "Open" button navigates to `/output/:jobId` instead of editor.
- Persistent pipeline log: `run.py` `FileHandler` at `/mnt/c/Users/Manasak/AppData/Local/Temp/rushcut/pipeline-latest.log`.
- LEARNINGS.md + pipeline.md rules updated: `apad` + pairwise acrossfade is correct for 3+ clips.

**Batch 13b — Pipeline Fix + UI Cleanup + Post-batch Hotfixes (2026-03-29)**

- Motion scoring removed from `render.py`; `motion.py` kept as dead code
- `filter_boring` toggle removed from SettingsPanel
- Output filename: `slug-01.mp4` / `slug-02.mp4` per-project counter (Rust `lib.rs`)
- Volume chip color: `#FF8A65` → `#99B3FF` (docs/DESIGN.md updated)
- Per-stage timing logs in `render.py` (TIMING: prefix)
- Toggle translate-x visual bug fixed (`translate-x-5`)
- Post-batch hotfix: `transitions.py` — fixed-canvas pre-scale on every input (`[svN]` labels, both "none" and xfade paths) — fixes portrait+landscape crash (FFmpeg exit 234)
- Post-batch hotfix: `normalise.py` — final mode preset `fast` → `ultrafast` (~3min → ~60-90s normalise)
- Post-batch hotfix: `Output.tsx` — rolling 10-min inactivity timeout (resets on `pipeline-stage` events only, not progress ticks)
- E2E spec updates: clips capped to first 3, codec assertion height-only, Mocha timeout 600s, script timeout 90s
- E2E: 25/25 PASS

**Batch 13 — Motion Intelligence (2026-03-29)**

- `pipeline/motion.py` (NEW): FFmpeg scene-change scoring via `select='gt(scene,0.02)',metadata=print:file=-`; `score_clip()` single pass returning `(motion_score, scored_frames)`; `filter_by_motion()` with safety keep-all fallback; `find_peak_window()` sliding window, no extra FFmpeg pass
- `pipeline/beats.py` (NEW): `detect_beats()` via librosa; `snap_to_beat()` with tolerance; graceful fallback (returns `[]` on ImportError)
- `pipeline/render.py`: replaced freezedetect inline block; added motion filter (13a), clip cap by motion×sqrt(duration) (13b), peak-window trim (13c), beat-sync re-trim (13d); `ANALYSIS:clips_used=N,...` stdout protocol
- `pipeline/run.py`: `on_analysis` callback; `max_clips`, `target_clip_dur` forwarded; `filter_boring` default `True`
- `src-tauri/src/db.rs`: `analysis_summary TEXT` column; SQLite migration guard (`pragma_table_info` check); `update_job_analysis()` helper
- `src-tauri/src/lib.rs`: `ANALYSIS:` stdout prefix handler; calls `update_job_analysis`
- `src/types/project.ts`: `analysis_summary: string | null` on `Job`
- `src/components/editor/SettingsPanel.tsx`: Smart Clip Selection toggle row; `filter_boring` wired
- librosa 0.11.0 installed in WSL2 Ubuntu-24.04
- E2E: 25/25 PASS (fast suite)

**Batch 12b — Music Mode Presets + Spec Bug Fixes (2026-03-28)**

- `music_volume` type → `"subtle" | "balanced" | "prominent"` union (was `number` 0–100)
- SettingsPanel: 3-chip group (Subtle / Balanced / Prominent), conditional on `music_mood !== "none"`, Balanced default
- `run.py`: preset→float map `{subtle: 0.2, balanced: 0.4, prominent: 0.7}`; legacy numeric values fall back to 0.4
- E2E spec fixes: `expect(val,msg)` 2-arg (×2), progress poll race condition, filename slug regex → `.mp4` suffix check, `clip-item` testid added to `TimelineStrip.tsx`

**Batch 12 — QoL Fixes (2026-03-27)**

- Audio: `-ar 48000` added to all 6 FFmpeg re-encode sites; multi-clip path was missing `-c:a` entirely (silent bug fixed)
- Music volume: slider (0–100) in SettingsPanel; pipeline scales via `/ 100.0` in `run.py`; removed stale `MUSIC_VOLUME = 0.3` constant from `music.py`; `mix_music()` now takes `music_volume: float = 0.4` param
- Delete project: `delete_project_cmd` Rust command; manual delete order clips→jobs→projects (no FK cascade); Library UI with trash icon, `window.confirm`, optimistic list update
- Stale job cleanup: 60-min SQL UPDATE inside `list_projects_cmd`; jobs stuck in `processing` auto-failed
- Output timeout: 10-min `setTimeout` with `completedRef` guard; `useEffect` cleanup prevents unmounted-component warning
- `music_volume: 40` added to stale `DEFAULT_CONFIG` in `ConfigurePanel.tsx` to fix TS2741 error

**Batch 11c — UX Polish Round 2 (2026-03-27)**

- Home screen: two-card layout (Start New Project + Resume a Project), real thumbnails from `first_clip_thumbnail` (Rust subquery added to `list_projects`), dates in Resume section
- Mandatory project name modal before `create_project` is called; Skip button removed
- Scan spinner overlay during `scanning` state
- AppShell: shared `<AppShell>` wrapper with fixed NavDrawer; removed per-page NavDrawer inline usage
- Transition picker: None (default) / Crossfade / Dip to black; `DEFAULT_CONFIG.transition = "none"`
- `XFADE_DUR` increased to 1.5s; clamped to `min(1.5, min_clip_dur / 2.0)` to prevent short clip consumption
- Output page: elapsed count-up timer replacing static copy; "Starting up the magic..." initial stage; "My Projects" button top-right; project name displayed as `{name}.mp4`
- Open File button on Output done state (Rust `open_output_path` command using `explorer /select,`)
- Always-red bin icons in ClipList and timeline; CardBlock bins; card delete bins in SettingsPanel headers
- `#C5FFF9` Back buttons on Upload/Editor/Library; `#E1F2CE` My Projects button on Output
- E2E eval: 41/41 PASS (0 failures)

**Batch 11b — E2E Infrastructure + Eval Skill (2026-03-26)**

- WebdriverIO v9 + msedgedriver E2E scaffold; 3-layer BiDi fix; `rushcut-eval` skill; 33/35 PASS

---

## Deferred / Blocked

| Item                                       | Status                                                      |
| ------------------------------------------ | ----------------------------------------------------------- |
| Motion scoring (boring filter)             | DEAD CODE — pipeline/motion.py kept, not called             |
| Beat-sync music cuts                       | Not required now — revisit if <1 min total                  |
| Music looping                              | FIXED Batch 14-P — N-copy acrossfade + silence-trim         |
| Music loop: waveform-matching loop point   | Future (Batch 15+) — find spectral-match point in track for zero-gap loop; may need AI/librosa |
| Audio/video sync drift                     | FIXED Batch 14-P — pairwise acrossfade chain (apad-aligned) |
| Hardware HEVC decode (`-hwaccel auto`)     | Batch 13c (probe WSL2 GPU passthrough, implement if viable) |
| Per-clip IN/OUT + trim (data model)        | DONE Batch 14c — pipeline wired, UI in 14a                  |
| Per-clip focal point + zoom (data model)   | DONE Batch 14c — pipeline wired, UI in 14a                  |
| Sequential clip review flow                | Batch 14a (Review screen UI)                                |
| Proxy files for HEVC scrubbing             | Batch 14b (next task)                                       |
| Per-clip transition picker                 | Batch 14+                                                   |
| Previewable transitions (proxy)            | Batch 14+ (proxy system needed)                             |
| Tabbed settings UI (Music / Effects / Text)| Batch 14                                                    |
| AI Director screen                         | Batch 15 (deprioritised)                                    |
| Auth / project library                     | Batch 16                                                    |
| 4K output                                  | Batch 16                                                    |
| Stripe / paid tier                         | Batch 16                                                    |
| Cloud mode (Vercel + Lambda)               | Phase 3                                                     |

---

## Key Decisions Since Phase 1

- **DEC-018:** Phase 2 gate = founder's own successful 60+ clip session (not paying users)
- **DEC-019:** Competitor research = web-only (desktop apps have different capability/latency profile)
- **DEC-020:** Stripe deferred until AI layer exists — charging for clip stitching has no lock-in
- **DEC-021:** "In the middle" positioning confirmed — direction power, not full auto-AI, not manual timeline
- **DEC-022:** Full local build — upload bottleneck (84 min for 19 GB session at 30 Mbps) makes cloud-upload model unworkable for real sessions. Phase 2 runs entirely on-machine via WSL2.
- **DEC-023:** Motion scoring removed — FFmpeg-per-clip scoring adds >10 min on 10 min footage; unacceptable. pipeline/motion.py kept as dead code only. May be revisited as a premium AI feature if total time can be <1 min.
- **DEC-024:** Product pivots to guided clip-review editor — user sets IN/OUT + focal point per clip; pipeline does deterministic assembly. No invisible auto-curation. "Anti-fake-AI, not anti-AI."
- **DEC-025:** AI policy = selective, user-visible only — AI only where improvement is demonstrable and sellable. Never for internals the user can't see or verify.
- **DEC-026:** Clip Review has two modes — Quick (default: Include/Skip + focal point only) and Precise (opt-in per clip: adds IN/OUT handles + zoom preset). Quick mode must be fast enough that a 60-clip session is not a chore. Do not force full manual trimming on every clip.
- **DEC-027:** Post-review Editor is intentionally minimal — reorder, music, transition, intro/outro, render. No feature creep. Any per-clip decision belongs in the Review screen, not the Editor.
- **Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."

Full decision log: `docs/DECISIONS.md`

---

## Live Infra State

- **Vercel:** Still deployed (git-main URL), but not the active dev target for Phase 2
- **Lambda:** Idle — retired as processing backend. Do not delete.
- **Supabase:** PAUSED — data preserved, restorable within 90 days. Not used in Phase 2.
- **R2:** DELETED — bucket emptied and removed.
- **Lambda / ECR:** DELETED — do not rebuild.
- **Local FFmpeg:** WSL2 Ubuntu-24.04, `/usr/bin/ffmpeg` (v6.1.1) — installed via `apt-get install -y --fix-missing ffmpeg`
- **SQLite:** `%APPDATA%\rushcut\rushcut.db` — created on first `pnpm dev`
