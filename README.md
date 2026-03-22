# RushCut 🎬

> *From your rushes to a cut. In minutes.*

Web-first video compiler for hobbyist action/drone/travel videographers. Upload your raw clips, get a watchable film with transitions, music, and structure — no timeline editing required.

---

## What this is

A solo bootstrapped project. Personal pain point first, commercial product second.

- **The problem:** DJI LightCut is the best UX in this space — but mobile-only, no Windows. DaVinci Resolve gives full control but takes hours per clip. Nothing in between gives you *direction power* without micro-managing every 2-second clip.
- **The solution:** Upload your rushes → pick a vibe → get a 90% film → tweak the 10%.
- **The bet:** In a market obsessing over AI features, win by doing one job exceptionally well.

---

## Repo structure

```
rushcut/
  docs/
    PRD.md            ← Living product requirements document
    ARCHITECTURE.md   ← Stack decisions and system design
    DECISIONS.md      ← Why we chose X over Y (decision log)
    CHANGELOG.md      ← Session-by-session what changed
  src/                ← Application code (populated in Phase 1)
  README.md
```

---

## Current status

**Phase:** Pre-build — PRD drafted, architecture defined, not yet in code.

**Next step:** Scaffold Next.js app + test FFmpeg Lambda pipeline locally with real DJI footage. See `docs/PRD.md` Phase 1.

---

## Tech stack (summary)

| Layer            | Tool                                        |
| ---------------- | ------------------------------------------- |
| Frontend         | Next.js (App Router) + Tailwind + shadcn/ui |
| Auth + DB        | Supabase                                    |
| File storage     | Cloudflare R2                               |
| Video processing | FFmpeg on AWS Lambda (containerised)        |
| Payments         | Stripe                                      |

Full stack rationale in `docs/ARCHITECTURE.md`.

---

## For AI assistants reading this

- Start with `docs/PRD.md` for full product context
- Check `docs/DECISIONS.md` before suggesting architectural changes — decisions already made are logged there with reasons
- Check `docs/CHANGELOG.md` for what was last worked on
- The author uses Claude Code as primary coding assistant
- No rush on timeline — quality over speed, personal pain point drives all prioritisation
