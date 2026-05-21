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

**Phase 2 — Batch P (Render Performance) COMPLETE (2026-05-21). Next: Audio re-encode + opencl.**

---

## Immediate Next Task

**Batch P2 — two quick render wins (new chat):**

> Before starting: log only, no fixes — read `render.py` final render command and confirm whether audio is being re-encoded after loudnorm has already run. If `-c:a` is not `copy` in the final concat/render step, that's a wasted ~27s per render. If confirmed, change to `-c:a copy`. Separately, add `x264opts opencl=true` to the final render ffmpeg command — one flag, no quality impact, marginal free speedup on the CPU encode path.

1. **Audio copy in final render** — if loudnorm already ran, the final concat's `-c:a aac -b:a 128k` is redundant; switch to `-c:a copy` to save ~27s
2. **`x264opts opencl=true`** — one flag, free marginal speedup, zero quality risk

GPU encoding (NVENC) is the next large lever but requires GPU detection + 3 encoder code paths + quality validation. See PRD-DEV.md backlog.

---

## Recently shipped this session (2026-05-21)

- **Batch P — Render Performance COMPLETE:** Zoom step parallelised via `ThreadPoolExecutor(min(4, cpu_count))` with per-worker `-threads N -filter_threads N` cap (mirrors normalise.py). Persistent zoom output cache at `/tmp/rushcut-zoom-cache/` — sha1 key on `(src_path, size, in_ms, out_ms, zoom_mode, focal_x, focal_y, resolution)`; atomic writes via `os.replace(tmp→final)`; INVALID detection via `is_valid_proxy()` for corrupt mid-encode cache entries. Render preset `medium → fast` (CRF 22 kept). `zoom_cache_hits` added to ANALYSIS line + `render-timing-log.jsonl`. `run.py` per-job log file (`pipeline-{job_id}.log`) with `pipeline-latest.log` as symlink — prevents concurrent runs corrupting the log. Measured: 6-clip 4K re-render ~3 min (was ~6.5 min). First renders unaffected by cache (all MISS). E2E: 9/9 fast + 5/5 gap-editor + 26/26 arrange + 15/15 render PASS.

- **Batch O — Gradual Zoom (Ken Burns) COMPLETE:** Per-clip gradual zoom added to Arrange Zoom tab. `zoom_mode` encoding: `kb_<dir>_<ratio>_<speed>` (e.g. `kb_in_1.5_slow`). UI: Style row (Off / Fixed / Gradual) + Direction / Amount / Speed chips. Speed semantics: slow=100%, med=75%, fast=50% of trimmed clip duration. Preview: CSS `rc-kenburns` keyframe on a **wrapper div** (not video element — avoids WebView2 compositor conflict that caused choppy playback); plays once on selection, resets on play. backend: `zoom.py` `_probe()` single ffprobe (w+h+duration), `_parse_kenburns()`, `_kenburns_vf()` with comma-free smoothstep clamp `(a+1-abs(a-1))/2`; `-preset ultrafast` for intermediate. `crop` filter has no `eval` option — x/y re-evaluate per frame natively. `src/utils/zoom.ts` canonical model: `parseZoom()`, `buildZoomMode()`, `zoomLabel()` — no screen shows raw `kb_*` string. 1080p render: zoom=3.7s. 4K render: zoom=9.9s. 9/9 fast PASS, 26/26 arrange PASS. Performance note: 6 clips 4K ~1m20s = 9m first render / 6.5m re-render; zoom step 1.5m for 6 clips — parallelisation needed next batch.

## Recently shipped previous session (2026-05-20)

- **Bug fix — Shuffle label raw JSON on Sound + Render screens:** `Sound.tsx` and `Render.tsx` were reading `rc_transition_${projectId}` via raw `sessionStorage.getItem()`, which since Batch M2 returns a full `TransitionConfig` JSON object. Passing that raw JSON string to `ChosenEffects` caused `TRANSITION_LABELS[jsonString] → undefined → chip shows raw JSON`. Fix: both pages now import and use `readTransitionConfig()` from `buildJobConfig.ts`, deriving `"shuffle"` / `tc.between` / `null` correctly. ChosenEffects chip shows "Shuffle" on all screens. 9/9 fast PASS.

