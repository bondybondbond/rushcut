# Delivery baseline (issue #200)

Purpose: evidence for whether the autonomous development process delivers
reliably and with less supervision over time. It informs a later,
owner-approved proposal for autonomy thresholds (#199). It is **not** a KPI
and sets **no targets**.

Status: **definitions v1.1 - FROZEN.** Committed before any data row. Any change
to a definition bumps the version below and requires re-coding every row.

Version log:

| Version | Date | Change |
|---|---|---|
| v1 | 2026-11-06 | Initial definitions |
| v1.1 | 2026-11-06 | (c) human turns stop at completion time. Made after reading the real transcripts, before any row existed, so no row needed re-coding. |

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
  and that is not hook output, system-reminder text, a task-notification, a
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

## Rows

(none yet - definitions are frozen first)
