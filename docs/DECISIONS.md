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
**Implementation detail:** Draft proxy is a separate low-memory server-side Lambda job — not client-side blob stitching. Runs real FFmpeg transitions/music/zoom at 360p so the preview reflects actual output.
**Trade-off:** Extra Lambda invocation per project. Cost negligible at low resolution.

---

## DEC-005 — No watermarks on any tier
**Date:** March 2026
**Decision:** No watermarks ever, including free tier.
**Reason:** Kapwing, CapCut, and others use watermarks as conversion levers. Users resent this. Removing the friction is a positioning choice — every video shared by a free user is organic marketing without a watermark tax.
**Trade-off:** Slightly lower urgency to upgrade. Mitigated by 4K resolution wall (see DEC-009).

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
**Decision:** All PRD, architecture, and decision logs live in this Git repo as Markdown.
**Reason:** Claude Code and other AI assistants read MD files natively from repo context. One source of truth for both human and AI readers. Version history free. Notion is better for human stakeholder presentation — no stakeholders here.
**Trade-off:** Less visual than Notion. Irrelevant for a solo project.

---

## DEC-009 — Pricing model: resolution-as-paywall (not export count)
**Date:** March 2026
**Decision:** Free tier is unlimited projects, unlimited exports, 1080p only. 4K is the sole hard upgrade trigger.
**Reason:** Clipchamp model — generous free tier builds habit (Hooked principle: reduce friction to form the habit loop). Resolution is unbypassable even with fake/multiple accounts — you cannot work around a render cap with account abuse. Cost per free 1080p export is ~$0.006, so volume at PoC scale is not a concern.
**Rejected alternative:** 3 exports/month cap — creates friction before users form the habit, and is bypassable with multiple accounts anyway.
**Trade-off:** Free tier too generous → potential low conversion rate. Mitigated by: (a) 4K wall is a genuine unbypassable hard limit, (b) AI features in v2 must feel genuinely magical or upgrade motivation weakens — this is a product quality bet, not a paywall bet.

---

## DEC-010 — Free tier clip limit: 20 (not 10)
**Date:** March 2026
**Decision:** Free tier allows up to 20 clips per project. All copy, UI, and code must use 20 as the single source of truth.
**Reason:** 10 clips is too restrictive for real hobbyist footage sessions (e.g. a DJI drone shoot produces 15–30 short clips). 20 is a generous but bounded limit consistent with the 5GB project cap.
**Rule:** Never write "10 clips" anywhere in docs, UI copy, or code comments. Always 20.

---

## DEC-011 — Login gate placement: before first server cost
**Date:** March 2026
**Decision:** Users can complete clip selection, optional brief, and configure screen without an account. Login/signup is required only when they click the action that triggers server-side processing (upload + draft render).
**Reason:** Maximise funnel completion before asking for commitment. Avoids anonymous compute abuse — no server cost is incurred before account creation. Inspired by DJI LightCut flow: select clips → configure → then process.
**Trade-off:** Users who complete Configure but abandon at login are lost. Acceptable — they have already formed intent.
**Rule:** No login UI on any Batch 1 shell page. Login gate is a Batch 2 concern, triggered at the moment the user submits Configure.

---

## DEC-012 — Configure screen is optional-feeling, not a mandatory blocker
**Date:** March 2026
**Decision:** Configure has smart defaults pre-selected. User can skip through without touching anything. It is not a configuration wall.
**Reason:** The product promise is "one click to a film." A mandatory multi-step form breaks that promise. Configure exists for users who want control, not as a barrier.
**Defaults:**
- Clip order: upload/timestamp order
- Music: auto-match to brief (or first royalty-free track if no brief)
- Title card: on, auto-generated from brief or filename/date metadata
- Style: auto (let FFmpeg choose transition pacing)
**Rule:** All Configure fields must have a default. No field should ever be blank/unselected by default.

---