- **Bug fix — Shared video state for two cuts from same source clip (Arrange):** `loadedSrcRef` (URL-based) guard in Arrange zoom + sound tabs fired early when switching from Cut A to Cut B of the same raw clip (identical `proxy_path` URL). Renamed to `loadedClipIdRef` and `soundLoadedClipIdRef`; guard now compares `selectedClip.id` (always unique). Switching cuts correctly seeks to each cut's `in_ms`. 23/23 arrange PASS.

## Recently shipped previous session (2026-05-19)

- **Batch N — Background Proxy Pre-Generation COMPLETE (2026-05-19):** Silent pre-build of 1080p H.264 proxies when user leaves Trimmer → Arrange. Trigger: `Trimmer.tsx` unmount `useEffect` cleanup calls `invoke("generate_proxies_cmd", { projectId, lowPriority: true })`. Rust `run_bg_proxy_batch`: serial HEVC encode at Windows `BELOW_NORMAL_PRIORITY_CLASS` + `-threads 1`; `update_clip_proxy` + `set_clip_proxy_status('done')` on success. Native-codec (H.264) clips skip encode instantly. Concurrency guard (existing `Arc<Mutex<HashSet>>`) prevents duplicate spawns. `proxy_path` written to DB by background gen → `start_job` manifest already includes it → `render.py` Batch C proxy-reuse logic skips normalise automatically. DB: additive `proxy_status TEXT` column + `set_clip_proxy_status()` + `get_clips_needing_bg_proxy()` helpers. Logs to `%TEMP%\rushcut\proxy-bg.log`. Step 5 log confirmed: 5 clips, elapsed 6–18s each, no duplicates, re-trigger guard fires `skip reason=no-clips-need-proxy`. E2E: 9/9 fast PASS, 23/23 arrange PASS, 15/15 render PASS (2026-05-19).

- **Batch M2 — Transitions Expansion COMPLETE (2026-05-18):** 9 transition types (None / Crossfade / Dip to Black / Wipe / Wipe Down / Zoom / Dissolve / Barn Door / Band Wipe) + Shuffle card (random per-cut from all 8 non-none types, job-id seeded for determinism, logs `[M2] cut N: type`). Left-rail 10-card layout + enlarged centre preview (h-56). CSS keyframes for 4 new types: wipe_down (clip-path inset top/bottom), dissolve (opacity, same timing as crossfade), barn_door (scaleY squeeze), band_wipe (two-step clip-path right-to-left). Animation bug fixed: unselected cards use `animation: "none"` in JSX (inline style beats CSS play-state class). Opening / closing cut pickers removed from UI (pipeline plumbing retained). `TransitionConfig` JSON storage with compat reader. Pipeline: `_TRANSITION_MAP` extended (4 new FFmpeg xfade names), `_SHUFFLE_POOL` extended to all 8. 23/23 arrange E2E PASS. PRD: two post-launch backlog items added (animation accuracy polish + geometric mini-preview redesign).

- **Batch M1 — Transition preview card-chips COMPLETE (2026-05-17):** Transitions tab chips on Arrange screen converted to card-chips (vertical card: animated thumbnail on top + label below). CSS `@keyframes` for None (hard cut via `steps(1, end)`), Crossfade (opacity dissolve), Dip to Black (fade-to-black gap). 3s looping animations; play-state `paused` by default, `running` on `.rc-trans-card--selected`. Thumbnails from first/last in-film `thumbnail_data` (base64 JPEG); colour-block fallback when no clips. Description text removed — visual demo replaces it. DESIGN.md extended with transition preview card-chip pattern. 9/9 fast E2E PASS. Deferred: M2 left-rail layout + expanded types + shuffle.

- **Batch L — Cards tab COMPLETE (2026-05-17):** Cards tab on Arrange screen fully implemented. Two panels (Start card + End card). Start: toggle, title input (60 chars), subtitle input (80 chars), 3-swatch colour picker (peach/black/white), CSS preview. End: toggle, text input (40 chars), swatch picker, CSS preview. Defaults: both toggles OFF; start title seeds from project name on first load; end title = "The End". State persists in `rc_cards_${projectId}` sessionStorage. `buildJobConfig.ts` maps colour tokens → hex, respects toggle-OFF (emits empty string). Pipeline: `cards.py` `_make_png` extended with subtitle RGBA composite (60% alpha via `fill=(r,g,b,153)`, `getbbox`-based vertical centring). `render.py` passes `subtitle=config.get("intro_subtitle", "")`. DESIGN.md: two new subsections (Form text input + Card background swatch picker). PRD backlog: card in-film preview deferred post-launch. **Bugs fixed:** (1) `music.py` filter_complex trailing comma before `[mus]` output label (pre-existing; caused FFmpeg exit 8 on any render with music). (2) `run.py` not forwarding `intro_subtitle` from manifest to config dict (subtitle silently empty on render). 9/9 fast E2E PASS.

