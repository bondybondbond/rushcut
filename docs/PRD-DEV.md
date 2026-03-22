# RushCut — Phase 2 Build Plan

> **Phase goal:** The founder can upload a full 60+ clip DJI session, have RushCut intelligently filter and compile it into a 3–6 min film with music, card text, zoom, and smart moment selection — a film they're proud enough to publish.
>
> **Phase 2 exit gate:** "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish." Not: paying users. Not: user testing scores. (See DEC-018, DEC-020.)

---

## Where Phase 1 Left Off

Phase 1 delivered a working pipeline end-to-end:

| Feature | Status |
|---|---|
| Upload → Editor → Output flow | ✅ Working |
| Silence/stillness detection | ✅ Working |
| xfade transitions | ✅ Working |
| 1080p export | ✅ Working |
| Thumbnail persistence | ✅ Working |
| Music | ❌ Flag disabled — no MP3s in Lambda |
| Card text overlay | ❌ drawtext unavailable on ARM64 static FFmpeg |
| Zoom | ❌ zoom.py exists but disabled in frontend |
| Per-clip in/out handles | ❌ Not built |
| Boring clip filtering | ❌ Not built |
| Beat-sync music | ❌ Not built |
| Director intent (Gemini) | ❌ Not built |
| Auth / accounts | ❌ Not built — localStorage only |
| >20 clips / real sessions | ❌ Limited to 20 clips, 1GB per file |

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

## Batch 8 — Real Sessions (60+ clips, 10GB+)

> **Goal:** The author can throw an entire DJI session (62 clips, 19.6GB) at RushCut. The tool auto-selects the best clips, handles the volume, and produces a film without manual pre-curation.
> **Estimate:** 1–2 days.
> **This is the batch that makes RushCut actually useful for the founder's real use case.**

### 8a — Per-project total cap: 1GB → 10GB

Match the PRD. The 1GB total guard blocks a single DJI session.

`src/app/api/upload/presign/route.ts`: Change project total cap from `1GB` to `10GB`.
`src/components/upload/UploadZone.tsx`: Update copy. Update client-side guard.

---

### 8b — Boring clip filter (FFmpeg motion score)

Before the pipeline runs, score each normalised clip for visual interest. Auto-skip near-static clips.

**lambda/pipeline/detect.py** — add `motion_score(clip_path) -> float`:
```python
# Run FFmpeg with select filter to sample N frames, measure inter-frame diff
# Returns 0.0 (completely static) to 1.0 (high motion)
ffmpeg -i clip.mp4 -vf "select='gt(scene,0.02)',metadata=print:file=-" -an -f null -
```
Parse scene change scores → average → return.

**lambda/pipeline/render.py** — after normalise, before trim:
```python
scores = {c: motion_score(path) for c, path in normalised.items()}
boring = [c for c, s in scores.items() if s < MOTION_THRESHOLD]
# Log excluded clips to job status for debugging
```

**Threshold:** Start at 0.015 (lab-tested against DJI footage). Configurable via Lambda env `MOTION_FILTER_THRESHOLD`.

This is the "boring clip filtering" feature from PRD Section 6 v1 scope.

---

### 8c — Smart clip selection for large sessions

If a project has >20 clips (current pipeline limit), auto-rank and select the best N rather than hard-rejecting.

**lambda/pipeline/render.py:**
- After motion scoring, rank clips by `motion_score * clip_duration_weight`
- Select top N clips (default: 20 for free tier, 50 for future paid tier)
- Log which clips were excluded and why to job status

**Frontend (editor):** When >20 clips uploaded, show a notice: "We selected the X most interesting clips from your Y uploaded. [Show all]"

This removes the manual pre-curation step — the author doesn't need to decide which 20 of 62 clips to keep.

---

### 8d — Per-clip in/out handles

The editor currently shows clips but has no way to trim individual clips. This is the prerequisite for Respin (DEC-009) and lazy upload (DEC-017).

**UI:** In the editor timeline, each clip card gets a scrubber with in/out handles. Drag left handle to set trim start, right handle to set trim end. Preview frame at cursor position (thumbnail seek).

**Data:** Store `trim_start_ms` and `trim_end_ms` per clip in Supabase `clips` table. Currently these are set by Lambda's silence detection — override with user-set values when present.

**Lambda:** `trim.py` already reads `trim_start_ms` / `trim_end_ms` from clip metadata. If user-set values exist, use them; otherwise use detect.py values.

**Lazy upload (DEC-017):** Once in/out handles exist, the exact segment boundaries are known before processing. Phase 3 can use this to upload trimmed segments only. Not implemented in Batch 8 — just the UI handles.

---

### Batch 8 verification

Upload the full DJI session (62 clips):
- [ ] All 62 clips accepted (total >10GB)
- [ ] Near-static clips auto-excluded (verify via CloudWatch logs)
- [ ] Best 20 clips auto-selected — film makes visual sense without manual curation
- [ ] In/out handles visible on each clip in editor
- [ ] Trim changes persist to Supabase and are respected by Lambda

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

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-03-22 | Phase 2 build plan created from Phase 1 exit state |
