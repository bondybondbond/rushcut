# RushCut — Phase 2 Build Plan

> **Phase goal:** The founder can upload a full 60+ clip DJI session, have RushCut intelligently filter and compile it into a 3–6 min film with music, card text, zoom, and smart moment selection — a film they're proud enough to publish.
> 
> **Phase 2 exit gate:** "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish." Not: paying users. Not: user testing scores. (See DEC-018, DEC-020.)

---

> **Competitor research:** See [`docs/COMPETITORS.md`](./COMPETITORS.md) for observations from testing competing products (Clipchamp, etc.) — useful for UX inspiration and feature prioritisation.

---

## Where Phase 1 Left Off

Phase 1 delivered a working pipeline end-to-end:

| Feature                       | Status                                        |
| ----------------------------- | --------------------------------------------- |
| Upload → Editor → Output flow | ✅ Working                                     |
| Silence/stillness detection   | ✅ Working                                     |
| xfade transitions             | ✅ Working                                     |
| 1080p export                  | ✅ Working                                     |
| Thumbnail persistence         | ✅ Working                                     |
| Music                         | ❌ Flag disabled — no MP3s in Lambda           |
| Card text overlay             | ❌ drawtext unavailable on ARM64 static FFmpeg |
| Zoom                          | ❌ zoom.py exists but disabled in frontend     |
| Per-clip in/out handles       | ❌ Not built                                   |
| Boring clip filtering         | ❌ Not built                                   |
| Beat-sync music               | ❌ Not built                                   |
| Director intent (Gemini)      | ❌ Not built                                   |
| Auth / accounts               | ❌ Not built — localStorage only               |
| >20 clips / real sessions     | ❌ Limited to 20 clips, 1GB per file           |

**Honest assessment:** Phase 1 is a clip stitcher with silence detection and a nice UI. The "Director, not Editor" principle from the PRD hasn't been delivered yet — the intelligence and scale are Phase 2.

---

## Batch 7 — P1 Carry-overs + Quick Wins

> **Goal:** Close Phase 1 gaps. After this batch, a 3-clip test produces a film with working music, text on cards, and subtle zoom. No new concepts — all the code scaffolding already exists.
> **Estimate:** 2–4 hours.

### 7a — Card text overlay (Pillow)

`drawtext` is unavailable in the ARM64 johnvansickle static FFmpeg build. Workaround: use Pillow to render a PNG frame with text baked in, then loop it to a 3s video.

**lambda/pipeline/cards.py changes:**

1. Import Pillow (`Pillow` already installable in Lambda — add to `requirements.txt`)
2. `make_card_frame(text, color, width, height)` → saves `/tmp/card_XXXX.png` using `ImageDraw.text()`
3. Use a bundled font (`lambda/fonts/Inter-SemiBold.ttf` or system fallback)
4. Replace current `drawtext` attempt with: `ffmpeg -loop 1 -i /tmp/card.png -t 3 -c:v libx264 ...`
5. Test: "intro text" + "outro text" show correctly in rendered film

**Frontend:** ConfigurePanel intro/end card text inputs already exist and send to Lambda — no frontend changes needed.

Gate: Film renders with card text visible. If text is empty, card falls back to solid colour.

---

### 7b — Music tracks

**lambda/music/:** Upload 4 royalty-free MP3 tracks:

- `cinematic.mp3` — slow, orchestral
- `upbeat.mp3` — energetic, travel
- `chill.mp3` — lo-fi, ambient
- `electronic.mp3` — driving beat

Source: Pixabay Audio (CC0) or ccMixter. Max 90s each (Lambda `/tmp` is limited). Trim to 90s and apply loudnorm.

**Lambda env:** Set `NEXT_PUBLIC_MUSIC_ENABLED=true` in Vercel after MP3s are bundled in image.

**music.py** is already written and tested. No Lambda code changes needed beyond having the files present.

Gate: Music mood picker is visible in editor. Selected mood plays in rendered film. "None" still works.

---

### 7c — File size limit: 1GB → 2GB

The PRD sets 2GB per file. The author's largest DJI clip is 1.4GB (4K 30fps, 3 min). The 1GB guard blocks real use.

**src/app/api/upload/presign/route.ts:** Change `MAX_FILE_BYTES` constant from `1 * 1024 ** 3` to `2 * 1024 ** 3`.
**src/components/upload/UploadZone.tsx:** Update the client-side guard and the "up to 1 GB each" UI copy to "up to 2 GB each".
**R2:** Confirm multipart upload is enabled for large files (already handled via presigned URL).

Gate: 1.4GB DJI clip uploads without being rejected.

---

### 7d — Enable zoom

`zoom.py` is already written and tested. The frontend always sends `zoom: false`. Change the default to `true`.

**src/app/editor/[projectId]/page.tsx** (or wherever `config` is constructed before POST to `/api/jobs/create`): change `zoom: false` to `zoom: true`.

Consider adding a zoom toggle chip to the ConfigurePanel so the user can turn it off for static/interview clips.

Gate: Rendered film shows subtle centre-frame zoom on each clip. No new artefacts.

---

### Batch 7 verification

Upload 3 DJI clips. Confirm:

- [ ] Card text appears on intro + outro
- [ ] Music track plays and fades out cleanly
- [ ] 1.4GB clip accepted
- [ ] Zoom visible on clips
- [ ] Film is a step-change improvement vs Phase 1

---

## Batch 8 — Local Pipeline Rebuild (PIVOT)

> **Why the pivot:** At 30 Mbps upload, a 1.9 GB clip takes ~8 min to upload; the 19 GB / 62-clip target session takes ~84 min. Cloud-upload model is unworkable for real sessions. (DEC-022)
> **New model:** Next.js UI runs locally (`pnpm dev`). Pipeline runs in WSL2 via child_process spawn. No R2 for inputs. No Lambda. No Docker.
> **Goal:** Throw the full 62-clip / 19 GB DJI session at RushCut, get a watchable film, zero upload wait.
> **Estimate:** 1-2 days.
> **This is the batch that makes RushCut actually useful for the founder's real use case.**

### 8a — Pipeline directory: lambda/pipeline/ -> pipeline/

Copy the working Lambda pipeline to a top-level `pipeline/` directory. Remove Lambda-specific wrapper. Add CLI entry point.

**Steps:**