- **K4 — Dual-buffer black flash fix on Master tab COMPLETE:** Ported the proven Trimmer.tsx A/B slot dual-buffer engine into `src/pages/Sound.tsx`. Replaced single `filmVideoRef` with `filmVideoARef`/`filmVideoBRef` + `activeFilmSlotRef` + `slotGenRef`. Added `getFilmVideo`, `setSlotVisible` (sig: `"a"|"b"|"none"`), `gateFrameRevealThen` (rVFC + `metadata.mediaTime` gate, `TOLERANCE_SEC=0.05`, `MAX_WAITS=30`), `loadIntoSlot`, `preloadIntoSlot`, `crossSeekToClip`. Rewrote `advanceFilmClipRough`, `handleFilmTimeUpdate`, `startFilmPlayback`, `pause/resume/stopFilmPlayback`, `seekToFilmMs`. JSX: two stacked `absolute inset-0 w-full h-full object-contain` `<video>` elements. Fixed post-playback regression: `stopFilmPlayback` must NOT call `setSlotVisible("none")` — leave last frame visible. DESIGN.md extended with dual-buffer model note. 9/9 fast E2E PASS.

- **K3 Revised — Live Rough Mix Playback COMPLETE:** Master mixer tab is now a full-screen film preview (large video area + right sidebar). Hidden `<video>` element cycles through `inFilm` clips sequentially; `<audio>` element plays music simultaneously. No Rust invoke calls, no WSL/Python pipeline. Features: pause/resume (`isFilmPaused` state), seekable progress bar (imperative DOM updates via refs, avoids 4-66Hz re-renders), `out_ms` respected via `onTimeUpdate` guard (not `onEnded`), music syncs to seek position + volume reset on seek, fade-out marker with "fade Xs" label on progress bar, "Press play to preview" overlay suppressed after first play via `hasPlayedRef`. Fade-out settings moved to Music tab. `handleMusicTabChange` stops preview on Master-tab enter; stops film on other-tab switch. 9/9 fast E2E PASS.

- **Batch K2 COMPLETE (2026-05-16):** Arrange Sound tab (4th tab, per-clip volume chips Mute/50%/100%/Custom, `video.volume` for audible feedback, `update_clip_volume_cmd` param fix `volume`→`clipVolume`). Filmstrip volume badges: VolumeX red (mute), Volume1 purple (reduced) — both styled as coloured square badges matching Z badge pattern. Bottom nav "Sound"→"Music". Music screen two-tab shell (Music + Master mixer). Master mixer: volume chips + fade-out chips (None/2s/5s) + Quick Preview placeholder. Pipeline: `music_fade_out_s` wired run.py→music.py. Cross-tab video pause on tab switch. 9/9 fast E2E PASS.

- **Arrange clip playback fixes (post-K1):** Video player in Arrange zoom tab now seeks to `in_ms` on `loadedmetadata`, stops at `out_ms` in `handleTimeUpdate`, clamps scrubber to `[in_ms, out_ms]`, displays trimmed elapsed/total. Playhead wired from per-clip `currentMs` via `filmPlayheadMs` formula. Replay after clip ends fixed (seeks back to `in_ms` in `togglePlay`). 9/9 fast E2E PASS.

- **Batch K1 — Arrange screen full redesign COMPLETE:** Centred `<video>` preview + left clip rail (vertical thumbnails, peach active border) + Prev/Next navigation; "zoom" tab (renamed from "Clips"); play+scrubber row; drag-to-focal on video preview (window-level mousemove, `patchClip` instant + `saveReview` on mouseup); Z badge (green `bg-[#22c55e]` square) on StickyFilmStrip when `zoom_mode != null`; purple dot when `clip_volume !== 1.0`; drag-left/DEL delete on film strip. Volume controls removed from Arrange. `loadedSrcRef` pattern prevents video reload stutter on tab switch (zoom tab kept mounted via `hidden` class). 9/9 fast PASS.
- **Play button standardised:** Trimmer + Arrange both use `<Play size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />` inside `w-10 h-10 rounded-full bg-[#FF8A65] text-white`. No hand-coded SVG.

