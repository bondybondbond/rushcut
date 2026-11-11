# Delivery baseline (issue #200)

Purpose: evidence for whether the autonomous development process delivers
reliably and with less supervision over time. It informs a later,
owner-approved proposal for autonomy thresholds (#199). It is **not** a KPI
and sets **no targets**.

Status: **definitions v1.4 - FROZEN.** Committed before any data row. Any change
to a definition bumps the version below and requires re-coding every row.

Version log:

| Version | Date | Change |
|---|---|---|
| v1 | 2026-11-06 | Initial definitions |
| v1.1 | 2026-11-06 | (c) human turns stop at completion time. Made after reading the real transcripts, before any row existed, so no row needed re-coding. |
| v1.2 | 2026-11-06 | Human turn also includes messages typed while Claude was working (stored as a different record type). Found while testing the parser on real transcripts; before any row existed. |
| v1.3 | 2026-11-06 | After owner review of the backfill: (a) excludes a design preference on correct work and a limitation of how the owner can test; (b) excludes environmental resumes (machine sleep, API error, usage limit, session end); new product level `rejected`. Every row re-coded; changes listed in the audit trail below. |
| v1.4 | 2026-11-06 | Final owner decisions: (d) `d2` requires the defect to be first tracked **after** the delivery's close timestamp (a defect already tracked before close is a scope decision, not a post-delivery failure); `validated` may be reached through a negative product decision (removal), stated in Notes. Every row re-coded; changes in the audit trail below. |

## Rules that apply to every row

- A value that cannot be evidenced is `unknown`. Never `0`, never an estimate.
- Every cell carries an evidence tag: `derived` (computed from an artifact:
  transcript, GitHub, git), `judged` (Claude classified it, so it is
  self-reported), or `unknown`.
- Counts first, percentages second. Small samples (5-10 deliveries) are
  **directional only**: no intervals, no significance claims, no trend lines.
- `source=backfill` rows (reconstructed after the fact) and `source=forward`
  rows (recorded at close-out) are **never pooled** into one rate.
- Backfilled failure counts are **lower bounds**: a defect that was fixed
  silently, or never filed, is invisible.
- No target, threshold or pass/fail number exists for any measure here.
  **Never widen autonomy on speed alone.** Faster delivery without acceptable
  reliability and product outcomes is not evidence.
- The doc holds aggregated evidence only: counts, type tags and issue
  references. No quotes or paraphrases of conversation.

## Delivery (the unit)

One delivery = the issue or bundle of issues closed by one piece of shipped
work, grouped by closing commit (for example one commit closing #165 and its
sub-issues is one delivery). Included: work that shipped, or shipped and was
reverted. Excluded (listed with the rows): docs-only work, investigations
closed without a code change, duplicates. Reverted work is always included, so
the sample is not only successes.

## The four measures

### (a) Human corrections

A user message that reports a defect in work Claude claimed was done, or
reverses Claude's interpretation of the task. Each carries one type tag:

| Tag | Meaning | Example (generic) |
|---|---|---|
| `misunderstood` | Claude built the wrong thing | "that isn't what I asked for" |
| `defect` | Delivered behaviour is broken | "it still doesn't work" |
| `unverified-claim` | Claimed verified, was not | "you said it was tested" |
| `process-miss` | Claude ignored a stated owner decision or constraint | "I told you not to do that" |

Not a correction: new scope, a taste or design change on correct work, a
design preference stated on otherwise correct work, a limitation of how the
owner can test, an answer to Claude's question, an approval, a
reprioritisation. The test is whether Claude got something wrong, not whether
the owner changed their mind or added an instruction.

### (b) Process interruptions

A user turn whose purpose is pacing the workflow, not judging its output: stop,
redirect, unblock a stalled step, restart a blocked or hung process, or nudge
Claude to continue. Not counted: a resume whose cause is environmental
(machine sleep, API error, usage limit, session end) unless recovering needed
more than resuming. Those measure the environment, not agent performance.

### Precedence rules for (a) and (b)

- One user message gets **one primary tag**. If a message could be both,
  (a) beats (b).
- Consecutive messages about the **same** defect are one (a) episode. A new
  distinct defect is a new episode.
- Judging is by Claude and is therefore tagged `judged`. The owner spot-checks
  the borderline calls and a sample of "not a correction" calls before the
  baseline is called final.

### (c) Effort to verified delivery

- **Human turns:** count of human turns across the sessions mapped to the
  delivery, **up to the completion time** (turns after completion are
  post-delivery chat and are excluded). A human turn is, positively defined: a non-sidechain `user`
  record whose content is text (pasted content included) with no tool result,
  or a message typed while Claude was working (stored as a `queued_command`
  attachment with a human origin), and that is not hook output, system-reminder text, a task-notification, a
  command wrapper, an interrupt marker, a context-compaction summary, or a
  duplicate message id. Any record shape not recognised makes the cell
  `unknown` (fail closed).
- **Active time:** wall-clock from the delivery's first mapped record to its
  evidence-backed completion, with idle gaps longer than 30 minutes dropped.
  This is an **operational elapsed-time proxy**, not effort. Completion is the
  issue close time, accepted only if it falls inside the mapped sessions'
  span; otherwise `unknown`.
- A session shared by more than one delivery is flagged `shared`; (c) is
  `unknown` for those deliveries unless the session splits cleanly.

### (d) Verified-delivery check, 14-day window

The window is 14 days after the delivery's close date. Only deliveries with a
**complete** window are counted; the number excluded for an incomplete window
is printed.

Two separate counts, then a deduplicated total:

| Count | Definition |
|---|---|
| `d1` reopened | The delivery's issue was reopened inside the window. |
| `d2` linked defect or corrective fix | Inside the window, a later issue or a fix/revert commit **cites the delivery** and reports a defect in what the delivery changed or claimed. |
| `failed` | Deliveries in `d1` or `d2`, each counted once. |

Defect-counting rule for `d2`:

- **Counts:** a regression or incorrect behaviour in what the delivery changed;
  a revert of the delivery; a claim of "fixed" that did not hold.
- **Does not count:** a pre-existing problem found while testing the delivery;
  a new feature request; test-coverage debt; polish or taste follow-ups.
- **Timing:** the defect must be first tracked (issue created, or fix/revert
  commit made) **after the delivery's close timestamp**. A defect already
  tracked before close - a disclosed carve-out, a known limitation, or a
  sub-issue fixed before close - is a scope decision made at delivery, not a
  post-delivery failure.
- Linkage is by explicit citation (issue number or commit message), never by
  timing alone. Each linked item is listed by reference with a one-word reason
  so the owner can disagree. Borderline calls are flagged `borderline`.

The #200 issue text defines "verified delivery = reopened / total", which is
the failure side. This doc reports both, always as counts:
`failed k of n`, then `verified (n-k) of n`.

### Technical verification vs product validation (per delivery)

| Level | Meaning |
|---|---|
| `technical` | Build, tests, render or log evidence says it works. |
| `validated` | Also confirmed solving the user's problem by the owner's observation or a measurable signal. Where the intended outcome was itself a removal, the delivery is `validated` through a **negative product decision** and the Notes column says so. |
| `rejected` | The owner assessed the delivered outcome and judged it wrong or unwanted for the user (not merely incomplete). A feature the owner decides should not exist is not validated success. |
| `unknown` | No evidence either way. |

A high verified-delivery rate must not be read as proof the user's problem was
solved.

## Interpretation rules

- Reliability and product outcomes must stay acceptable before any autonomy is
  widened. Speed alone is never grounds.
- Anthropic's own data shows an experienced user interrupts more as trust
  grows, so a rising (b) count is ambiguous. That is why corrections are
  tagged by type.
- This is an observation baseline. Proposing thresholds is a separate step
  that needs owner approval.
- Re-measure around **2026-12-04**.

## Relationship to the review counter

The delivery rows are the evidence source going forward. The existing
CC-improvement review counter is not treated as an additional measurement and
is left untouched here; #212 handles its eventual retirement. There is one
measure of delivery quality, not two.

## Backfill summary (2026-11-06, definitions v1.4, final)

Directional only. `source=backfill`. Corrections and interruptions are judged by
Claude (tag `judged`). The owner's four open decisions are resolved (section
"Decisions on the four open questions"). The classifications are Claude's
judgement, reviewed by the owner on the borderline calls only; they are not
verified turn by turn.

