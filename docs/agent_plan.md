# RushCut Agent Plan

> Status: DRAFT — July 2026  
> Purpose: Define agent roles, responsibilities, search ownership, gate pass/fail criteria, and skill mapping.

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
- **Perplexity** (browser automation): Gate 3 only — traps/best-practices first, then plan fit assessment. One spawn, one VERDICT. Sequential, never parallel.
- **Claude WebSearch**: Gate 2 competitor/context research, and any mid-job CC lookups
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
- **Consultant → CPO:** Research outputs, VERDICT on Gate 3

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
| Technical lookup, best practice, mid-job research | **Consultant** (uses Claude WebSearch) |
| Taste / UX / "does this feel right" question | **User** |

### Never does
- Strategic decisions
- Market research
- Initiating Perplexity searches

---

## Gate Structure

### Overview

```
[User + CPO: Gate 1 — JTBD]
        ↓ PASS
[Consultant: Gate 2 — Competitor / Context]
        ↓ PASS
[Consultant → CPO: Gate 3 — Plan + Traps]
        ↓ PASS (CPO VERDICT)
[CC: Implementation — builds per approved dev plan]
        ↓
[CPO: Gate 4 — Wrap-up Approval]
        ↓ PASS
[Delivery]
```

---

### Gate 1 — JTBD
**Skill:** `rushcut-dev-plan` (session start)  
**Owner:** User + CPO  
**Search engine:** None — this is the user's voice, not a research question  
**Input required:** User states the problem/request. CPO challenges whether it is a real user job worth solving.  
**Documents consulted:** PRD, roadmap, RICE backlog  

| Result | Criteria |
|---|---|
| ✅ PASS | CPO confirms problem is valid, worthwhile, and aligned to strategy. RICE score assigned. |
| ❌ FAIL | Problem is unclear, out of scope, or contradicts strategic direction. CPO returns to user with challenge. Session does not continue until resolved. |

**Hard rule:** CC does not draft any dev plan until Gate 1 is PASS.

---

### Gate 2 — Competitor / Context Research
**Skill:** `rushcut-dev-plan` (after Gate 1 PASS)  
**Owner:** Consultant  
**Search engine:** Claude WebSearch  
**Input required:** The confirmed JTBD from Gate 1  

| Result | Criteria |
|---|---|
| ✅ PASS | Consultant has completed WebSearch with verified `tool_use` entries in transcript (not self-reported). Summary delivered to CC. |
| ❌ FAIL | No `tool_use` WebSearch entry found in Consultant transcript. Gate blocked. Consultant must re-run. |

**Hard rule:** Hook checks Consultant transcript for actual `WebSearch` tool_use entry. CC cannot start dev plan drafting without this.

---

### Gate 3 — Plan + Traps (Perplexity)
**Skill:** `rushcut-dev-plan` (after CC drafts plan, before implementation)  
**Owner:** Consultant (search) → CPO (verdict)  
**Search engine:** Perplexity (browser automation, single sequential spawn)  
**Input required:** CC's drafted dev plan  

**Two-step merged process (single Perplexity session):**
1. Consultant searches for known traps, best practices, and failure patterns relevant to the plan
2. Consultant assesses whether the drafted plan accounts for those findings
3. CPO reviews Consultant output and issues final VERDICT

| Result | Criteria |
|---|---|
| ✅ PASS | Perplexity `tool_use` entry confirmed in Consultant transcript. CPO issues explicit VERDICT: APPROVED. |
| ❌ FAIL — search missing | No Perplexity tool_use entry in transcript. Hook blocks. Consultant must re-run. |
| ❌ FAIL — CPO rejects | CPO finds plan does not adequately address traps/findings. Returns to CC for plan revision. Re-runs Gate 3. |

**Hard rules:**
- Perplexity session is always sequential — never run while another Perplexity session is active (browser contention)
- CPO VERDICT must be explicit text string: `GATE 3: APPROVED` or `GATE 3: REJECTED — [reason]`
- CC cannot begin any implementation until `GATE 3: APPROVED` appears in transcript

---

### Gate 4 — Wrap-up Approval
**Skill:** `rushcut-wrapup`  
**Owner:** CPO  
**Search engine:** Optional — CPO may request Consultant to run a Claude WebSearch if specific verification is needed  
**Input required:** CC signals implementation complete  

