# Architecture — RushCut

> Last updated: March 2026
> Status: Pre-build design phase

---

## Guiding Principles

1. **Scale to zero** — no idle server costs. Every compute component is serverless/pay-per-use.
2. **Zero egress fees** — Cloudflare R2 for all file storage. Large video files make egress costs the #1 budget risk.
3. **FFmpeg-first** — use open-source signal processing before reaching for AI APIs. AI reserved for features that genuinely need it (v2+).
4. **Fail fast on upload** — validate, normalise, and reject bad files early. Don't let codec mismatches surface mid-render.
5. **Cost caps are mandatory code, not config** — hard limits on file size, project size, AI processing time, and monthly exports must be enforced in the pipeline, not just documented.

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

## Hard Limits (Non-Negotiable)

These limits exist to ensure per-export infrastructure cost never exceeds subscription revenue. They must be enforced at **both** client (pre-upload validation) and server (reject at API layer) — never rely on documentation alone.

| Limit | Free Tier | Paid Creator Tier |
|---|---|---|
| Max file size | 500MB | 1GB |
| Max project size (total upload) | 5GB | 10GB |
| Max clips per project | 20 | 50 |
| Max exports per month | Unlimited | 10 |
| Google Video Intelligence cap | N/A | 5 min footage per export |
| Lambda /tmp allocation | 512MB (default) | 10GB (must be explicitly set) |

> **Why these numbers?** At 10GB input, paid tier costs ~£0.56–0.70/export. At 10 exports/month = ~£5.60–7.00 vs £4.99 revenue — the cap prevents worst-case loss. Typical hobbyist (1–4 exports/month at 3–5GB) sits at ~78% gross margin. See `PRD.md` Section 8 for full breakdown.

> **GVI cap is critical:** Without the 5 min cap on Google Video Intelligence, a 10GB project can score ~20 min of post-filter footage at $0.10/min = $2.00 in a single export. The cap must be implemented as a hard timeout/slice in the Lambda AI step, not just a guideline.

---

## FFmpeg Processing Pipeline

```
Upload (presigned R2 URL, direct from browser)
  ↓
[GATE] File size validation: reject if > tier limit (500MB free / 1GB paid per file)
[GATE] Project size validation: reject if cumulative upload > tier limit (5GB free / 10GB paid)
  ↓
Pre-pass: normalise all clips to consistent codec/fps/resolution
  ↓  [CRITICAL — must happen before xfade or transitions will fail]
Silence/stillness detection (silencedetect + frame diff)
  ↓
Clip trim (in/out points applied)
  ↓
[AI tier only] Google Video Intelligence scoring — HARD CAP: process max 5 min of footage
  ↓
xfade transitions at every join point
  ↓
Music: auto-fit audio track to final duration (trim + fade)
  ↓
Volume normalisation (loudnorm)
  ↓
Generic centre-zoom (zoompan at clip midpoints) [free] | Smart zoom (Vision API) [paid]
  ↓
Intro/end card overlay
  ↓
Output: 1080p MP4 [free] / 4K MP4 [paid] → R2 (24h signed URL)
  ↓
[GATE] Increment export counter in Supabase — block if paid user has hit 10/month
```

### Key technical risks
- **Codec normalisation:** DJI (H.264/H.265), GoPro (H.264), iPhone (HEVC). Must pre-process to consistent container before xfade. Build this first.
- **zoompan performance:** Frame-by-frame re-encode — a 30s clip with zoom can take 90s Lambda processing. Benchmark before committing to all clips.
- **Lambda cold start:** 3GB RAM container = 8–15s cold start. Use progress indicator; provisioned concurrency for paid tier.
- **1GB multipart uploads:** Client-side chunking required in Next.js. Not trivial — use `@aws-sdk/client-s3` multipart or R2 equivalent.
- **Lambda /tmp overflow:** Default /tmp = 512MB. For paid tier processing large projects, must explicitly configure Lambda /tmp up to 10GB. Clips must be processed sequentially/streamed — never load full project into memory at once.
- **GVI cost spike:** Google Video Intelligence at $0.10/min — without a hard cap, a single 10GB project can cost $2.00+ in AI alone. Cap implemented as slice in Lambda AI step: take top N seconds of post-filter footage up to 5 min total.

---

## Draft vs Final Render

Two-step render to avoid wasting full compute on a version the user rejects:

| Step | Resolution | Where | Speed |
|---|---|---|---|
| Draft proxy | 360p | Lambda (low memory config) | ~15–30s |
| Final render | 1080p (free) / 4K (paid) | Lambda (3GB config) | ~60–720s |

Draft is browser-previewable. User confirms, then final render triggers.

> Note: Final render time scales with input size. A 10GB project at 4K can take 10–12 min Lambda processing. Show a progress indicator — do not let users stare at a blank screen.

---

## Cost Model (summary)

| Export type | Input size | Estimated cost |
|---|---|---|
| Free 1080p | 3GB | ~£0.015 |
| Free 1080p | 5GB | ~£0.025 |
| Free 1080p | 10GB (max) | ~£0.049 |
| Paid 4K + AI (GVI capped) | 3GB | ~£0.51 |
| Paid 4K + AI (GVI capped) | 5GB | ~£0.56 |
| Paid 4K + AI (GVI capped) | 10GB (max) | ~£0.70 |

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