Population: 19 deliveries, every closed issue group that shipped or reverted
work between 2026-07-26 and 2026-09-05 (15 product, 4 tooling). All 19 have a
complete 14-day window; 0 excluded for an incomplete window. One delivery
(D156) is `not-assessed` for (a)-(c) because its work sessions predate the
window; its (d) is still derived.

| Measure | Count |
|---|---|
| (d) `d1` reopened | 0 of 19 |
| (d) `d2` linked defect or corrective fix | **2 of 19** (D150 via #163, D152 via its revert) |
| (d) `failed` (deduplicated) | **2 of 19**; verified **17 of 19**. A lower bound on failures. |
| Product validation | validated 11 (one through a negative product decision: D195 feature removal), technical only 6, rejected 1, unknown 1 |
| (a) deliveries with at least one correction | **8 of 18** assessed (13 corrections: defect 10, process-miss 3) |
| (b) deliveries with at least one interruption | **5 of 18** assessed (6 interruptions) |
| (c) human turns | 89 across 18 assessed deliveries (median 4 per delivery) |
| (c) active minutes | 17 deliveries with evidence (median 82); 1 unknown (completion outside session span) |

Reading notes:

- The #200 issue text calls the check "reopened / total". Reopened alone is 0
  of 19, which would hide follow-up failures. The deduplicated `failed` count
  is the figure to use.
- Technically verified is not the same as solving the user's problem: 6 of 19
  are technical only and 1 was rejected by the owner. See the `Level` column.
- Zero reopens with 2 post-delivery failures is consistent with the Gate 2
  finding that reopen-only detection can undercount. Failures never filed are
  invisible, so every `failed` count here is a lower bound.
- Three further follow-up issues were tracked before their delivery closed
  (D156, D159, D185). They are scope decisions, excluded by the timing rule,
  and are listed in the evidence table below so the exclusion can be audited.
- No autonomy threshold follows from these numbers. None is proposed here.

## Selection and exclusions

Included: closed issue groups from 2026-07-26 to 2026-09-05 that shipped or
reverted code or tooling, grouped by closing commit. Reverted work (D152) is
included.

Excluded, with reason:

| Item | Reason |
|---|---|
| #76, #176, #197 | Planned or assessed only, no code shipped |
| #153, #155 | Closed before the window |
| #125 | Closed without a code change |
| Docs-only commits | Not a delivery |
| Deliveries closed before 2026-07-26 | Outside the chosen window (older sessions exist and could extend the baseline) |

No delivery closed between 2026-09-05 and 2026-11-06.

## Owner review log (2026-11-06)

The first version of this section (borderline list, author-picked samples) is
preserved in commit 126a8d5. Decisions below were applied and every `a` and
`b` cell was re-checked against v1.3; only the listed cells changed.

| Item | Decision | Effect |
|---|---|---|
| D150 turns 3 and 4 | Excluded as corrections | D150 `a` 3 to 1 |
| D170 turns 2-3 | Excluded as a correction | D170 `a` 1 to 0 |
| D142 turn 2 | Excluded as an interruption (environmental) | D142 `b` 1 to 0 |
| D159 turn 2 | Excluded as an interruption (environmental) | D159 `b` 1 to 0 |
| D157 turn 4, D158 turns 2 and 5, D165 turn 2, D185 turn 7 | Interruptions retained provisionally | none |
| D170 turn 4 | Resolved by Claude from transcript evidence under the frozen definitions: recovery needed owner action, not a plain resume. Interruption retained. | none |
| D152 to revert | Retained as a failure | none |
| D163, D184, D192, D036, D165 links | Exclusions retained | none |
| D185, D036 validated; D165 technical | Retained | none |
| D152 level | Re-coded `technical` to `rejected` (new level, v1.3) | validated 11, technical 6, rejected 1 |

## Decisions on the four open questions (resolved 2026-11-06)

Turn numbers are positions within the delivery. Rationale that draws on the
conversation is given in the review chat, not here.

| # | Question | Decision | Effect |
|---|---|---|---|
| O1 | D141 turn 2 | Exclude (relayed instruction) | D141 `a` 1 to 0 |
| O2 | D184 turn 2 | Keep (process-miss) | none |
| O3 | Defect tracked before the delivery closed | Excluded under the frozen post-close rule; supersedes the earlier provisional retention of D156 | D156, D159, D185 `d2` 1 to 0; failed 5 to 2 of 19 |
| O4 | D195 level | Keep `validated`, through a negative product decision (feature removal) | none |

Evidence for O3 (public issue timestamps, UTC). The first three rows are
excluded because the item was tracked before close:

| Delivery (closed) | Linked item | Item created | Relative to close |
|---|---|---|---|
| D156 (2026-07-26 21:54:16) | #157 | 2026-07-26 21:03:07 | 51 min before; #157 itself closed 12 s before |
| D159 (2026-08-28 20:55:45) | #168 | 2026-08-28 20:54:53 | 52 s before |
| D185 (2026-08-30 23:50:57) | #187 | 2026-08-30 23:04:40 | 46 min before |
| D150 (2026-08-26 22:31:58) | #163 | 2026-08-27 21:27:49 | about 23 h after |
| D152 (2026-08-31 22:35:06) | revert commit 19bc66b | 2026-08-31 23:39 local | about 4 min after |

## Bias check: random sample of non-corrections

Population: every human turn I coded as neither a correction nor an
interruption, excluding each delivery's opening turn (45 turns). Draw: seeded
generator (mulberry32, seed 200), three turns without replacement: D150 turn 6,
D185 turn 9, D184 turn 6.

Result: no missed correction in these three. One coding inconsistency: in
D150 the defect episode I counted at turn 7 actually begins at turn 6
(consecutive messages about the same defect). It is still one episode, so no
count changes.

This is an illustration, not proof. Three of 45 turns says nothing reliable
about the accuracy of the other 42, and the classifications remain Claude's
judgement.

## Audit trail of row changes since commit 126a8d5 (v1.3, then v1.4)

| Row | Cell | Before | After |
|---|---|---|---|
| D150 | a corr | 3 | 1 |
| D170 | a corr | 1 | 0 |
| D142 | b intr | 1 | 0 |
| D159 | b intr | 1 | 0 |
| D152 | Level | technical | rejected |
| D141 | a corr | 1 | 0 |
| D156 | d2, Failed | 1, 1 | 0, 0 |
| D159 | d2, Failed | 1, 1 | 0, 0 |
| D185 | d2, Failed | 1, 1 | 0, 0 |

Rows D150 to D152 above were changed at the first owner review (v1.3); the
last four at the final decisions (v1.4). D170 `b` was reviewed and unchanged.

## Rows

Columns: `a` corrections, `b` interruptions, `d1` reopened, `d2` linked defect
or fix, `Failed` deduplicated. Evidence tags: d = derived, j = judged,
u = unknown.

| Delivery | Issues | Type | Closed | Src | a corr | b intr | Turns | Active min | d1 | d2 | Failed | Level | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D141 | #141 | product | 2026-07-26 | backfill | 0 | 0 | 3 | 27 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | turn 2 excluded: relayed instruction |
| D156 | #156 | tooling | 2026-07-26 | backfill | unknown | unknown | unknown | unknown | 0 | 0 | 0 | unknown | a:u b:u c:u d:d lvl:u | not-assessed; #157 tracked before close, not counted |
| D157 | #157 | tooling | 2026-07-26 | backfill | 0 | 1 | 6 | 46 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | |
| D158 | #158 | tooling | 2026-08-26 | backfill | 1 | 2 | 9 | 135 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | a: defect |
| D142 | #142 | product | 2026-08-26 | backfill | 0 | 0 | 3 | 36 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j |  |
| D150 | #150 | product | 2026-08-26 | backfill | 1 | 0 | 8 | 96 | 0 | 1 | 1 | validated | a:j b:j c:d d:d lvl:j | a: defect 1; d2 #163 (O3: created after close) |
| D151 | #151 | product | 2026-08-27 | backfill | 0 | 0 | 2 | 59 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | |
| D163 | #163 | product | 2026-08-27 | backfill | 1 | 0 | 3 | 77 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: defect |
| D159 | #159 | product | 2026-08-28 | backfill | 0 | 0 | 3 | 90 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | #168 tracked before close, not counted |
| D165 | #165 #160 #164 #166 #174 | product | 2026-08-29 | backfill | 0 | 1 | 4 | 175 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | bundle |
| D036 | #36 | product | 2026-08-29 | backfill | 0 | 0 | 1 | 57 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | confirmed after close |
| D184 | #184 | product | 2026-08-29 | backfill | 2 | 0 | 6 | 139 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: process-miss 1, defect 1 |
| D185 | #185 | product | 2026-08-30 | backfill | 3 | 1 | 11 | 205 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: defect 3; #187 tracked before close, not counted; two attempts |
| D152 | #152 #183 #182 | product | 2026-08-31 | backfill | 3 | 0 | 9 | 163 | 0 | 1 | 1 | rejected | a:j b:j c:d d:d lvl:j | a: defect 2, process-miss 1; built then reverted |
| D188 | #188 | product | 2026-09-01 | backfill | 1 | 0 | 3 | 82 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: process-miss |
| D192 | #192 | product | 2026-09-02 | backfill | 0 | 0 | 5 | 97 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | |
| D170 | #170 | tooling | 2026-09-03 | backfill | 0 | 1 | 5 | unknown | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | turn 4 interruption retained; active unknown: close outside session span |
| D189 | #189 #187 | product | 2026-09-04 | backfill | 1 | 0 | 4 | 77 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: defect |
| D195 | #195 | product | 2026-09-05 | backfill | 0 | 0 | 4 | 48 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | validated via negative product decision: feature removed; built candidate rejected |
| D201 | #201 | tooling | 2026-11-07 | forward | 4 | 0 | unknown | unknown | pending | pending | pending | technical | a:j b:j c:d d:d lvl:j (a,b,c provisional) | a: defect 3 (replay control flaw, reserved control file, agent-file contradiction), process-miss 1 (Gate 2 sequencing); replay 1 run advisory |
| D218 | #218 | tooling | 2026-11-07 | forward | 2 | 0 | unknown | unknown | pending | pending | pending | technical | a:j b:j c:d d:d lvl:j (a,b,c provisional) |  |
| D215 | #215 | tooling | 2026-11-10 | forward | 3 | 0 | unknown | unknown | pending | pending | pending | technical | a:j b:j c:d d:d lvl:j (a,b,c provisional) |  |
| D222 | #222 | tooling | 2026-11-10 | forward | 0 | 0 | unknown | unknown | pending | pending | pending | technical | a:j b:j c:d d:d lvl:j (a,b,c provisional) |  |
| D226 | #226 | tooling | 2026-11-11 | forward | 1 | 0 | unknown | unknown | pending | pending | pending | technical | a:j b:j c:d d:d lvl:j (a,b,c provisional) |  |