| Result | Criteria |
|---|---|
| ✅ PASS | CPO confirms delivery meets the original JTBD. Issues explicit `GATE 4: APPROVED`. |
| ❌ FAIL | CPO identifies gaps vs original JTBD or PRD. Returns to CC with specific issues. Re-runs Gate 4 after fix. |

**Hard rule:** `rushcut-wrapup` skill is blocked until `GATE 4: APPROVED` appears in CPO transcript. Hook enforces this identically to Gate 3.

---

## Skill Mapping

| Skill | Gates covered | Agents involved |
|---|---|---|
| `rushcut-dev-plan` | Gates 1, 2, 3 | User + CPO (G1), Consultant (G2+G3 search), CPO (G3 verdict) |
| `rushcut-wrapup` | Gate 4 | CPO (approval), Consultant (optional search) |

**Flow within `rushcut-dev-plan`:**
```
Step 1: Gate 1 (JTBD) → CPO
Step 2: Gate 2 (Context) → Consultant WebSearch
Step 3: CC drafts dev plan
Step 4: Gate 3 (Plan + Traps) → Consultant Perplexity → CPO VERDICT
Step 5: CC implements
```

**Flow within `rushcut-wrapup`:**
```
Step 1: CC signals complete
Step 2: Gate 4 → CPO review
Step 3: Optional: CPO requests Consultant WebSearch for verification
Step 4: CPO issues GATE 4: APPROVED or REJECTED
Step 5: Delivery
```

---

## Search Engine Guidance

### Claude WebSearch — when and how

**Used in:** Gate 2, mid-job CC escalations, optional Gate 4 verification

**Goal:** Fast, targeted lookup. Claude already has project context — use WebSearch to supplement with external evidence, not replace reasoning.

**Mandate the following sources in queries:**
| Source type | Examples | Good for |
|---|---|---|
| Official docs | React docs, MDN, Tauri docs, Apple HIG | API correctness, platform constraints |
| GitHub Issues / Discussions | `site:github.com` + library name + symptom | Known bugs, workarounds, version traps |
| Stack Overflow | `site:stackoverflow.com` | Common errors, implementation patterns |
| Reddit | r/webdev, r/reactjs, r/videoediting | Real-world pain points, community consensus |
| Hacker News | `site:news.ycombinator.com` | Architecture debates, "don't do X" signals |
| Official changelogs/release notes | e.g. Tauri v2 migration guide | Breaking changes, deprecations |

**Query construction rules:**
- Always include the specific library/version: `Tauri v2 file watcher performance`
- Target failure modes: `[feature] common mistakes`, `[library] pitfalls production`
- Target recency: append `2024 OR 2025 OR 2026` to avoid stale results
- Search competitor behaviour: `how DaVinci Resolve handles [X]`, `CapCut [feature] implementation`

**Minimum queries per Gate 2 run:** 3 distinct searches across at least 2 different source types.

---

### Perplexity — when and how

**Used in:** Gate 3 only (plan + traps, merged)

**Goal:** Multi-model synthesis. Use Perplexity precisely because it reasons differently from Claude — the point is to surface blind spots and alternative approaches, not just confirm what Claude already thinks.

**Two mandatory queries per Gate 3 session (in this order):**

**Query 1 — Traps & best practices:**
> "What are the most common mistakes, failure patterns, and best practices when implementing [specific feature/approach from dev plan]? Include real-world examples from developer communities, official guidance, and known production issues."

**Query 2 — Plan fit assessment:**
> "Given this implementation plan: [paste plan summary]. Does this approach account for [findings from Query 1]? What would experienced engineers do differently? What assumptions is this plan making that could be wrong?"

**What to look for in results:**
- Anything the dev plan does not mention
- Alternative approaches with better track records
- Version-specific gotchas for the stack in use (Tauri, React, TypeScript)
- Performance or UX patterns from comparable tools (DaVinci, CapCut, Premiere)

**Pass threshold:** Consultant must explicitly map each finding to the plan — either "plan accounts for this" or "plan does NOT account for this — flagging to CPO".

---

## What This Replaces

Previously the pipeline attempted to run Perplexity across all 4 gates simultaneously, causing:
- Browser contention (two agents colliding in the same Perplexity session)
- Self-reported search results with no transcript verification
- Overlapping responsibilities between auditor and consultant

This plan consolidates Perplexity to Gate 3 only (one sequential spawn), removes JTBD from automation, enforces hard transcript-verified gates with explicit PASS/FAIL strings, and gives each search engine a specific mandate.
