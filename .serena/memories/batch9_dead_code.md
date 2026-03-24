# Batch 9 — Dead Code / Blast Radius

Files to DELETE before building Batch 9:
- `src/app/` — entire dir (Next.js pages: api, editor, output, upload)
- `next.config.ts` — Next.js artifact
- `next-env.d.ts` — Next.js artifact
- `src/lib/supabase.ts` — Supabase client (package not even in deps)
- `src/lib/ffmpeg-client.ts` — Lambda/API polling helper
- `src/hooks/useJobPoll.ts` — polls /api/jobs/... (old Lambda flow)

Files to REWRITE:
- `src/types/project.ts` — remove r2_key, Supabase-era fields; add local schema

Files to STRIP (keep structure, remove dead imports/fetches):
- `src/components/upload/ClipList.tsx` — remove `next/navigation`, `/api/clips/` fetches
- `src/components/upload/UploadZone.tsx` — remove `/api/upload/presign`, R2 upload logic
- `src/components/editor/TimelineStrip.tsx` — remove `/api/clips/reorder` fetch

Files SAFE to keep as-is:
- `src/lib/utils.ts` — likely just cn() helper
- `src/components/ui/*` — shadcn primitives, no API refs
- `src/components/configure/*`, `src/components/preview/*` — check before using