1. Copy `lambda/pipeline/*` -> `pipeline/` (preserves normalise, detect, trim, transitions, cards, music, loudnorm, zoom, render)
2. Copy `lambda/fonts/` -> `pipeline/fonts/` (DejaVuSans.ttf for Pillow cards)
3. Copy `lambda/music/` -> `pipeline/music/` (4 bundled MP3s)
4. Create `pipeline/run.py` -- CLI entry point: reads job + clips from Supabase, runs full pipeline, writes output, updates job status
5. Update `pipeline/utils.py`: change FFMPEG_PATH to `/usr/bin/ffmpeg` (WSL2 system FFmpeg)
6. Add `win_to_wsl(path)` helper in utils.py: `C:\clips\foo.mp4` -> `/mnt/c/clips/foo.mp4`
7. `lambda/` directory kept as reference archive -- do not delete

---

### 8b — Upload page -> Folder scan

Replace file drag-drop upload UI with a local folder path input. No file transfer. No R2.

**UI (`/upload`):**

- Replace UploadZone with a text input: "Enter folder path" (default: `C:\clips\`)
- On submit: POST to `/api/projects/scan` with `{ folderPath: 'C:\\clips\\' }`
- Show scanned clip list: filename, size, duration (probed via WSL2 ffprobe)

**API route `POST /api/projects/scan`:**

- Spawns: `wsl -d Ubuntu-24.04 -- python3 /mnt/c/apps/rushcut/pipeline/scan.py --folder /mnt/c/clips/`
- `scan.py` outputs JSON array: `[{ filename, local_path, size_bytes, duration_ms, width, height }]`
- API creates Supabase project + clip rows with `local_path` column (no r2_key)
- Supabase `clips` table: add `local_path TEXT NULL` column

**`pipeline/scan.py`** -- new file: glob MP4/MOV/MKV in folder, run ffprobe for duration + dimensions, return JSON.

---

### 8c — jobs/create: Lambda invoke -> local process spawn

Replace `invokeLambda()` with a Node.js `child_process` spawn.

**`src/app/api/jobs/create/route.ts`:**

- Remove `invokeLambda()` call
- Replace with: `spawn('wsl', ['-d', 'Ubuntu-24.04', '--', 'python3', '/mnt/c/apps/rushcut/pipeline/run.py', '--job-id', jobId])`
- Fire-and-forget: `run.py` updates Supabase job status as it progresses (same polling contract as before)

**`pipeline/run.py`:**

- Reads job config + clip local_paths from Supabase
- Runs full pipeline (normalise -> detect -> trim -> transitions -> cards -> music -> loudnorm)
- Output: `/mnt/c/clips/processed/[jobId].mp4`
- Updates job: `status = final_ready`, `local_output_path = 'C:\\clips\\processed\\[jobId].mp4'`

---

### 8d — Output serving via local stream

**Supabase `jobs` table:** Add `local_output_path TEXT NULL` column.

**`src/app/api/output/[jobId]/video/route.ts`** -- new route:

- Reads `local_output_path` from Supabase
- Streams the file with range request support (so the video player can seek)
- Returns `Content-Type: video/mp4`

**Output page:** Replace `finalUrl` (R2 presigned URL) with `/api/output/[jobId]/video`. No other UI changes needed.

---

### 8e — Boring clip filter + smart selection

**`pipeline/detect.py`** -- add `motion_score(clip_path) -> float`:

```python
ffmpeg -i clip.mp4 -vf "select='gt(scene,0.02)',metadata=print:file=-" -an -f null -
```

Parse scene change scores, return average.

**`pipeline/render.py`** -- after normalise, before trim:

- Score all clips
- Auto-exclude clips below `MOTION_FILTER_THRESHOLD` (default 0.015, env-configurable)
- If >20 clips remain, rank by `motion_score * duration_weight`, keep top 20
- Log excluded clips to Supabase job `excluded_clips JSONB` column

**Frontend editor:** When clips are excluded, show: "We selected X of Y clips based on visual interest."

---

### Batch 8 verification

Run the full DJI session (`C:\clips\` -> 62 clips, ~19 GB):

- [ ] Folder scan completes in <30s (no upload wait)
- [ ] All 62 clips appear in editor with thumbnails
- [ ] Near-static clips auto-excluded (verify via job status JSON)
- [ ] Best clips auto-selected -- film makes visual sense without manual curation
- [ ] Film renders end-to-end, output plays in browser via local stream
- [ ] Total time from folder scan to watchable film: <10 min

---

## Batch 9 — Director Intelligence ⚠️ SUPERSEDED

> **Superseded by Batch 13 (2026-03-28 direction session).** The Gemini API approach was deferred; the UX
> screen was moved to Batch 15 (after Batch 14 Clip Editor exists). Batch 13 delivers the same pipeline
> intelligence (motion scoring, peak window, beat-sync) using FFmpeg/librosa only. See Batch 13 below.

> **Goal:** The user gives intent ("cinematic, start with mountain shots, fast cuts") and gets a film that actually reflects it. This is the "Director, not Editor" principle from the PRD — the differentiating layer that separates RushCut from Clipchamp and every other clip stitcher.
> **Estimate:** 2–3 days.
> **This is the batch that makes the output feel made, not assembled.**

### 9a — Brief text input → Gemini 2.0 Flash ordering

The PRD specifies an optional brief as a starting point. Gemini 2.0 Flash at ~$0.001/export makes this economically free-tier viable.

**ConfigurePanel:** Add a brief text field (already existed in Phase 1 PRD screen spec but was removed). Keep it optional, single line: "e.g. start with the mountain shots, make it feel cinematic"

**lambda/pipeline/render.py** — new `apply_brief(clips_metadata, brief_text) -> clip_order[]`:

```python
# Build a prompt: clip list with filename, duration, motion score, timestamp
# Ask Gemini 2.0 Flash to return a ranked order + style recommendation
# Returns: ordered clip IDs, suggested transition style, suggested music mood
```

Only fires if `brief` is non-empty. Falls back to timestamp order if Gemini fails or times out.

**Cost guard:** Gemini 2.0 Flash input ~$0.075/1M tokens. A 20-clip brief prompt is ~300 tokens = $0.00002. Acceptable.

---

### 9b — Beat-sync music cuts via librosa

Instead of silence-detection trim points, also detect musical beat positions in the selected track and prefer clip cuts at beat boundaries.

**lambda/pipeline/music.py** — add `get_beat_times(track_path) -> List[float]` via librosa:

```python
import librosa
y, sr = librosa.load(track_path)
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
beat_times = librosa.frames_to_time(beat_frames, sr=sr)
```

**lambda/pipeline/transitions.py** — when calculating xfade offsets, snap clip join points to nearest beat time within ±0.3s.

Gate: Rendered film feels musically timed — cuts arrive on beats, not mid-phrase. Obvious improvement on the cinematic and upbeat tracks.

---

### 9c — Motion peak detection within clips

The current silence detector finds dead sections at the clip start/end. This finds the *peak moment* within a clip — the 5–10 seconds where the most interesting thing happened.

**lambda/pipeline/detect.py** — add `find_peak_window(clip_path, duration_s=8) -> (start_ms, end_ms)`:

- Sample motion scores at 0.5s intervals across the whole clip
- Find the `duration_s`-length window with highest average motion score
- Return start/end of that window as preferred trim points

Use this as the default in/out for each clip when no user-set handles exist, replacing the current "trim silence from start/end" approach with "extract the best moment".

**Interaction with Batch 8c (user handles):** User-set handles always win. Motion peak is the fallback default.

Gate: Upload a 3-minute DJI clip where the interesting moment is in the middle. Verify the output shows the middle section, not the full clip.

---

### Batch 9 verification

Run a real DJI session with brief "fast cuts, start with the landscape shots":

- [ ] Film opens with wide landscape shots (Gemini ordering working)
- [ ] Cuts align with music beats (librosa working)
- [ ] Each clip contributes its best 5–10 seconds, not full duration (motion peak working)
- [ ] Total film runtime is 3–6 mins without manual trimming
- [ ] Brief inference is reasonable — not random

---

## Batch 10 — Auth + Library ⚠️ SUPERSEDED

> **Superseded by Batch 16 (2026-03-28 direction session).** Consolidated with 4K output and Pro tier
> gating into a single auth+monetisation batch. Content preserved below for reference.

> **Goal:** User has an account. Projects persist. The product is ready to share with others.
> **Estimate:** 1 day.
> **Prerequisite for external sharing / user testing / Phase 3 pricing.**

### 10a — Supabase Auth

- Email + Google OAuth (Supabase built-in)
- Login gate fires at "Continue" on upload page (not before — no server cost before auth)
- `user_id` column already exists as `NULL` on `projects` table — populate on project create

### 10b — RLS policies

```sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user sees own projects" ON projects FOR ALL USING (user_id = auth.uid());
-- clips and jobs inherit via project_id FK cascade
```

Switch API routes from service role key to Supabase Auth session tokens.

### 10c — Project library page (`/library`)

- List user's projects with thumbnail, clip count, date, status
- Link to editor (in progress) or output (completed)
- Delete project (cascades to clips + R2 cleanup)

### 10d — 30-day retention + cleanup

Supabase scheduled function (pg_cron) or Vercel cron: daily job that:

1. Finds `jobs` rows where `final_r2_key` is set and `updated_at < now() - interval '30 days'`
2. Deletes R2 objects via API
3. Marks job `status = 'expired'`

### Batch 10 verification

- [ ] Register with email → project persists after browser close
- [ ] Library shows all user's projects
- [ ] Auth-less access to `/upload` redirects to login after "Continue"
- [ ] Other users cannot see each other's projects
- [ ] 30-day cleanup job runs without error

---

## Phase 2 Exit Gate

**"I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish."**

Specific criteria:

- [ ] Uploaded 60+ clips from a real trip (not test clips)
- [ ] RushCut auto-selected and auto-trimmed without manual pre-curation
- [ ] Card text, music, zoom all working
- [ ] Film is 3–6 minutes and tells a coherent visual story
- [ ] Published (YouTube / shared with family)

This is the Phase 2 gate. Payment gate is Phase 3.

---

## Research Tracks (parallel to code — not blocking)

These are not batches. Do them as time allows.

### RT-1 — Competitive audit: web auto-edit tools

Study 4–5 web-only competitors. Focus: how many clicks to a rendered film? What does auto-edit feel like?

Candidates: Clipchamp Web, Kapwing, WeVideo, FlexClip, Clideo.
Explicitly exclude: DaVinci Resolve, Clipchamp Desktop, LightCut (mobile-only).

Document in a scratch note. Key question per product: "Does this feel like directing or editing?"

### RT-2 — User testing (after Batch 8, before Batch 10)

Once boring clip filter + music + zoom work (Batches 7+8 done), recruit 3–5 DJI/GoPro users via UserTesting.com.

Task: "You just got back from a trip with 30 clips. You have 5 minutes. Make a shareable video."

Append 3 Mom Test questions at the end:

1. "What's the last time you filmed footage you never edited? What stopped you?"
2. "What tool do you currently use for travel video? What do you wish it did differently?"
3. "What would 'good enough to share' look like for you?"

This is a usability + problem-validation hybrid. Do not run before Batches 7+8 — the product needs to be complete enough to test. Do not run before Batch 10 — users need an account to show them (and for you to see their output later).

---

## Batch 11b — Autonomous E2E Testing (tauri-driver)

> **Goal:** Claude can see what the user sees. After every code session, Claude runs a full UI walk-through — upload clips, render, check output — without a human in the loop.
> **Estimate:** 2–4 hrs setup, then zero ongoing cost.
> **Why now:** Batch 11 UI changes were verified by TypeScript + build only. Claude could not click buttons or watch the video player. This batch fixes that permanently.

---

### Why the browser preview doesn't work

RushCut renders blank in a standard headless browser because `window.__TAURI_INTERNALS__` is not injected outside the Tauri WebView. `invoke()`, `listen()`, and `convertFileSrc()` all depend on it. The only way to drive the real app is via the compiled Tauri binary.

---

### 11b-1 — Add `data-testid` attributes to key elements

Claude does this in ~30 min before any driver work. Targets:

| Element                | `data-testid`       |
| ---------------------- | ------------------- |
| "Choose Folder" button | `btn-choose-folder` |
| "Add Files" button     | `btn-add-files`     |
| Clip list item         | `clip-item`         |
| Continue/Render button | `btn-render`        |
| Project name heading   | `project-name`      |
| Hamburger nav button   | `btn-nav-open`      |
| Music chip (each mood) | `chip-music-{mood}` |
| Intro text input       | `input-intro-text`  |
| Outro text input       | `input-outro-text`  |
| Progress bar           | `progress-bar`      |
| Output video player    | `video-player`      |
| Output filename label  | `output-filename`   |

Files to touch: `Upload.tsx`, `Editor.tsx`, `SettingsPanel.tsx`, `Output.tsx`, `NavDrawer.tsx`

---

### 11b-2 — Install tauri-driver + msedgedriver

```powershell
# From PowerShell (NOT Git Bash — paths get mangled)
cargo install tauri-driver

# Download msedgedriver matching your Edge version:
# Edge version: Settings > Help > About. Download from:
# https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/
# Drop msedgedriver.exe somewhere in PATH (e.g. C:\tools\)
```

Add to `package.json`:

```json
"scripts": {
  "test:e2e": "pnpm build && webdriverio run wdio.conf.ts"
}
```

Add `wdio.conf.ts` — tauri-driver spawns the real `.exe` and drives it via WebDriver protocol. Claude adapts the community config (already exists on GitHub) to this repo.

**Key config gotcha:** All paths in `wdio.conf.ts` must be Windows-native (`C:\...`). Do not use WSL paths. Run `pnpm test:e2e` from PowerShell only.

---

### 11b-3 — Write smoke test suite

Claude writes the following specs in `e2e/` using WebdriverIO's `$('[data-testid="..."]')` selectors:

**Spec 1 — Upload flow**

- App opens → upload screen visible
- Click "Choose Folder" → file dialog appears (or cancel gracefully)
- Nav drawer opens/closes on hamburger click

**Spec 2 — Editor flow** (requires a pre-seeded test project in SQLite)

- Project name is editable (click → input appears → blur saves)
- Music default is "No Music"
- Zoom toggle is disabled/greyed
- Card colour swatches appear only after text is entered
- "← Back" navigates to Library

**Spec 3 — E2E render** (uses the 3 short test clips already in `C:\clips\`)

- Scan folder → clips appear
- Click Render → Output screen appears
- Progress bar increments (poll every 2s, timeout 5 min)
- Video player `src` is set once done
- Output filename matches `[slug]-[8chars].mp4` pattern

---

### 11b-4 — Wire into Claude Code hook (optional)

In `.claude/settings.local.json`, add a post-edit hook:

```json
"hooks": {
  "PostToolUse": [{
    "matcher": "Edit|Write",
    "hooks": [{ "type": "command", "command": "powershell.exe -Command \"echo '[hook] run pnpm test:e2e to verify'\"" }]
  }]
}
```

Full auto-run on every edit is optional — the 3-min render timeout makes it slow. Recommended: Claude runs it explicitly at end of each session.

---

### Gate

- [ ] `pnpm test:e2e` passes all 3 specs against a fresh app launch
- [ ] Claude can read pass/fail output and self-diagnose a failing test
- [ ] No human required to verify UI after a code session

---

## Batch 11c — UX Polish Round 2

> **Goal:** Close remaining UX gaps from second round of post-Batch-11 feedback. All items are UI-only or pipeline config fixes — no new Rust commands needed.
> **Estimate:** 3–5 hrs. Can run in a single chat session.

### Bugs fixed inline (not deferred)

- **Card colour hardcoded to black** — `run.py` was ignoring `intro_color`/`outro_color` from settings; fixed in Batch 11 session.
- **zoom/silence_removal defaulting to True** — corrected to False in `run.py`.

---

### 11c-1 — Mandatory project name prompt

**Problem:** Project name is editable on the Editor screen via a pencil icon, but it's invisible to most users. Without a name, the output file gets an ugly slug like `clips-a3f8bc12.mp4`. Most users will never discover the inline edit.

**Fix:** After user selects clips and clicks Continue (before `create_project` is called), show a **name prompt modal**:

- Single input: "Name your project" (required, min 2 chars)
- Placeholder: "e.g. Dolomites Trip, Summer 2026"
- CTA: "Create Project" (disabled until name entered)
- Small skip link: "Skip" (uses folder/file name as fallback — same as current behaviour)

The output file will then be `dolomites-trip-a3f8bc12.mp4` from the first render.

**Files:** `Upload.tsx` (add modal state + prompt UI before `navigate()`). No Rust changes needed — `create_project` already accepts `name`.

---

### 11c-2 — Scan loading spinner

**Problem:** After selecting folder/files, app goes grey/unresponsive with no feedback while scan.py runs (can take 5–15s for large folders).

**Fix:** In `Upload.tsx`, show a spinner overlay or animated status line during `scanning` state.

- Replace the disabled-button greying with an explicit `<ScanningState />` component
- "Scanning your clips..." with a small spinner animation (CSS only — no library needed)
- Show clip count as they resolve: "Found 12 clips..."

---

### 11c-2 — Home screen redesign

**Problem:** First screen is a blank upload zone. Not welcoming for recreational users.

**New layout:**

```
[RushCut logo / wordmark — centred]

[ START NEW PROJECT         ]   [ RESUME A PROJECT          ]
[ "Create a film in minutes"]   [ [thumb] Project name      ]
[ Choose Folder / Add Files ]   [ [thumb] Project name      ]
[                           ]   [ [thumb] Project name      ]
[___________________________|   [___________________________|
```

Two big equal-width cards side by side (or stacked on narrow window):

- **Left:** peach border, folder icon, "Start New Project" in large font, sub: "Create a film in minutes." Clicking shows the existing folder/file pickers.
- **Right:** sand border, history icon, "Resume a Project." Shows 3 most recent projects as rows with thumbnail + name. Clicking opens `/editor/:projectId`.

If no previous projects: right card shows "No projects yet" placeholder.

**Files:** `Upload.tsx` (major rewrite of layout), `Library.tsx` (extract recent-project query into a shared hook or inline fetch).

---

### 11c-3 — Remove manual path input entirely

**Problem:** "Paste a folder path..." text input is a power-user feature that confuses recreational users.

**Fix:** Delete the entire `<form>` section from `UploadZone.tsx`. Keep only the drag-drop zone and the two picker buttons ("Choose Folder", "Add Files") from `Upload.tsx`.

The drag-drop zone label can update to: "Or drag a folder here."

---

### 11c-4 — Restore transition picker

**Problem:** The Batch 6 settings panel had crossfade / dip-to-black transition choices. Removed in Phase 2 rewrite. Pipeline (`render.py` line ~290) still reads `config.get("transition", "crossfade")` — the picker just needs to come back to the UI.

**Fix:** Add to `SettingsPanel.tsx`:

```tsx
{/* Transition */}
<div className={row}>
  <p className={label}>Transition</p>
  <div className="flex gap-2">
    <Chip active={config.transition === "crossfade"} onClick={() => update({ transition: "crossfade" })}>Crossfade</Chip>
    <Chip active={config.transition === "dip_to_black"} onClick={() => update({ transition: "dip_to_black" })}>Dip to black</Chip>
  </div>
</div>
```

Add `transition: "crossfade"` to `JobConfig` type and `DEFAULT_CONFIG`.

---

### 11c-5 — Nav drawer: fixed position + consistent location

**Problem:** Hamburger appears top-left on Upload but moves on other screens. Should be top-left everywhere, same visual weight as a proper button.

**Fix:**

- Wrap all pages in a shared `<AppShell>` layout component that renders the nav drawer at a fixed top-left position (absolute or sticky `fixed top-4 left-4 z-50`)
- Give the hamburger more button appearance: `rounded-md border border-white/20 p-2 bg-white/5 hover:bg-white/10`
- Remove per-page `<NavDrawer />` inline usage — single source in AppShell

**Files:** New `src/components/AppShell.tsx`, update `App.tsx` to wrap routes.

---

### 11c-6 — Download button on Output screen

**Problem:** No obvious way to "save" or "open" the finished film. The video player is embedded but there's no export/download action.

**Fix:** Add a big peach button below the video player on the done state:

- "Open File" → calls `invoke("open_output_path", { path: outputPath })` which runs `explorer.exe /select,<path>` to reveal the file in Windows Explorer.
- New Rust command `open_output_path(path: String)` using `std::process::Command::new("explorer").arg(format!("/select,{}", path)).spawn()`.

---

### 11c-7 — Fix rendering screen copy for desktop

**Problem:** "Switch tabs and come back whenever" is browser-only advice — meaningless in a desktop app.

**Fix:** Already partially done in Batch 11. Confirm Output.tsx reads:

> "1080p renders take 2–5 min."

Remove "switch tabs" entirely.

---

### 11c-8 — "4K coming soon" note on Upload screen

**Problem:** The 4K notice only appears in SettingsPanel (screen 2). Should also appear on the Upload screen.

**Fix:** Add a small muted note below the picker buttons in `Upload.tsx`:

```tsx
<p className="text-xs text-[#a3a3a3]">
  Output: 1080p · <span className="text-[#C9A96E]">4K coming soon</span>
</p>
```

---

### Deferred to later batches

| #                                    | Item                                                                                                                                                                                                                                                                                                                                      | Batch     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Silence/boring clip verification     | Needs tauri-driver E2E (Batch 11b)                                                                                                                                                                                                                                                                                                        | 11b       |
| Delete project from My Projects      | Rust `delete_project` cmd + Library UI                                                                                                                                                                                                                                                                                                    | 12        |
| Project name → output filename       | Fixed in Batch 11 (`slugify`). Mandatory name prompt (11c-1) closes the edge case.                                                                                                                                                                                                                                                        | 11c       |
| Proxy / low-res preview files        | **Required for interactive timeline (Batch 13+), not now.** DJI HEVC at source res will stutter during frame-accurate scrubbing in the WebView. Generate H.264 720p proxies on project create (scan.py step); use for editor preview, discard for final render. ~10s/clip in WSL2 FFmpeg. Flag when interactive trim/zoom UI is designed. | 13+       |
| Music volume vs. clip volume control | Add `music_volume` slider (0–100, default 40) to SettingsPanel → pass to `music.py` as `-filter:a "volume=X"` on the music track before mix                                                                                                                                                                                               | 12        |
| Audio sample rate normalisation      | Output currently inherits 96kHz from DJI source. Force `-ar 48000` in final mux step for compatibility.                                                                                                                                                                                                                                   | 11c or 12 |
| Stale job cleanup in Library         | Interrupted pipeline runs stay stuck at "Processing" forever. Add a timeout or heartbeat check to mark stale jobs as "Failed".                                                                                                                                                                                                            | 12        |
| Pipeline failure UI on Output page   | If WSL/FFmpeg unavailable or pipeline errors out, Output page hangs at "Waiting..." with no timeout or error message. Add a 10-min timeout + failure state.                                                                                                                                                                               | 11c or 12 |
| React Router v7 future flags         | Add `v7_startTransition` and `v7_relativeSplatPath` flags to `<BrowserRouter>` before upgrading to React Router v7.                                                                                                                                                                                                                       | 11c       |
| E2E test: fresh-install seed         | render.spec.ts relies on existing projects. Add a `--e2e-seed` flag or test fixture to create a project with clips for fresh installs.                                                                                                                                                                                                    | 12        |
| Programmatic clip loading for eval   | `invoke("scan_folder")` returns data but doesn't update Upload page React state. Add a Tauri command or JS bridge that triggers the full `handleScan` flow so the eval skill can populate the UI without the native file dialog.                                                                                                          | 12        |

---

### Gate

- [x] Name prompt appears after clip selection; project name is mandatory before editor opens
- [x] Scan shows spinner during folder/file processing
- [x] Home screen has two-card layout; recent projects visible on right
- [x] Manual path input gone
- [x] Transition picker (None / Crossfade / Dip to black) visible and working; default is None
- [x] Hamburger is top-left, same position on all 4 screens, looks like a button
- [x] Output screen: "Open File" reveals file in Explorer
- [x] Rendering copy replaced with live elapsed count-up timer
- [x] "4K coming soon" visible on Upload screen
- [x] E2E eval: 41/41 PASS

---

---

## Batch 12b — Music Mode Presets

> **Goal:** Replace the raw 0–100 `music_volume` slider (Batch 12) with named presets that are meaningful to non-technical users.
> **Estimate:** 1–2 hrs. Touches 4 files across 3 layers — expect a Tauri recompile. Diagnose IPC before fixing if anything breaks.

Replace `music_volume: number` (0–100 integer) with `music_mode: "subtle" | "balanced" | "prominent"`:

| Preset      | Label     | Internal float | User meaning                |
| ----------- | --------- | -------------- | --------------------------- |
| `subtle`    | Subtle    | 0.15           | Voice / clip audio dominant |
| `balanced`  | Balanced  | 0.35           | Music and clip audio equal  |
| `prominent` | Prominent | 0.60           | Music-forward               |

**Files to change:**

- `src/types.ts` — `music_volume: number` → `music_mode: "subtle" | "balanced" | "prominent"`
- `src/pages/Editor.tsx` or `src/components/SettingsPanel.tsx` — 3-chip preset group replacing slider; only shown when music track ≠ "None"
- `src-tauri/src/lib.rs` — `JobConfig` struct: same field rename
- `pipeline/run.py` — map `music_mode` → float before calling `mix_music()`; remove the old `/ 100.0` division

Note: the 0–100 float slider is a future Pro feature for the Timeline Editor (Batch 14+).

### Gate

- [x] Subtle / Balanced / Prominent chips visible in SettingsPanel when music track selected
- [x] Pipeline uses correct float per mode — implemented as 0.2 / 0.4 / 0.7 (vs 0.15/0.35/0.60 in plan — rounded up for a fuller sound)
- [x] Field kept as `music_volume` (not renamed to `music_mode`) — type changed to union string

> **Delivered 2026-03-28.** E2E: 7/7 fast PASS, chips render correctly, no console errors. Also fixed 5 pre-existing E2E spec bugs in this session.

---

## Batch 13 — Motion Intelligence

> **Goal:** A 60+ clip DJI session produces a watchable 3–6 min film with no manual clip curation.
> **Estimate:** 2–3 days (pipeline only — no new screens, no new Rust commands).
> **This is the batch that makes the Phase 2 exit gate achievable.**
> 
> Note: Gemini API deferred. All intelligence is FFmpeg/librosa-only. AI Director screen is Batch 15.

### 13a — Boring clip filter (motion scoring)

Score each clip using FFmpeg scene change detection:

```python
ffmpeg -i clip.mp4 -vf "select='gt(scene,0.02)',metadata=print:file=-" -an -f null -
```

Parse scene change scores → return `motion_score: float` per clip. Auto-exclude clips below `MOTION_FILTER_THRESHOLD` (default 0.015, configurable via env).

### 13b — Smart clip cap (>N clips)

When more than N clips remain after motion filtering (default N=20), rank by `motion_score × duration_weight`, keep top N. Log excluded clips and reasons to job metadata for later display.

### 13c — Peak window detection

Per clip, find the best-N-seconds window using motion score sampled at 0.5s intervals. Return `(start_ms, end_ms)` of the highest-scoring window as default in/out points. Replaces silence-trim as the default trim heuristic. User-set handles always win.

### 13d — Beat-sync music cuts

Via librosa: detect beat times in the selected music track. When calculating xfade offsets in `transitions.py`, snap each cut point to the nearest beat within ±0.3s. Falls back to timestamp order if no music selected or librosa fails.

### UI surface

SettingsPanel shows "Using X of Y clips · N excluded" (read-only). No new screens.

### Gate

- [x] Code delivered: motion.py, beats.py, render.py rewrite, db analysis_summary, SettingsPanel toggle. E2E: 25/25 PASS.
- [ ] 62-clip / 19 GB DJI session → watchable film — BLOCKED: motion scoring adds >10 min overhead (see Batch 13b)
- [ ] Near-static clips auto-excluded — BLOCKED pending Batch 13b decision
- [ ] Film runtime 3–6 min without manual trimming
- [ ] Cuts align with music beats — DEFERRED ("not required now")

> **Delivered 2026-03-29.** Motion scoring subsequently found to add >10 min on 10 min footage. Motion scoring removed in Batch 13b per DEC-023. Product direction pivots to user-directed clip review (Batch 14, revised).

---

## Batch 13b — Pipeline Fix + UI Cleanup

> **Goal:** Remove motion scoring overhead, fix UI polish bugs, add pipeline timing diagnostics.
> **Estimate:** 2–4 hrs.
> **Prerequisite for Phase 2 exit gate.** Pipeline must complete a 10 min session in under 3 min before any further feature work.

### 13b-1 — Remove motion scoring from pipeline

- Remove `filter_by_motion`, `find_peak_window`, `scored_frames_map` wiring from `render.py`
- Revert trim heuristic: use `detect.py` silence trim as default (was the behaviour before Batch 13)
- Keep beat-sync stubs but confirm they add <5s overhead (librosa load only runs if music selected)
- `run.py`: remove `filter_boring` from active config path; set default `False` or remove key
- `pipeline/motion.py`: keep file untouched — dead code, not called

### 13b-2 — Hide filter_boring toggle in SettingsPanel

- Remove "Smart Clip Selection" row from SettingsPanel
- Keep `filter_boring` in `JobConfig` TypeScript type (for future use)
- Keep `DEFAULT_CONFIG.filter_boring = false`

### 13b-3 — Filename versioning

- Output filename: `slug-01.mp4`, `slug-02.mp4` (per-project counter) not `slug-{8char-uuid}.mp4`
- Rust `lib.rs` `start_job` / output path computation: count existing files matching `<slug>-NN.mp4` in `C:\clips\processed\`, pick next N (zero-padded to 2 digits)

### 13b-4 — Volume chip color

- Music volume preset chips (Subtle / Balanced / Prominent): change accent from `#FF8A65` (orange) to `#99B3FF` (blue)
- Document in `docs/DESIGN.md` under "Chip / toggle accent" section

### 13b-5 — Per-stage timing logs

- In `render.py`, record `time.time()` at each stage boundary
- Emit `STAGE:Timing: <stage>=<elapsed:.1f>s` as STAGE lines so they appear in Rust job log
- Enables bottleneck diagnosis without reading Python internals

### 13b-6 — Fix toggle translate-x visual bug

- `h-5 w-9` container (36px × 20px), `h-3.5 w-3.5` thumb (14px)
- "On" state `translate-x-4` = 16px — only moves thumb to centre. Correct value: `translate-x-[18px]` or `translate-x-[1.125rem]` to land thumb flush-right with 2px padding
- Audit all toggle instances in SettingsPanel

### Gate

- [x] Pipeline completes a 10-clip session in <2 min
- [x] No `filter_boring` toggle visible in SettingsPanel
- [x] Output file named `slug-01.mp4` not `slug-{uuid}.mp4`
- [x] Volume preset chips render in blue `#99B3FF`
- [x] Terminal output shows per-stage timing when pipeline runs
- [x] Toggle thumb visually reaches right end in "on" state

> **Delivered 2026-03-29.** All 6 tasks complete. Post-batch hotfixes also shipped: portrait+landscape crash (`transitions.py` fixed-canvas pre-scale), normalise ultrafast preset, Output.tsx rolling timeout. E2E: 25/25 PASS.

---

## Batch 13c — Pipeline Reliability + Speed

> **Goal:** Fix remaining pipeline bugs found during real 4K footage testing. No new features — reliability only.
> **Estimate:** 1–2 days.
> **Prerequisite for Batch 14:** Music must loop; sync must be diagnosed before building per-clip trim controls on top of a drifting concat.

### 13c-1 — Music looping

`pipeline/music.py`: the MP3 track currently lays over the film once and ends. For films longer than the track (~2.5 min), music cuts off mid-film.

- Use `-stream_loop -1` on the music input to loop indefinitely, then trim to exact film duration
- Optional: add `-af "afade=t=out:st=<end-2>:d=2"` to fade out the last 2s cleanly
- Test with a >3 min render to confirm loop is seamless

### 13c-2 — Audio/video sync investigation

Audio sync drift observed during real-footage testing (speech visibly out of sync). Before fixing, log to identify the source:

- Add PTS logging at normalise output, trim output, and concat input
- Reproduce with a known drifting clip pair
- Likely candidates: silence-trim boundary cutting mid-frame, or audio concat offset drift across 3+ clips
- Fix only after root cause is confirmed in logs

### 13c-3 — Hardware HEVC decode

Normalise is still the main speed bottleneck (~60–90s for 3×4K clips after ultrafast fix). If WSL2 GPU passthrough is active (`/dev/dxg` present), `-hwaccel auto` can offload HEVC decode to the GPU.

- Probe: `ls /dev/dxg` and check `ffmpeg -hwaccels` output in WSL2
- If available: add `-hwaccel auto` before `-i` in `normalise.py` FFmpeg call; verify output is identical
- Do not implement blind — confirm decode offload actually fires before shipping

### Gate

- [x] Film >3 min renders with music looping to fill the full duration — PARTIAL: loops but audible gap at boundary; crossfade deferred to 13d
- [x] A/V sync root cause logged and identified — logging added (`[sync-check]` after normalise + post-trim); root cause analysis deferred to 13d
- [x] Hardware decode probed; implemented if WSL2 GPU passthrough confirmed — probed: `/dev/dxg` present but `VK_KHR_video_decode_queue` absent; CUDA/VDPAU absent. Software only. Comment in `normalise.py`.

> **Delivered 2026-03-30.** Music looping shipped (`-stream_loop -1` + `asetpts=PTS-STARTPTS` ordering). Sync logging in place. Hwaccel confirmed non-viable. Remaining: loop crossfade, sync root-cause fix, relative music volume, build speed — deferred to Batch 13d.

---

## Batch 14 — Clip Review (revised)

> **REVISED SCOPE (post-Batch 13 pivot):** Guided clip-review editor — user decides, pipeline executes. Replaces old "Clip Editor" timeline concept.
> **Positioning anchor:** "RushCut does not decide your memories for you. It helps you shape them quickly."
> **Prerequisite:** Batch 13b + 13c complete. Proxy generation (14b) should be the first task in this batch — scrubbing in clip review is unusable without proxies on 4K HEVC.
> **Estimate:** 4–6 days (new screen, proxy generation, per-clip DB model).

### 14a — Sequential clip review screen

New route: `/review/:projectId`. Replaces direct jump from Upload → Editor for sessions with >5 clips.

**Two review modes per clip — Quick is the default:**

**Quick mode (default, collapsed):**

- Full-width video player (proxy if available, source otherwise)
- Include / Skip buttons (large, keyboard-accessible: `Enter` = include, `Space` = skip)
- Focal point picker (tap to mark X/Y, or "Centre" default — single tap, no drag required)
- "Expand" affordance reveals Precise controls

**Precise mode (expanded per clip, opt-in):**

- Scrub bar with draggable IN/OUT handles
- Zoom preset: None / Gentle (1.1x) / Medium (1.3x) / Tight (1.5x)
- All Quick controls still present

Design intent: a user can review 60 clips using Quick mode only and still produce a good film. Precise mode is for hero shots where the user wants explicit control. Don't force full manual trimming on every clip.

Progress indicator: "Clip 3 of 12 — 9 remaining"

**Post-review Editor is intentionally minimal.** After Clip Review, the Editor contains only:

- Clip reorder
- Music mood + volume preset
- Transition style (global)
- Intro / Outro card text
- Render

No new controls should grow in the Editor. Any per-clip decision belongs in the Review screen, not here.

### 14b — Proxy generation

On project create (during scan), generate H.264 720p proxies for each clip:

- `ffmpeg -i source.mp4 -c:v libx264 -crf 28 -vf scale=-2:720 -c:a aac -ar 48000 proxy.mp4`
- ~5–10s per clip in WSL2; run in background after scan completes
- Store proxy path in `clips` table (`proxy_path TEXT`)
- Clip review screen uses proxy for scrubbing; final render always uses originals

### 14c — Per-clip data model (**DONE 2026-04-01**)

Added to `clips` table (7 columns): `in_ms`, `out_ms`, `focal_x`, `focal_y`, `zoom_mode`, `include` (default 1), `proxy_path`. Pipeline reads per-clip fields from manifest; user IN/OUT overrides silence trim. `start_job` filters `include==0` clips, clamps `out_ms` to `duration_ms`. `zoom.py` extended with 3 presets + focal-aware panning with edge clamping.

### 14d — Tabbed settings UI

Reorganise SettingsPanel into tabs: Music/Sound · Effects · Text (intro/outro cards).

### Gate

- [ ] Quick mode is default; Include/Skip works with keyboard; Precise mode expands per clip
- [ ] Proxy generation runs after scan; proxies used for scrubbing in review screen
- [x] Per-clip in_ms, out_ms, focal_x/y, zoom_mode passed through manifest to pipeline (14c)
- [x] Pipeline applies user IN/OUT over silence trim when set (14c)
- [x] Skipped clips excluded from render (14c)
- [ ] Post-review Editor contains only the 5 items listed above — nothing more
- [ ] Tabbed settings visible in Editor

---

## Backlog — Music Loop: Waveform-Matching Loop Point

> **Deprioritised — Batch 15+ or dedicated audio polish batch.**

**Problem:** Pairwise `acrossfade` crossfades wherever the track boundary happens to fall. If the track has a fade-out at the end and a fade-in at the start, both sides of the crossfade are near-silent — the gap persists.

**Immediate fix (14-P):** Strip track intro/outro silence before tiling (`silencedetect` → `atrim` to active region). Eliminates the silence-compounding effect without AI.

**Better fix (this backlog item):** Find a **waveform-match loop point** — two moments in the track where harmonic/spectral content is nearly identical, so the transition is musically continuous with no click and no gap. The loop plays from 0 → match_point → (jump back to matching start point) → match_point → ... with a crossfade window around the join.

**Implementation options:**
- librosa `beat_track` + `chroma_features` similarity to find the best two beat-aligned moments with matching spectral fingerprints
- Or a dedicated audio-loop library (e.g. `librosa`'s segmentation, or `essentia`)
- May also be addressable with a purpose-built AI audio model (loop-point detection as a learned task)

**This is a user-visible audio quality improvement** — qualifies under the AI policy (demonstrable, sellable) if AI is used. Do not implement speculatively; prioritise only after the silence-trim fix ships and real-footage testing confirms the gap is still audible.

---

## Batch 15 — AI Director Screen (deprioritised)

> **Goal:** Surface the AI's edit proposal explicitly, between Upload and Clip Editor. Makes "Director, not Editor" visible to the user.
> **Prerequisite:** Batch 13 (real clip analysis data) + Batch 14 (Clip Editor to land in after Accept).
> **Estimate:** 2–3 days.

New route: `/director/:projectId` — inserted into flow after scan completes, before `/editor/:projectId`.

### Layout (two-column)

**Left:** AI Proposal summary

- Style tags (e.g. "Energetic", "Dissolve transitions", "Upbeat track", "~2m 20s")
- "N of M clips used · X excluded"
- Actions: **Accept & Edit** → `/editor/:projectId` with AI order pre-loaded | **Regenerate** → re-run analysis | **Skip → Manual** → `/editor/:projectId` with original scan order

**Right:** Proposed clip order list

- Filename, trim duration, transition label per cut
- Excluded clips shown dimmed/dashed with reason (e.g. "Too short", "Low motion")
- Tap excluded clip → option to add it back manually

### Gate

- [ ] Director screen appears after scan for new projects
- [ ] Accept loads Clip Editor with AI-proposed order pre-populated
- [ ] Regenerate re-runs analysis and refreshes proposal
- [ ] Skip loads Clip Editor with original scan order
- [ ] Excluded clips shown with reason; can be added back

---

## Batch 16 — Auth + 4K + Tier

> **Goal:** Product is shareable with paying users. Pro tier enforced.
> **Estimate:** 3–5 days.
> **Prerequisite:** DEC-020 conditions met (AI layer shipped = Batch 13+).

- Supabase Auth (email + Google OAuth)
- 4K pipeline path (`-vf scale=-2:2160`, libx264, profile high)
- Pro tier gating: AI Director screen, 4K output, advanced transitions (Slide Right, Wipe, etc.), timeline volume slider
- Upgrade chips + locked overlays for free-tier users (single-pass addition across UI)
- Stripe (£4.99/mo Creator)
- Library: show resolution badge (1080p / 4K) per project

---

## Phase 3 Preview (not in scope now)

- Stripe (£4.99/mo Creator) — after DEC-020 conditions met
- 4K export — Creator tier trigger
- Google Video Intelligence frame-level scoring — replaces FFmpeg motion score heuristic
- Face/subject-aware zoom — GVI + Vision API
- Stabilisation via ffmpeg-vidstab
- 50 clips / 20GB cap for Creator
- Licensed music library (Loudly or Soundraw API)

---

## Changelog

| Version | Date       | Changes                                                                                                                                                                                                                                                                          |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0     | 2026-04-01 | Batch 14c — per-clip data model: 7 DB columns, Rust/TS types, update_clip_review cmd, manifest filtering (include==0), out_ms clamp, pipeline trim override + focal-aware zoom.py. Next: 14b (proxies).                                                                         |
| 0.9     | 2026-03-31 | Batch 13d attempted and deferred. aresample=async worsened DJI sync; ProcessPoolExecutor made normalise slower (I/O bound); volumedetect overcorrected on wind noise. All changes reverted. Lessons in LEARNINGS.md. Next: Batch 14.                                             |
| 0.8     | 2026-03-28 | Direction session — agreed batch roadmap 12b→13→14→15→16. Music mode presets replace slider, 5-transition set, motion intelligence (no Gemini), Clip Editor, AI Director screen, Auth+4K+Tier. Old Batch 9 (Gemini) and Batch 10 (Auth) marked superseded.                       |
| 0.7     | 2026-03-27 | Batch 12 complete — audio -ar 48000 at all 6 re-encode sites, music volume slider (0-100 UI / 0.0-1.0 pipeline), delete project (Rust + Library UI), stale job auto-cleanup (60-min SQL), 10-min Output page timeout. E2E: 7/7 fast PASS, render confirmed PASS.                 |
| 0.6     | 2026-03-27 | Batch 11c complete — home redesign, name modal, scan spinner, transition picker (None/Crossfade/Dip to black), AppShell, elapsed timer, Open File button, real thumbnails in Resume section, bin icons always red, CardBlock bins in timeline, xfade clamp. E2E eval 41/41 PASS. |
| 0.5     | 2026-03-26 | Batch 11b complete — WebdriverIO v9 + msedgedriver E2E scaffold, 3-layer BiDi fix, rushcut-eval skill, dry run 33/35 PASS                                                                                                                                                        |
| 0.4     | 2026-03-25 | Batch 11 complete — 19-item UI polish: file picker, project rename, SettingsPanel overhaul, Output video fix, NavDrawer, colour compliance, filename slugification, card colour pipeline fix                                                                                     |
| 0.3     | 2026-03-24 | Batch 9 complete — full UX flow: folder picker, scan.py, 5 Tauri commands, editor + output pages, manifest-based pipeline invocation                                                                                                                                             |
| 0.2     | 2026-03-24 | Batch 8 complete — Tauri 2.x scaffold, Rust + SQLite backend, pipeline CLI, WSL2 check                                                                                                                                                                                           |
| 0.1     | 2026-03-22 | Phase 2 build plan created from Phase 1 exit state                                                                                                                                                                                                                               |
