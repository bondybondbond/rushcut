# Batch 0 Spike — FFmpeg Pipeline Validation

Throwaway spike. Validates the highest-risk unknown: **can FFmpeg produce watchable output from real DJI footage?**

Files here are **not integrated into the app** and can be deleted once Batch 1 starts.

---

## Prerequisites

```bash
ffmpeg -version          # install: winget install ffmpeg
python --version         # needs >=3.8
```

Have ≥3 real DJI `.MP4` clips ready.

---

## Usage

```bash
python spike/render.py DJI_001.MP4 DJI_002.MP4 DJI_003.MP4
```

Optional: drop a `spike/music.mp3` file to test music overlay. If absent, step is skipped with a warning.

---

## What it does

| Step | Action |
|------|--------|
| 1 | Normalise each clip → `spike/tmp/norm_n.mp4` (H.264, 1080p, 25fps) |
| 2 | Silence detection — prints `silence_start`/`silence_end` to stdout (no trimming) |
| 3 | Concatenate with `xfade` crossfade (0.5s) + `acrossfade` audio |
| 4 | Overlay `music.mp3` with fade-out (skipped if file absent) |
| 5 | Render draft → `spike/output_draft.mp4` (360p, CRF 35, ultrafast) |

---

## Verification gates

- [ ] Script runs without errors
- [ ] `spike/output_draft.mp4` opens and plays in VLC
- [ ] xfade crossfade visible at join points
- [ ] Silence detection prints plausible timestamps
- [ ] No audible audio sync drift

**✅ All pass → proceed to Batch 1**  
**❌ Any fail → diagnose codec/xfade/audio issue before moving on**

---

## Known risks to watch

- DJI VFR footage may still cause xfade desync despite normalisation — check join points carefully
- `-crf 35 ultrafast` is deliberately degraded; don't judge sync quality by visual compression artefacts
- Windows paths: script normalises backslashes for FFmpeg filter strings automatically