- **Batch J — Arrange screen COMPLETE:** `/transitions/` → `/arrange/`; 3-tab shell (Clips | Transitions | Cards); per-clip volume (chips + custom input, `clip_volume` DB col + Rust cmd + pipeline volume filter); zoom + focal picker on Clips tab; StickyFilmStrip `onSelectClip`; pipeline `volume=` filter in transitions.py + render.py; E2E `arrange.spec.ts`. 15/15 render E2E PASS.
- **zoom.py static crop fix:** Replaced broken `zoompan` expression syntax with `ffprobe`-derived integer pixel coords → `crop=W:H:X:Y,scale=W2:H2`. Eliminates FFmpeg exit 8.
- **Render timing JSONL log:** `pipeline/run.py` now appends per-render record to `%TEMP%\rushcut\render-timing-log.jsonl` after every successful render: timestamp, instance (wdio/direct), clips, film duration, per-phase timings (normalise/trim/zoom/render/music/loudnorm), proxy usage, resolution, effects. `.jsonl` extension preserved across wrapup cleanups.
- **Two-instance documentation:** CLAUDE.md updated with two-instance rule. `start_job` manifest now includes `"instance": "wdio"|"direct"` detected via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var.
- **render.spec.ts fix:** `isExisting()` → `waitForExist({ timeout: 10_000 })` for `btn-render-film` — fixes race vs async `"ready"` phase. 15/15 PASS.

**TrimBar already-included region overlay — COMPLETE (2026-05-14):**

- `alreadyCutRegions` prop added to `TrimBar` — `Array<{ inMs; outMs }>` from Trimmer.tsx
- Bracket gradient fill: `rgba(153,179,255,0.26)` fill, `rgba(153,179,255,0.52)` edges — `#99B3FF` blue
- Z-index 2 (same tier as waveform); `pointer-events-none`; self-exclusion filter (`c.id !== selectedClip.id`); malformed row guard; micro-cut flat fallback (`widthPct ≤ 2`)
- DESIGN.md updated with "TrimBar — Already-Included Region Overlay" pattern
- 9/9 fast E2E PASS

**Film seek stutter — Option H FIXED (2026-05-13):**

- **Cross-clip seek stutter fixed**: clicking a different clip in the film timeline during playback now cuts cleanly from the outgoing frame to the seek-target frame. No frame-0 flash.
- **`gateFrameRevealThen(v, slot, thisGen, targetSec, onReady)`**: rVFC helper with `metadata.mediaTime` gate — skips frame-0 leaks, reveals only when compositor confirms seek-target frame. Safety cap `MAX_WAITS=30`. Double-rAF fallback when rVFC absent.
- **`crossSeekToClip(idx, seekMs)`**: loads new clip into opposite slot; outgoing slot stays visible during load; atomic swap via `setSlotVisible(targetSlot)` + `oldV?.pause()` on onReady. Mirrors `advanceFilmClip` pattern.
- **`activate()` in `loadIntoSlot` simplified**: Option F (play→pause with mute) removed; replaced by `gateFrameRevealThen`.
- **E2E blocked**: msedgedriver v146 vs Edge v148 mismatch — download v148 from MS Edge WebDriver site (storage CDN unreachable from automation, requires manual browser download).

**Next up — pre-launch must-haves (PRD-DEV.md Batches J–M):**
- **Batch J** — Arrange screen (`/arrange/`, replaces `/transitions/`): 3-tab shell (Clips | Transitions | Cards). Clips tab: per-clip volume + zoom. Transitions tab: migrated from current screen. Cards tab: placeholder.
- **Batch K** — Quick Preview render on Sound screen (~15s 480p) + music crossfade-out chips.
- **Batch L** — Cards tab on Arrange screen (start/end text cards + pipeline). Prereq: J.
- **Batch M** — Transitions tab expanded: 5 types + shuffle + first/last cut. Prereq: J.
- **msedgedriver v148 confirmed** — E2E blocker cleared (already installed)

