# Architecture — RushCut

> Last updated: March 2026
> Status: Pre-build design phase

---

## Guiding Principles

1. **Scale to zero** — no idle server costs. Every compute component is serverless/pay-per-use.
2. **Zero egress fees** — Cloudflare R2 for all file storage. Large video files make egress costs the #1 budget risk.
3. **FFmpeg-first** — use open-source signal processing before reaching for AI APIs. AI reserved for features that genuinely need it (v2+).
4. **Fail fast on upload** — validate, normalise, and reject bad files early. Don't let codec mismatches surface mid-render.

---

## Stack

| Layer | Tool | Rationale |
|---|---|---|
| Frontend | Next.js (App Router) | Vercel-deployable, App Router for streaming/async render status |
| UI | Tailwind + shadcn/ui | Rapid prototyping without custom CSS debt |
| Auth + DB | Supabase | Free tier covers full PoC; Postgres for project/export records |
| File storage | Cloudflare R2 | Zero egress fees — critical for large video files |
| Proxy preview | FFmpeg (low-res Lambda) | Fast draft without full render cost |
| Full render | FFmpeg on AWS Lambda (containerised) | Serverless, scales to zero, pay-per-export |
| Payments | Stripe | Standard, well-documented |

### v2 AI additions (not in scope until Phase 3)
| Feature | Tool |
|---|---|
| Scene/action scoring | Google Video Intelligence API |
| Face detection / smart zoom | Google Vision API or OpenCV |
| Context-aware ordering | Gemini 2.0 Flash |
| Beat-sync music | `librosa` (open-source Python) |

---

## FFmpeg Processing Pipeline

```
Upload (presigned R2 URL, direct from browser)
  ↓
Pre-pass: normalise all clips to consistent codec/fps/resolution
  ↓  [CRITICAL — must happen before xfade or transitions will fail]
Silence/stillness detection (silencedetect + frame diff)
  ↓
Clip trim (in/out points applied)
  ↓
xfade transitions at every join point
  ↓
Music: auto-fit audio track to final duration (trim + fade)
  ↓
Volume normalisation (loudnorm)
  ↓
Generic centre-zoom (zoompan at clip midpoints)
  ↓
Intro/end card overlay
  ↓
Output: 1080p MP4 → R2 (24h signed URL)
```

### Key technical risks
- **Codec normalisation:** DJI (H.264/H.265), GoPro (H.264), iPhone (HEVC). Must pre-process to consistent container before xfade. Build this first.
- **zoompan performance:** Frame-by-frame re-encode — a 30s clip with zoom can take 90s Lambda processing. Benchmark before committing to all clips.
- **Lambda cold start:** 3GB RAM container = 8–15s cold start. Use progress indicator; provisioned concurrency for paid tier.
- **1GB multipart uploads:** Client-side chunking required in Next.js. Not trivial — use `@aws-sdk/client-s3` multipart or R2 equivalent.

---

## Draft vs Final Render

Two-step render to avoid wasting full compute on a version the user rejects:

| Step | Resolution | Where | Speed |
|---|---|---|---|
| Draft proxy | 360p | Lambda (low memory config) | ~15–30s |
| Final render | 1080p (free) / 4K (paid) | Lambda (3GB config) | ~60–240s |

Draft is browser-previewable. User confirms, then final render triggers.

---

## Cost Model (summary)

| Export type | Estimated cost |
|---|---|
| Free 1080p | ~$0.006 (£0.005) |
| Paid 4K + AI | ~$0.25 (£0.20) |

Infrastructure costs ~$0 up to 200 users on free tiers. See `PRD.md` Section 8 for full breakdown.

---

## Local Development Setup

> To be populated in Phase 1 build sessions.

Prerequisites (assumed Windows 11 + WSL2):
- Node.js 20+
- Docker Desktop (for local Lambda FFmpeg container testing)
- AWS CLI
- Supabase CLI
- Wrangler CLI (Cloudflare R2)
