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

## Batch 9 — Director Intelligence

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

## Batch 10 — Auth + Library

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

| Version | Date       | Changes                                            |
| ------- | ---------- | -------------------------------------------------- |
| 0.2     | 2026-03-24 | Batch 8 complete — Tauri 2.x scaffold, Rust + SQLite backend, pipeline CLI, WSL2 check |
| 0.1     | 2026-03-22 | Phase 2 build plan created from Phase 1 exit state |