**Timeline HUD auto-fit — COMPLETE (2026-05-14):**
- `isAutoFitRef` (imperative) + `isAutoFit` state (reactive) dual-tracking pattern
- Clip add → fit-to-width + scroll-to-0 when in auto-fit mode; scroll-to-end when user has manually zoomed
- Ctrl+scroll breaks auto-fit mode; "fit view" pill button restores it
- "fit view" pill: single bordered pill (`bg-[#0a0a0a]`, `border-white/30`, `group-hover`) with SVG ⟷ + "fit view" label — positioned `top: 4, right: 6` on non-scrolling root div; only visible when `!isAutoFit`
- Text polish: TrimBar hint text → `text-xs text-[#e5e5e5]`; "selected" label → solid white; ruler tick labels → solid white
- DESIGN.md updated: micro-control pill button pattern documented; minimum text size rule codified at `text-xs`

**Batch G — Ruler-based proportional timeline for StickyFilmStrip COMPLETE (2026-05-09):**
- Full rewrite of `StickyFilmStrip.tsx`: proportional clip tiles (`trimmedMs * pxPerMs`, min 40px)
- Ruler row (RULER_HEIGHT=20px): dual-array tick system (minor ≥20px spacing, label ≥50px spacing), labels at top, tick marks at bottom pointing down toward clips
- Ctrl+scroll zoom with zoom-to-cursor math; middle-mouse / left-drag-on-track pan; ResizeObserver auto-fit on first render
- CSS thumbnail tiling (`background-image: url(thumbnail_data); background-size: auto 100%; background-repeat: repeat-x`) — no `<video>` elements (autoplay prevention)
- HUD border: `border-t-2 border-[#99B3FF]/30`; clip tiles: `border-2 border-[#99B3FF]/30`; active: `border-[#FF8A65]`; badge: `bg-[#99B3FF] text-[#0a0a0a]`; effect chips: blue `#99B3FF`
- Ruler tick labels: `text-[11px] font-mono text-[#a3a3a3]` — readable at minimum spec
- `Sound.tsx`: `filmDurationMs` derived-variable bug fixed (ReferenceError → white screen)
- DESIGN.md: StickyFilmStrip proportional timeline section fully documented
- PRD-DEV.md: Batch H (App Shell Redesign) + Batch I (Branding) specs added
- 9/9 fast E2E PASS
- **Deferred**: discoverability tooltips for zoom/pan (backlog in PRD), music bar below clip track

**Batch F — Sticky filmstrip HUD across trim/transitions/sound COMPLETE (2026-05-08):**
- `StickyFilmStrip` component: 100px read-only bottom bar, `flex-shrink-0`, `border-t border-white/10 bg-[#0a0a0a]`
- Clip thumbnails (90x56px, `MAX_VISIBLE=7`, +N overflow badge, `overflow: hidden` truncation)
- Total duration summary cell (flex-shrink-0, "Total" label, M:SS, clip count)
- Navigation chips: scissors→`/transitions/:projectId`, music note→`/sound/:projectId` — shown only when set and not "none"
- No Render CTA — users must navigate via StepNav funnel by design
- Music chip persists on Transitions screen: reads `rc_sound_${projectId}` from sessionStorage at render time
- FilmStrip replaced in Trimmer.tsx; "Remove from film" button in right sidebar (conditional on `filmActiveId`)
- Sound.tsx: `clips: Clip[]` state (replaces separate `clipCount`/`filmDurationMs`); header derives both inline
- DESIGN.md: "Persistent Bottom Status HUD" section added
- Deferred: ruler-based proportional timeline (own sub-batch), music bar below clip track
- 9/9 fast E2E PASS

**Batch E — Track duration vs. film duration on Sound screen COMPLETE (2026-05-08):**
- Film duration computed from included clips (`sum of (out_ms ?? duration_ms) - (in_ms ?? 0)`) and shown in header subtitle: "ProjectName · N clips · M:SS" (hidden when 0 clips).
- Library mood chips show track duration badge inline: "Cinematic · 2:34", "Upbeat · 1:30", etc. Probed via `audio.preload = "metadata"` on mount; `probedRef` guard prevents re-probe on re-mount.
- Comparison line below mood description when both durations known: "Film: 1:23 · Track: 3:45 — long enough" (green) or "Film: 1:23 · Track: 0:45 — will loop ~2x". Derived as `React.ReactNode` variable above `return` (not IIFE).
- Custom track duration probed via `audioRef` `loadedmetadata` listener after file pick — no second `Audio` object.
- PRD: "Post-pick metadata" item marked DONE; new backlog item added: Smart Music Track Ending (crossfade-out optimisation / optimal track end point detection via librosa).
- DESIGN.md: duration badge on chips + film vs track comparison line patterns documented.
- e2e.md + LEARNINGS.md: `preview_*` MCP tools added to port-9222 conflict warning (same as chrome-devtools).
- 14/14 sound E2E PASS · 7/7 fast E2E PASS.

