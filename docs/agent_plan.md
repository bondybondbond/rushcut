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
[CC: Draft dev plan]
        ↓
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
| ✅ PASS | Consultant has completed minimum 3 WebSearch queries with verified `tool_use` entries in transcript (not self-reported). Summary delivered to CC. |
| ❌ FAIL | Fewer than 3 `tool_use` WebSearch entries found in Consultant transcript, or queries did not span at least 2 different source types. Gate blocked. Consultant must re-run. |

**Hard rule:** Hook checks Consultant transcript for actual `WebSearch` tool_use entries. CC cannot start dev plan drafting without this.

---

### Gate 3 — Plan + Traps (Perplexity)
**Skill:** `rushcut-dev-plan` (after CC drafts plan, before implementation)  
**Owner:** Consultant (search) → CPO (verdict)  
**Search engine:** Perplexity (browser automation, single sequential spawn)  
**Input required:** CC's drafted dev plan  

**Two-step merged process (single Perplexity session):**
1. Consultant runs Query 1 (breadth — traps and best practices)
2. Consultant runs Query 2 (depth — plan fit against findings from Query 1)
3. Consultant maps every finding to plan: "accounted for" or "NOT accounted for — flagging"
4. CPO reviews mapping and issues final VERDICT

| Result | Criteria |
|---|---|
| ✅ PASS | 2 Perplexity `tool_use` entries confirmed in Consultant transcript. Findings mapped to plan. CPO issues `GATE 3: APPROVED`. |
| ❌ FAIL — search missing | Fewer than 2 Perplexity tool_use entries in transcript. Hook blocks. Consultant must re-run. |
| ❌ FAIL — CPO rejects | CPO finds plan does not adequately address flagged findings. Returns to CC for plan revision. Gate 3 re-runs in full. |

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

**Mandatory source scoping — always use `site:` operators:**
| Source type | Query pattern | Good for |
|---|---|---|
| Official docs | `site:tauri.app [symptom]`, `site:react.dev [api]` | API correctness, platform constraints |
| GitHub Issues | `site:github.com/[repo]/issues [symptom]` | Known bugs, workarounds, version traps |
| Stack Overflow | `site:stackoverflow.com [error or pattern]` | Common errors, implementation patterns |
| Reddit | `site:reddit.com/r/webdev [topic]` | Real-world pain points, community consensus |
| Hacker News | `site:news.ycombinator.com [topic]` | Architecture debates, "don't do X" signals |
| Changelogs | `[library] v[X] breaking changes migration 2025` | Deprecations, upgrade traps |

**Query construction rules:**
- Always include specific library + version: `Tauri v2 file watcher performance`
- Target failure modes explicitly: `[feature] common mistakes site:stackoverflow.com`
- Target recency: append `2024 OR 2025 OR 2026` to avoid stale results
- Seek conflicting viewpoints — don't just confirm consensus: `[approach] criticism problems site:news.ycombinator.com`
- Competitor framing: `how DaVinci Resolve handles [X] vs Premiere Pro`
- Compare approaches: `[approach A] vs [approach B] performance React 2025`

**Minimum per Gate 2 run:** 3 distinct queries spanning at least 2 different source types.  
**Output format to request:** Ask Claude to return findings as `[source] | [finding] | [relevance to plan]` — prevents vague summaries.

---

### Perplexity — when and how

**Used in:** Gate 3 only (plan + traps, merged)

**Goal:** Multi-model synthesis. Use Perplexity precisely because it reasons differently from Claude — the point is to surface blind spots and alternative approaches, not confirm what Claude already thinks.

**Key principle (from official Perplexity docs):** Every prompt must specify BOTH how to search (retrieval mode) AND how to answer (output shape). A prompt that only asks a question gets a generic answer. A prompt that specifies sources + output format gets a structured, citable result.

---

**Query 1 — Breadth: Traps & best practices**

```
Search developer communities, official documentation, GitHub issues, and Stack Overflow.

Topic: [specific feature/approach from dev plan — e.g. "Tauri v2 file system watcher with React"]

Return a numbered list of:
1. The most common implementation mistakes and failure patterns
2. Best practices that experienced engineers consistently recommend
3. Known production gotchas specific to this stack/version

Include direct quotes from sources where available. Cite each finding with its source URL.
Prioritise findings from 2024–2026.
```

---

**Query 2 — Depth: Plan fit assessment**

```
Here is an implementation plan summary: [paste plan summary — max 200 words]

Based on the following findings from Query 1: [paste numbered findings]

Answer these questions in order:
1. Which findings does this plan explicitly account for? (list each)
2. Which findings does this plan NOT account for — potential blind spots? (list each)
3. What would experienced engineers do differently, and why?
4. What assumptions is this plan making that could prove wrong?

Format as a table: Finding | Accounted for? | Risk if ignored
```

---

**What to look for in Query 2 results:**
- Anything the dev plan does not mention
- Alternative approaches with better production track records
- Version-specific gotchas for the RushCut stack (Tauri, React, TypeScript)
- UX/performance patterns from comparable tools (DaVinci, CapCut, Premiere)
- Devil's advocate positions — Perplexity's multi-model synthesis may disagree with Claude's approach

**Pass threshold:** Consultant must produce the findings table and explicitly flag every "NOT accounted for" row to CPO. CPO decides whether each gap is acceptable or blocks the plan.

---

## What This Replaces

Previously the pipeline attempted to run Perplexity across all 4 gates simultaneously, causing:
- Browser contention (two agents colliding in the same Perplexity session)
- Self-reported search results with no transcript verification
- Overlapping responsibilities between auditor and consultant
- Vague, unstructured search outputs with no source mapping

This plan consolidates Perplexity to Gate 3 only (one sequential spawn), removes JTBD from automation, enforces hard transcript-verified gates with explicit PASS/FAIL strings, mandates structured output formats for all searches, and requires `site:` scoping on all WebSearch queries to prevent low-quality generic results.
