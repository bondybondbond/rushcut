# Decision Log — RushCut

> Every significant "why did we choose X over Y" gets logged here.
> AI assistants: read this before suggesting architectural alternatives.

---

## DEC-001 — Cloudflare R2 over AWS S3
**Date:** March 2026
**Decision:** Use Cloudflare R2 for all file storage.
**Reason:** Zero egress fees. Video files are large (300MB–1.2GB per export). S3 egress at $0.09/GB would make per-export costs unacceptable at scale. R2 waives egress entirely.
**Trade-off:** Less mature ecosystem than S3, fewer SDK examples. Acceptable given cost savings.

---

## DEC-002 — FFmpeg-first, AI last
**Date:** March 2026
**Decision:** All v1 features use FFmpeg signal processing only. No AI APIs in free tier.
**Reason:** Per-export AI cost (~$0.25 vs $0.006 for FFmpeg-only) makes free tier economically unviable with AI. Google Video Intelligence free tier covers 500 exports/month — enough for PoC but not at scale.
**Trade-off:** Free tier output quality lower than AI-assisted. Mitigated by the free tier still being genuinely useful for basic compile/transitions/music.

---

## DEC-003 — AWS Lambda over dedicated server
**Date:** March 2026
**Decision:** FFmpeg rendering runs on AWS Lambda (containerised), not a persistent EC2/VPS.
**Reason:** Scales to zero between uses. Solo bootstrapped project — no idle server costs. Lambda free tier covers early-stage volume.
**Trade-off:** Cold start latency (8–15s). Mitigated by progress indicator and provisioned concurrency for paid tier.

---

## DEC-004 — Two-step draft + final render
**Date:** March 2026
**Decision:** Generate 360p proxy draft first, full render only on user confirmation.
**Reason:** Avoid wasting full Lambda compute ($0.024 for 4K) on a version the user will reject. Draft is fast, browser-previewable, and gives editorial control without a full timeline editor.
**Trade-off:** Extra Lambda invocation per project. Cost negligible at low resolution.

---

## DEC-005 — No watermarks on any tier
**Date:** March 2026
**Decision:** No watermarks ever, including free tier.
**Reason:** Kapwing, CapCut, and others use watermarks as conversion levers. Users resent this. Removing the friction is a positioning choice — every video shared by a free user is organic marketing without a watermark tax.
**Trade-off:** Slightly lower urgency to upgrade. Mitigated by hard 3 export/month free cap.

---

## DEC-006 — Name: RushCut
**Date:** March 2026
**Decision:** Product name is RushCut.
**Reason:** "Rushes" is the film industry term for raw unedited footage. RushCut = from rushes to a cut. Double meaning: speed + craft. Self-describing, industry-credible, easy to spell from hearing it.
**Rejected alternatives:**
- IchiCut — spelling confusion ("itchicut?"), though strong culturally
- AonCut — killed due to Aon plc (FTSE 100 insurance) trademark/SEO conflict
- Bireel — fun to say, impossible to spell phonetically
- OneClip — original working title, too generic, "clip" space saturated

---

## DEC-007 — Supabase over PlanetScale/Neon
**Date:** March 2026
**Decision:** Supabase for auth + database.
**Reason:** Free tier generous (500MB DB, 50MB file storage). Built-in auth removes custom session management. Postgres underneath — no lock-in risk.
**Trade-off:** Supabase pauses projects on free tier after 1 week inactivity. Acceptable for early dev; upgrade to Pro ($25/mo) when real users arrive.

---

## DEC-008 — Git (private repo) over Notion for project docs
**Date:** March 2026
**Decision:** All PRD, architecture, and decision docs live in this Git repo as Markdown.
**Reason:** Claude Code and other AI assistants read MD files natively from repo context. One source of truth for both human and AI readers. Version history free. Notion is better for human stakeholder presentation — no stakeholders here.
**Trade-off:** Less visual than Notion. Irrelevant for a solo project.