## DEC-013 — Re-render cost control: two-tier change model
**Date:** March 2026
**Decision:** Changes after first draft preview are split into cheap (no re-render) and expensive (consumes re-render allowance).
**Cheap (free, no re-render):** Music track swap, title card text, template/style label changes where the metadata is updated but video is not reprocessed.
**Expensive (consumes 1 included re-render):** Clip reordering, transition style change, duration/trim changes — anything that alters the video timeline.
**Reason:** Unlimited re-renders on expensive operations break unit economics. Lambda time is the cost driver; metadata changes are negligible. Inspired by DJI LightCut model: clips first, effects applied after, not before.
**Free tier allowance:** 1 included re-render per project (covers most users). Additional re-renders: Phase 2+ credit pack feature.
**Rule:** The UI must make the distinction clear. Label expensive actions as "Re-render preview" with a note about allowance. Never silently trigger a full render from a cheap edit.

---

## DEC-014 — AI direction text: deferred to later stage
**Date:** March 2026
**Decision:** Open-ended AI direction (free-text "describe your film") is a later-stage feature. In v1, the optional brief is a short text input that only sets defaults (music mood, clip order hint). It does not trigger AI processing on the free tier.
**Reason:** AI text parsing is cheap (<$0.001 per call) but the risk is that it raises user expectations of deep AI control before the output quality justifies it. Ship strong defaults first; AI direction adds value only once the base output is proven.
**Rule:** The brief input is a hint, not a directive. Label it "describe your edit (optional)" and set expectations: "We will use this as a starting point." Do not imply the AI will follow instructions precisely in v1.

---

## DEC-015 — Download retention: 30 days in library, not 24-hour link
**Date:** March 2026
**Decision:** For logged-in users, completed exports are saved to their library for 30 days. The 24-hour download link applies only to anonymous/unauthenticated access (not planned for v1).
**Reason:** Since login is required before any processing (DEC-011), all users with exports are authenticated. A 30-day library retention is more user-friendly and consistent with product expectations. 24 hours creates anxiety and support burden.
**R2 cost implication:** A 1080p export at ~500MB retained for 30 days costs ~$0.0075 in R2 storage — negligible.
**Rule:** UI copy must say "Saved to your library for 30 days." Never "link valid for 24 hours" unless explicitly building an anonymous share link feature.

---

## DEC-016 — AI model selection: Gemini 2.0 Flash (current), evaluate 2.5 Flash-Lite at Batch 5
**Date:** March 2026
**Decision:** Keep Gemini 2.0 Flash as the context prompt model for now. Evaluate swapping to Gemini 2.5 Flash-Lite at Batch 5 when the call is actually wired.
**Reason:** Gemini 2.0 Flash was chosen as a free-tier-friendly, stable, GA model with generous rate limits at time of planning. Its only job in RushCut is one task: parse the optional free-text vibe brief ("fast cuts, upbeat, travel feel") into defaults. Cost is ~$0.001/export — essentially zero. Changing models now would save fractions of a penny and introduce implementation risk before the feature is even built.
**Why not 2.5 Flash-Lite immediately?** Gemini 2.5 Flash-Lite is newer, cheaper, and likely the better long-term default — but it should be validated at implementation time (Batch 5), not assumed in advance.
**Real cost drivers are elsewhere:** GVI (~$0.50/export on paid tier) and Lambda ($0.06–$0.21) are the numbers that matter. The LLM call is not a cost concern at any realistic volume.
**Model tier guidance (for Batch 5 implementation):**
- **Gemini 2.5 Flash-Lite** — use for cheap backend tasks: brief parsing, tagging, defaults inference. Lowest cost, sufficient quality for structured JSON output.
- **Gemini 2.5 Flash** — use for anything user-visible or creative: future AI direction (v2), scene labelling, open-ended brief interpretation.
- **Do not use Gemini 2.0 Flash** for new tasks — it is the old default, not the best current option.
**Action at Batch 5:** Benchmark Gemini 2.5 Flash-Lite as a drop-in swap for the brief parsing call. If output quality matches (structured JSON, correct defaults), swap and update PRD cost model accordingly. If rate limits become a friction point on the free tier, move to paid-tier Flash-Lite.
**Trade-off:** Slight model staleness until Batch 5. Acceptable — the call is not yet wired and cost impact is negligible.