**Batch D — Sound screen UX polish COMPLETE (2026-05-07):**
- Three-source selector: No Music / Rushcut Library / Upload Own Track (replaces flat chip row)
- No Music: bright-white active state (`border-white/60 bg-white/15`) — visually distinct from music-blue
- Rushcut Library: expands 4 mood sub-chips (Cinematic/Upbeat/Chill/Electronic) on click; NO auto-play — preview starts only on explicit mood chip click
- Upload Own Track: clicking chip selects source without opening OS dialog; empty state shows dashed "Choose audio file..." button; filled state shows filename (bold, `text-base font-semibold`) + Preview chip button (teenyicons play SVG, MIT) + "Change" text link
- Custom track preview: Play/Stop toggle button; same 30s timer; volume chips (Subtle/Balanced/Prominent) affect live preview `audioRef.current.volume` in real time (0.3 / 0.6 / 1.0)
- `customPath` preserved across source switches (no re-upload needed when switching Library→Custom)
- Pipeline: `_MOVIE_VOL` Balanced 0.7 → 0.4 (evenly spaced: subtle=1.0, balanced=0.4, prominent=0.3)
- Rust: `get_music_dir_cmd` command returns music dir path (strips `\\?\` UNC prefix from canonicalize)
- `LICENSES.md` created at project root (teenyicons MIT attribution)
- E2E: 14/14 sound PASS · 7/7 fast PASS

**Batch C — Proxy reuse as normalise input COMPLETE (2026-05-03):**
- Proxies upgraded from 480p to 1080p normalise-compatible spec (`scale=-2:1080 -r 25 -fps_mode cfr -c:a aac -ar 48000`)
- `start_job` manifest includes `proxy_path` per clip; `run.py` threads `proxy_path_wsl`
- `render.py` two-path logic: proxy clips skip normalise (→ 1.8s), non-proxy clips normalise from HEVC source
- Legacy 480p proxies detected by height check and routed to normalise path automatically
- `vacuum_proxies_cmd` Rust command: deletes orphaned (not in DB) or stale (>30d) proxies, called fire-and-forget after pipeline-done
- Bug found+fixed: `_pretrim_worker` B-0 offset mutation required restoring original `in_ms`/`out_ms` from `clips[i]` for proxy clips

**Batch B Run 3 — Custom music (B2) COMPLETE (2026-05-03):**
- "Custom Track" chip on Sound screen — calls `open()` from `@tauri-apps/plugin-dialog` (no new Rust command). Returns plain `string` on Windows desktop.
- Filename badge below chips when custom is active. Volume section shows automatically (`mood !== "none"` condition already covers `"custom"`).
- `custom_music_path` forwarded through `buildConfig()` → `start_job` → `run.py` (`win_to_wsl` conversion at config-build time) → `render.py` (guards `"custom"` mood from building `music_filename = "custom.mp3"`) → `mix_music()` (`custom_track_path` param, priority over `track_name`).
- `[B2]` log line in `music.py` confirms custom track path in pipeline log.
- `readStorage()` explicitly restores `customPath` when `mood === "custom"`. `handleMood()` clears `customPath` on mood switch.
- `e2e/sound.spec.ts`: updated "shows all 5 mood chips" → "shows all 6 mood chips including Custom Track". 13/13 PASS. 7/7 fast PASS.
- Founder feedback: 2m48s for 38s film (4 clips, custom MP3 w/ silencedetect) — acceptable. Volume "Balanced" still lets clip audio compete — `movie_vol = 0.7` may need tuning to `0.5`. Sound screen UX improvements deferred (see PRD-DEV backlog).

**Batch B Run 2 — 4K chip + render resize (2026-05-03):**
- `has_4k_clips_cmd` Rust command + `has_4k_clips()` DB helper (clips WHERE width>=3840 OR height>=2160).
- Render screen Option B gate: `"ready"` phase shows resolution chips + peach CTA before committing. `buildConfig()` called at click time. Non-4K projects auto-start.
- C6 resize handle on done-state video player (exact C6 copy from Trimmer.tsx).
- `output_resolution` threaded through `run.py` → `render.py` → `normalise.py` + `transitions.py`. Default `"1080p"`.
- 4K normalise: `scale=-2:2160`; transitions canvas: `3840×2160`. `ultrafast` preset kept for intermediates (BATCH-C comment: keep at 1080p once proxy reuse lands).
- `[B1]` log markers in normalise.py + render.py for grep verification.
- `e2e/render.spec.ts`: conditional `renderBtn.isExisting()` check (4K=click, non-4K=skip).
- 7/7 fast E2E PASS.

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

**Batch H — App Shell Redesign (2026-05-09)**

- Deleted `StepNav.tsx` + `NavDrawer.tsx`; `AppShell` simplified to pass-through.
- Created `src/utils/fmtMs.ts` (shared duration formatter).
- Created `src/hooks/useConfiguredTabs.ts` — reads sessionStorage for transition/mood, returns `Set<"arrange"|"sound">`.
- Created `src/components/BottomTabBar.tsx` — Home/Trim/Arrange/Sound/Render with lucide-react icons, peach active, configured=white, unconfigured=`#a3a3a3`, render-guard `window.confirm`, `data-testid="tab-{name}"`.
- Created `src/components/TopInfoBar.tsx` — `h-7 bg-[#0a0a0a] border-b border-white/10`, project name + clip count + duration.
- Created `src/components/ChosenEffects.tsx` — blue `#99B3FF` chips for transition+mood; "None set" italic fallback; `data-testid="chosen-effects"`.
- Created `src/components/EditorShell.tsx` — 3-column content row (optional left panel, `<main>`, no persistent right aside) + full-width timeline row (`[w-52 gutter][filmstrip flex-1][w-48 ChosenEffects aside]`); `BottomTabBar` fixed at bottom.
- Restructured `Trimmer.tsx`, `Transitions.tsx`, `Sound.tsx`, `Render.tsx` to use `<EditorShell>`.
- `StickyFilmStrip`: removed right duration/chip sidebar; added `onDeleteClip` prop + hover-reveal bin icon (`group`/`group-hover` pattern); border-t-2 removed (EditorShell timeline row owns it).
- Timeline row always `[w-52 blank gutter][filmstrip][w-48 effects]` — filmstrip width identical on all screens.
- Video container fixed: `flex-1 min-h-0` (was `flex-shrink-0 + maxHeight`); video fills available height responsively on window resize.
- Controls column width unified to `w-48` (matches effects aside width — TrimBar and filmstrip share identical width).
- `LICENSES.md`: lucide-react MIT entry added.
- DESIGN.md: EditorShell and StickyFilmStrip sections fully rewritten.
- E2E: 9/9 fast PASS.

**Batch G — Ruler-based proportional timeline for StickyFilmStrip (2026-05-09)**

- `pipeline/proxy.py` `generate_proxy()`: upgraded to 1080p normalise-compatible spec (`scale=-2:1080 format=yuv420p -r 25 -fps_mode cfr -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -ar 48000`). Was 480p with `-c:a copy` (96kHz DJI audio passthrough bug). Timeout 600s kept.
- `pipeline/run.py`: `proxy_path_wsl` threaded through clip dicts after `clip_paths` construction.
- `pipeline/render.py`: `_proxy_height()` helper; `from .proxy import is_valid_proxy`; two-path normalise orchestration (`proxy_clip_indices` + `norm_clip_indices`); `TIMING:normalise=` now shows `proxy_skip=N/N`. Bug fix: proxy clips restore original `in_ms`/`out_ms` from `clips[i]` (B-0 offset mutation patch).
- `src-tauri/src/lib.rs`: `generate_proxy_file()` upgraded to 1080p spec; `start_job` manifest includes `"proxy_path": c.proxy_path`; `vacuum_proxies_cmd` new command (orphaned+stale deletion, `create_dir_all` guard, `SystemTime` mtime, registered in `generate_handler![]`); fire-and-forget vacuum call after `DONE:`.
- `src-tauri/src/db.rs`: `get_all_clip_ids()` added.
- Eval: first render `proxy_skip=0/4, normalise=45s`; re-render `proxy_skip=4/4, normalise=1.8s`; output 1920×1080 H.264 AAC 48kHz; sync drift < 34ms (sub-frame).

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
