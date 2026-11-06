# Delivery baseline (issue #200)

Purpose: evidence for whether the autonomous development process delivers
reliably and with less supervision over time. It informs a later,
owner-approved proposal for autonomy thresholds (#199). It is **not** a KPI
and sets **no targets**.

Status: **definitions v1.2 - FROZEN.** Committed before any data row. Any change
to a definition bumps the version below and requires re-coding every row.

Version log:

| Version | Date | Change |
|---|---|---|
| v1 | 2026-11-06 | Initial definitions |
| v1.1 | 2026-11-06 | (c) human turns stop at completion time. Made after reading the real transcripts, before any row existed, so no row needed re-coding. |
| v1.2 | 2026-11-06 | Human turn also includes messages typed while Claude was working (stored as a different record type). Found while testing the parser on real transcripts; before any row existed. |

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

Not a correction: new scope, a taste or design change on correct work, an
answer to Claude's question, an approval, a reprioritisation.

### (b) Process interruptions

A user turn whose purpose is pacing the workflow, not judging its output: stop,
redirect, unblock a stalled step, restart a blocked or hung process, or nudge
Claude to continue.

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
| `validated` | Also confirmed solving the user's problem by the owner's observation or a measurable signal. |
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

## Backfill summary (2026-11-06, definitions v1.2)

Directional only. `source=backfill`. Judged by Claude (tag `judged`); the owner
spot-check below is **pending**, so these figures are not final.

Population: 19 deliveries, every closed issue group that shipped or reverted
work between 2026-07-26 and 2026-09-05 (15 product, 4 tooling). All 19 have a
complete 14-day window; 0 excluded for an incomplete window. One delivery
(D156) is `not-assessed` for (a)-(c) because its work sessions predate the
window; its (d) is still derived.

| Measure | Count |
|---|---|
| (d) `d1` reopened | 0 of 19 |
| (d) `d2` linked defect or corrective fix | 5 of 19 (2 clear, 3 borderline) |
| (d) `failed` (deduplicated) | **5 of 19**; verified **14 of 19** (lower bound on failures) |
| Product validation | validated 11, technical only 7, unknown 1 |
| (a) deliveries with at least one correction | 10 of 18 assessed (17 corrections: defect 12, process-miss 4, misunderstood 1) |
| (b) deliveries with at least one interruption | 7 of 18 assessed (8 interruptions) |
| (c) human turns | 89 across 18 assessed deliveries (median 4 per delivery) |
| (c) active minutes | 17 deliveries with evidence (median 82); 1 unknown (completion outside session span) |

Reading notes:

- The #200 issue text calls the check "reopened / total". Reopened alone is 0
  of 19, which would hide the 5 deliveries that needed a follow-up fix. The
  deduplicated `failed` count is the figure to use.
- Technically verified is not the same as solving the user's problem: 7 of 19
  have no owner confirmation. See the `Level` column.
- Zero reopens with 5 follow-up failures supports the Gate 2 finding that
  reopen-only detection undercounts. Failures never filed are invisible, so
  every `failed` count here is a lower bound.
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

## Owner spot-check (pending)

Turn numbers are the position of the owner message within that delivery's
turns, counted from 1. No message text is reproduced here.

Borderline corrections (counted in column a):

| Delivery | Turn | Counted as | Could instead be |
|---|---|---|---|
| D141 | 2 | defect | agent-behaviour instruction, not a correction |
| D150 | 3 | misunderstood | design preference on correct work |
| D150 | 4 | defect | a testing limitation, not a defect |
| D170 | 2-3 | process-miss (one episode) | new requirement, not a correction |
| D184 | 2 | process-miss | not a correction |

Interruptions judged `b` (restart or nudge): D142 turn 2, D157 turn 4, D158
turns 2 and 5, D159 turn 2, D165 turn 2, D185 turn 7. Borderline: D142 turn 2
and D159 turn 2 (resume after the machine slept or a session ended).

Sampled "not a correction" calls: D192 turn 2 (treated as taste), D184 turn 5
(treated as new scope), D152 turn 2 (treated as a pre-existing adjacent bug).

Failure linkage in column d2:

| Delivery | Linked item | Called |
|---|---|---|
| D156 | #157 | counted (defect in what #156 shipped) |
| D152 | revert commit 19bc66b | counted (reverted) |
| D150 | #163 | counted, borderline |
| D159 | #168 | counted, borderline |
| D185 | #187 | counted, borderline (scope split) |
| D163 | #167 | not counted (no demonstrated link) |
| D184 | #185 | not counted (pre-existing playback behaviour newly visible) |
| D192 | #195 | not counted (pre-existing render defect) |
| D036 | #181 | not counted (pre-existing model behaviour) |
| D165 | #194 | not counted (pre-existing) |

Product validation judgements to confirm: D185 (core behaviour confirmed, one
residual accepted), D036 (confirmed after the issue closed), D195 (owner
decision to remove the feature), D165 (technical only).

## Rows

Columns: `a` corrections, `b` interruptions, `d1` reopened, `d2` linked defect
or fix, `Failed` deduplicated. Evidence tags: d = derived, j = judged,
u = unknown.

| Delivery | Issues | Type | Closed | Src | a corr | b intr | Turns | Active min | d1 | d2 | Failed | Level | Evidence | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D141 | #141 | product | 2026-07-26 | backfill | 1 | 0 | 3 | 27 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | a: defect |
| D156 | #156 | tooling | 2026-07-26 | backfill | unknown | unknown | unknown | unknown | 0 | 1 | 1 | unknown | a:u b:u c:u d:d lvl:u | not-assessed; d2 #157 |
| D157 | #157 | tooling | 2026-07-26 | backfill | 0 | 1 | 6 | 46 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | |
| D158 | #158 | tooling | 2026-08-26 | backfill | 1 | 2 | 9 | 135 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | a: defect |
| D142 | #142 | product | 2026-08-26 | backfill | 0 | 1 | 3 | 36 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | |
| D150 | #150 | product | 2026-08-26 | backfill | 3 | 0 | 8 | 96 | 0 | 1 | 1 | validated | a:j b:j c:d d:d lvl:j | a: misunderstood 1, defect 2; d2 #163 |
| D151 | #151 | product | 2026-08-27 | backfill | 0 | 0 | 2 | 59 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | |
| D163 | #163 | product | 2026-08-27 | backfill | 1 | 0 | 3 | 77 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: defect |
| D159 | #159 | product | 2026-08-28 | backfill | 0 | 1 | 3 | 90 | 0 | 1 | 1 | validated | a:j b:j c:d d:d lvl:j | d2 #168 |
| D165 | #165 #160 #164 #166 #174 | product | 2026-08-29 | backfill | 0 | 1 | 4 | 175 | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | bundle |
| D036 | #36 | product | 2026-08-29 | backfill | 0 | 0 | 1 | 57 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | confirmed after close |
| D184 | #184 | product | 2026-08-29 | backfill | 2 | 0 | 6 | 139 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: process-miss 1, defect 1 |
| D185 | #185 | product | 2026-08-30 | backfill | 3 | 1 | 11 | 205 | 0 | 1 | 1 | validated | a:j b:j c:d d:d lvl:j | a: defect 3; d2 #187; two attempts |
| D152 | #152 #183 #182 | product | 2026-08-31 | backfill | 3 | 0 | 9 | 163 | 0 | 1 | 1 | technical | a:j b:j c:d d:d lvl:j | a: defect 2, process-miss 1; built then reverted |
| D188 | #188 | product | 2026-09-01 | backfill | 1 | 0 | 3 | 82 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: process-miss |
| D192 | #192 | product | 2026-09-02 | backfill | 0 | 0 | 5 | 97 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | |
| D170 | #170 | tooling | 2026-09-03 | backfill | 1 | 1 | 5 | unknown | 0 | 0 | 0 | technical | a:j b:j c:d d:d lvl:j | active unknown: close outside session span |
| D189 | #189 #187 | product | 2026-09-04 | backfill | 1 | 0 | 4 | 77 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | a: defect |
| D195 | #195 | product | 2026-09-05 | backfill | 0 | 0 | 4 | 48 | 0 | 0 | 0 | validated | a:j b:j c:d d:d lvl:j | |