---

## DEC-017 — Lazy / deferred upload: deferred to Phase 2
**Date:** March 2026
**Decision:** Upload full raw clips to R2 immediately on selection. Do not implement segment-scoped or deferred upload in Phase 1.
**Reason:** Lambda needs files in R2 before it can render. A lazy upload model (upload only trimmed segments) requires knowing the exact in/out boundaries client-side *before* the upload — which only becomes possible when a timeline scrubber with per-clip handles is added. That feature is Phase 2.
**What lazy upload would look like in Phase 2:** Browser extracts trim points locally (WebCodecs or client-side FFmpeg WASM) → uploads only the trimmed segment bytes → Lambda receives pre-trimmed files and skips the trim step. Net result: shorter upload time, less R2 storage consumed, faster Lambda run.
**Why Clipchamp feels instant:** Clipchamp does all processing locally via WebCodecs + WebGL and never uploads until export. RushCut's server-side Lambda model is architecturally different — the trade-off is simplicity + server capability (silence removal, loudnorm, complex transitions) at the cost of an upfront upload.
**Trigger for revisit:** When per-clip in/out handles land on the timeline. At that point the segment boundaries are known pre-upload and the lazy model becomes viable without a full architecture rethink.
**Trade-off:** Phase 1 users upload full raw clips even if only 30s of a 2-min clip is used. Acceptable for PoC — R2 aggressive cleanup (raw clips deleted post-render, see DEC-001) limits storage cost impact.

---

## DEC-018 — Phase 2 entry gate: self-validation over external metrics
**Date:** March 2026
**Decision:** Phase 2 exit gate is "I used RushCut to produce a video from a real 60+ clip DJI session that I was proud to publish" — not "5 paying strangers" and not user testing scores.
**Reason:** The 5-paying-strangers gate was written assuming the AI intelligence layer would exist. Without it the product is a clip stitcher with no lock-in. The founder's own validated experience is the right gate at this stage — the product was built to solve a specific personal pain point first.
**Trade-off:** Slower commercial signal. Acceptable — commercial validation is Phase 3 territory.

---

## DEC-019 — Competitive research scope: web-only
**Date:** March 2026
**Decision:** Competitive analysis covers web versions only (Clipchamp Web, Kapwing, WeVideo, FlexClip, LightCut Web if it exists). Desktop apps (DaVinci, Clipchamp Desktop) are explicitly excluded.
**Reason:** RushCut is web-first. Desktop apps use local rendering — the latency and capability profile is fundamentally different. Only web competitors reflect the actual competitive landscape. Focus: how many clicks to a rendered film, what does auto-edit look like, clip selection UX.

---

## DEC-020 — Payment gate deferred until AI layer ships
**Date:** March 2026
**Decision:** Stripe integration and pricing tier are Phase 3. Phase 2 is entirely free-tier, auth required but no payment wall.
**Reason:** Charging for an FFmpeg concat + silence detection pipeline has zero lock-in and no defensible differentiation. The paid tier only makes sense when the AI intelligence layer (Gemini ordering + GVI frame scoring) exists, because that's what users can't replicate elsewhere cheaply.

---

## DEC-021 — Positioning: "in the middle" — direction power, not full AI auto-edit
**Date:** March 2026
**Decision:** RushCut is not LightCut (full auto-edit, no control) and not Clipchamp (full manual timeline). The product gives *direction power* — user sets intent, tool executes, user reviews and nudges. This is the confirmed design stance going into Phase 2.
**Reason:** LightCut's 4-step confirm model is the benchmark for simplicity but it's editorially shallow — no Windows support, limited customisation. Clipchamp's timeline is too manual for the target user. The gap is a tool that feels like giving direction to an editor, not operating editing software.
**Implication:** Every Phase 2 UI decision should be tested against this: "does this feel like directing, or does it feel like editing?"
