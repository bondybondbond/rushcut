# RushCut Agent Plan

> Status: DRAFT — July 2026  
> Purpose: Define agent roles, responsibilities, search ownership, and escalation paths.

---

## Agent Overview

| Agent | Codename | Role |
|---|---|---|
| **CPO** | `rushcut-cpo` | Strategic decision-maker. Owner of vision, roadmap, RICE, PRD, and final approvals. |
| **Consultant** | `rushcut-pp-consultant` | Insight engine. Supplies research and data-driven inputs to CPO and CC. Does all searches. |
| **CC** (Claude Code) | No agent file — IS Claude Code | Executor. Drafts dev plan, builds features, escalates blockers. |

---

## CPO (`rushcut-cpo`)

**Renamed from:** `rushcut-real-pp-auditor`

**Role:** Chief Product Officer. The user's representative inside the pipeline. Owns strategic execution and ensures every job moves the product closer to its desired outcome.

### Owns
- JTBD definition — jointly with the user, ensures we are solving the right problem
- Strategic alignment — checks every request against vision and current roadmap
- PRD — living strategic document; consulted on whether work is on-track or diverging
- RICE scoring — prioritises user requests against existing backlog
- Roadmap — user can query it directly: "what's next?", "where is my request in the queue?"
- Plan approval — signs off dev plans from CC before implementation starts
- Wrap-up approval — gates the final delivery
- LEARNINGS.md (strategic layer) — aware of high-level patterns, not necessarily all tactical detail
- Expectation management — aligns user, flags violations of strategic path or vision

### Never does
- Market research or web searches
- Writing or reviewing code
- Tactical implementation decisions

### Interfaces
- **User → CPO:** Product requests, complaints, roadmap questions, vision challenges
- **CC → CPO:** Escalation when blocked, plan approval requests
- **Consultant → CPO:** Strategic trends, competitor signals, assumption-breaking insights

---

## Consultant (`rushcut-pp-consultant`)

**Role:** Insight engine. Supporting capacity. Delivers targeted research and best-practice grounding to strengthen decision-making for both CPO and CC.

### Owns
- All searches — the only agent that runs web searches
- **Perplexity** (real-pp-auditor browser automation): merged gate — traps/best-practices first, then plan fit assessment. One spawn, one VERDICT. Sequential, not parallel.
- **Claude WebSearch**: competitor context, Reddit/SO/HN/official docs, mid-job technical lookups
- LEARNINGS.md (tactical layer) — sits on metrics, patterns, and insights
- Competitive trends — can surface to CPO if assumptions need revisiting
- Mid-job support — CC can request a targeted search during implementation; Consultant uses Claude WebSearch in this case

### Never does
- Takes decisions
- Approves plans
- Touches code

### Interfaces
- **CPO → Consultant:** "Get me grounding on X before I approve this plan"
- **CC → Consultant:** Mid-job lookups, additional context needed to unblock
- **Consultant → CPO:** Research outputs, VERDICT on plan+traps gate

---

## CC (Claude Code)

**Role:** Executor. Commissioned by CPO. Drafts dev plan with Consultant inputs, gets CPO approval, then builds.

### Owns
- Dev plan drafting (with Consultant inputs as needed)
- Writing and shipping code
- Raising blockers early

### Escalation paths (CC can choose)
| Situation | Go to |
|---|---|
| Strategic ambiguity, scope question, approval needed | **CPO** |
| Technical lookup, best practice, mid-job research | **Consultant** |
| Taste / UX / "does this feel right" question | **User** |

### Never does
- Strategic decisions
- Market research
- Initiating Perplexity searches

---

## Gate Structure

| Gate | Owner | Search engine | Blocks |
|---|---|---|---|
| JTBD | **User + CPO** | None — user's voice | Session start |
| Competitor / context | **Consultant** | Claude WebSearch | Dev plan drafting |
| Plan + traps (merged) | **Consultant → CPO verdict** | Perplexity (one sequential spawn) | Implementation start |
| Wrap-up approval | **CPO** | Optional (Consultant if needed) | Delivery |

### Hard rules
- Gates 3 and 4 are hard-blocked — CC cannot proceed without a confirmed VERDICT/approval in transcript
- Perplexity gate is always sequential (never parallel with another Perplexity session) to avoid browser contention
- Gate search results must appear in agent transcript (tool_use entry), not just in summary text — enforced by hook

---

## What this replaces

Previously the pipeline attempted to run Perplexity across all 4 gates simultaneously, causing:
- Browser contention (two agents colliding in the same Perplexity session)
- Self-reported search results with no transcript verification
- Overlapping responsibilities between auditor and consultant

This plan consolidates Perplexity to one merged gate, removes JTBD from automation, and enforces hard transcript-verified gates.
