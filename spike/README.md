# spike/render.py — Batch 0 Pipeline Spike

Throwaway script. Validates FFmpeg can produce watchable output from real DJI footage before any frontend is built.

## Prerequisites

- Python ≥ 3.8
- FFmpeg installed: `winget install Gyan.FFmpeg` (auto-discovered, no PATH restart needed)

## Usage

```bash
cd C:\apps\rushcut
python spike/render.py DJI_001.MP4 DJI_002.MP4 DJI_003.MP4
```

Output: `spike/output_draft.mp4` (360p, CRF 35, ultrafast — browser/VLC playable)

Pass `--keep-tmp` to retain normalised clips in `spike/tmp/` for debugging.

## What it does

1. Prints codec info for each input (codec_name, pix_fmt, framerate)
2. Normalises each clip → H.264/yuv420p/25fps CFR/1080p/AAC
3. Runs silencedetect and prints detected silent ranges
4. Concatenates with xfade crossfade (0.5s) + pairwise acrossfade audio
5. Outputs 360p draft

## Verification gates

- [ ] Runs without errors
- [ ] `output_draft.mp4` plays in VLC/browser
- [ ] xfade crossfade visible at join points
- [ ] No audio sync drift
- [ ] Silence detection output looks plausible

✅ pass → proceed to Batch 1
❌ fail → diagnose from the printed FFmpeg commands above
