# Autonomous dev-plan → PP → implement → wrapup recipe (trial run, #121)

> TEMP working doc — not part of the permanent docs taxonomy. Delete or fold into LEARNINGS.md once the pattern is confirmed across a couple more sessions.

## What this is

A recipe for running RushCut's dev-plan → implement → wrapup pipeline with **zero manual check-ins**, using Perplexity (RushCut Space) as a stand-in for every point that would normally ask the user a question. Validated end-to-end on issue #121 (2026-07-12).

---

## One-time setup

1. Install "Claude for Chrome" extension (Chrome Web Store), sign in with the same Anthropic account as Claude Code.
2. In Claude Code: `list_connected_browsers` → `select_browser` with the returned `deviceId`.
3. In Perplexity: open the **RushCut Space** (left sidebar), set the model selector (bottom-right of compose box) to a model with Thinking enabled — **GLM-5.2 has Thinking on by default, no extra toggle needed** (faster than GPT-5.6 Terra + manual Thinking toggle).

**Why real Chrome, not the sandboxed preview browser:** the sandboxed `Claude_Browser`/`preview_*` tools are a fresh, logged-out context — Claude cannot enter passwords under any circumstance, so there'd be no way to authenticate. Real Chrome via the extension is already logged into your Perplexity Pro account.

---

## The exact prompt templates (verbatim, reused every round)

**Round 1 — findings + ask:**

```
thoughts? see github - issue <N>@GitHub <findings, root-cause analysis, any expanded-scope reasoning>. What does success look like for this fix, and any traps or objections to my scope?
```

**Round 2 — the plan:**

```
thoughts? + plan: <the full implementation plan, numbered steps, verification method>. Any objections to the plan itself before I implement?
```

**Round 3 — final check (always run, even for a trivial fix):**

```
last thoughts on plan? do one last web search if anything could be improved (traps found or recommendations by other coders), then search - what do pro editors do, and my closest competitors - how do they solve this problem? then final feedback for claude? <plan recap>
```

**Post-implementation — wrap-readiness check:**

```
thoughts? Implemented and verified. <what was done, how it was verified, what got cleaned up>. Ready to run wrapup (commit + push origin/main + close #N)? Any concerns before I do?
```

Each round: re-select the model before typing (it silently resets — see Learnings below), type the message, click submit, then read the response back with `get_page_text` (not just a screenshot) to get the full text including anything below the fold.

---

## What Claude does instead of asking the user

| Old checkpoint                         | New behavior                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| "What does success look like for you?" | Ask PP round 1, use PP's answer as acceptance criteria                            |
| "Here's the plan, does it look right?" | Send PP round 2, revise if PP objects, no user pause                              |
| "Any final concerns before I build?"   | Send PP round 3 (competitor/pro-editor research + final check)                    |
| "Should I commit / wrap up?"           | Ask PP directly, assess the answer, proceed to wrapup if PP has no real objection |

## What still stops for the user (non-negotiable, confirmed unaffected by autonomy grant)

- Any password, credential, or Windows elevation/UAC prompt
- Clicking Render in the live `rushcut.exe` (computer-use can't target it — not a Start Menu app)
- Real visual/taste judgment on rendered video output
- The five prohibited-action categories from Claude's own safety rules (these can't be waived by user instruction at all)

None of these came up in the #121 trial — it was a pure backend logging fix with no UI and no render-quality question.

---

## Learnings from this run

1. **CDP typing timeouts are usually cosmetic.** A `browser_batch` `type` call on a long message can throw `CDP sendCommand "Input.dispatchKeyEvent" timed out after 30000ms"` — but the text almost always lands anyway. Don't retry blindly (risks double-typing); wait ~5s, then check via `get_page_text` (works even when `screenshot` itself times out with "page is busy").
2. **Perplexity's model selector does not persist.** It resets to a default ("Best"/"Pro") after navigating to a fresh URL, and apparently also between sends in the same thread. Re-verify and re-select before every single message — don't assume a model chosen 2 messages ago is still active.
3. **Two separate "browser" MCP tool families exist with identically-named methods** — `mcp__Claude_Browser__*` (sandboxed preview pane, logged out) vs `mcp__claude-in-chrome__*` (real logged-in Chrome). Easy to call the wrong one; always double-check the tool prefix.
4. **Weekly advanced-model quota can run out mid-session** (banner: "No more uses of the advanced AI model remaining this week"). The model dropdown may silently show a different model after sending despite being set correctly beforehand. User's call: ignore it, answers stayed good quality even so — but worth knowing quota exists at all, in case answer quality ever visibly degrades.
5. **A GitHub issue's own root-cause diagnosis can be incomplete.** #121 named only `has_open`/`has_close`; grepping every variable referenced in the same code block against its assignment site found two more variables with the identical bug, one of which would have crashed *first*. Worth an explicit "grep-audit everything in the same block" step before trusting a bug report's stated fix, regardless of who/what wrote the report.
6. **Direct CLI verification (hand-built manifest → `pipeline/run.py`) is fast and sufficient for backend-only fixes.** No need to touch the UI, DB, or a real project — a 5-second test clip trimmed to 5s gave a full pipeline run in under a minute, including cleanup.

---

## Efficiency fix for the next run — use the copy button, not full page reads

`get_page_text` re-reads the *entire growing PP thread* every time (round 3's read included rounds 1+2+3 concatenated) — this was the single biggest token cost of the whole session, almost pure overhead since none of it substituted for reasoning Claude had to do anyway. **Fix for next time:** after sending a message, wait ~30s (PP's answers land well within that), then click PP's own copy-to-clipboard button (the two-squares icon under each answer) and read the clipboard — gets just the latest answer, not the whole thread history. Standardize on a 30s timer + copy-button as the default pattern instead of screenshot-then-get_page_text loops.

Token cost from Claude's own side was not the bottleneck this session (the browser-automation round-trip overhead was), so there's room to let PP search as broadly as it wants per round — no reason to constrain PP's own search budget.

## What must stay deterministic vs. what can flex

- **The 3-4 round prompt templates themselves must be sent verbatim, every time** — same wording, same structure, same order (findings+ask → plan → final-check-with-competitor-research → wrap-readiness check). This is what makes the pipeline repeatable and comparable across sessions/issues.
- **How much PP searches within each round is free to vary** — there's no Claude-side token cost to PP doing more or less web search, so no need to constrain that. Let PP decide its own search depth per round.

## Why Claude-family models are deliberately excluded from the PP rotation

User's standing choice: never select Claude Sonnet 5 as the PP model, even though it's available, specifically to preserve **cross-architecture diversity** — rotating between GPT-5.6, Gemini, and GLM gives genuinely different training/reasoning biases checking Claude Code's own work. A subagent spawned via Claude's own `Agent` tool cannot replicate this — it's still Claude underneath, however independent its context window is. This is the central open question for the subagent-vs-PP test: does losing cross-model diversity cost more than it saves in mechanical overhead?

## PP's source-hierarchy routine (pasted verbatim by the user, 2026-07-12)

This is PP's own description of how it prioritizes sources when researching a Claude-Code-related question — worth replicating in a test subagent's system prompt if we want a fair comparison, since PP's answer *style* (structured sections, devil's-advocate, "what if/implications", TL;DR, next actions) is as much a part of its value as the search itself.

> For Claude-code help, I'd usually start with 10 source types, in this order: official docs, repo issues/discussions, competitor docs, changelogs/releases, benchmark/writeups, community forums, GitHub examples, blog posts from practitioners, product reviews, and your own logs/context. Reddit **is** one of them, but only as a signal source, not as proof.
> 
> **Top 10 sources**
> 
> 1. Official product docs and release notes.
> 2. GitHub repos, issues, discussions, and README files.
> 3. Competitor docs and help centres.
> 4. Changelogs, migration notes, and breaking-change announcements.
> 5. Benchmark posts and technical comparisons.
> 6. Practitioner blogs and implementation writeups.
> 7. Reddit threads for real-world pain points and workarounds.
> 8. Hacker News / developer forums for candid trade-offs.
> 9. Review sites and analyst roundups for market direction.
> 10. Your own codebase, logs, and error traces.
> 
> **Where Reddit fits**
> Reddit is useful for: finding traps people hit in practice, spotting repeated complaints, seeing what workflows actually work.
> Reddit is weak for: exact facts, stable best practice, anything that needs verification.
> 
> **My search rule** — 3 buckets:
> 
> - **Truth**: official docs, repo issues, changelogs.
> - **Signal**: Reddit, HN, forums, reviews.
> - **Context**: your logs, code, competitor patterns.
> 
> **Practical use for Claude Code specifically:** bias toward official Anthropic docs, GitHub issues/discussions, competitor docs like Cursor/Copilot/Windsurf, community threads for failure modes, your own project logs.
> 
> **TL;DR:** Use Reddit, but only as a signal source. Trust official docs, repos, and changelogs first; use community posts to spot traps and workflow patterns.
> 
> **Next actions:** 1. Use official docs first for facts. 2. Use Reddit/HN second for traps and edge cases. 3. Use your own logs last to validate fit.
> 
> **Devil's advocate:** Reddit can be noisy and overfit to power users. If you lean on it too much, you may optimise for anecdotes instead of stable workflows.
> 
> **What if / implications:** If the product is changing fast, Reddit becomes more valuable because docs lag. If the product is stable, Reddit matters less and official sources should dominate.

**Note the response shape** — this is the pattern to replicate in a test subagent's prompt: structured sections → devil's advocate → "what if / implications" → TL;DR → next actions. PP doesn't just answer, it stress-tests its own answer before handing it back.

## Next step (planned, separate conversation)

Build a temporary subagent using this exact recipe (same verbatim round templates, same source-hierarchy bias, same response shape) and run it against a similarly-scoped issue to #121, in parallel/comparison with the real PP-via-browser loop. Then decide whether the mechanical efficiency gain (no browser automation, no CDP timeouts, no quadratic thread re-reads) outweighs the loss of genuine cross-model diversity.

**Candidate issue for the test: [#102](https://github.com/bondybondbond/rushcut/issues/102)** — "Intro card silently misapplies per-clip zoom to the wrong clip (off-by-one, zoom_vfs not shifted)." Similar shape to #121: contained Python bug in `render.py`, no UI, verifiable without a real render/DB, and — like #121 — has a build-in "is the report's own diagnosis actually still accurate?" question (the issue itself says #98's fix *might* have already resolved this as a side effect, but that's unconfirmed — good parallel to #121's "the issue's stated root cause was incomplete" theme).

**Update 2026-07-12: #102 turned out already fixed** (confirmed by reading `render.py` directly — #98's `zoom_vfs` extension already covers it), so the actual trial ran on **#122** instead ("single-clip renders silently ignore opening_transition/closing_transition config") — same shape, still a live bug.

---

## Trial results — subagent-as-consultant vs. real Perplexity (run on #122, 2026-07-12)

### What was built

`.claude/agents/rushcut-pp-consultant.md` — a Claude subagent encoding the same 4 verbatim round templates, PP's source-hierarchy routine, and PP's response shape (direct answer → devil's advocate → what-if/implications → TL;DR → next actions). **Discovered mid-trial:** newly-created `.claude/agents/*.md` files are not picked up as a `subagent_type` value mid-session — the Agent tool's registry is fixed at conversation start. Worked around by invoking `general-purpose` with the full persona pasted inline into each prompt; functionally equivalent, just can't rely on the frontmatter `model:` default (passed `model` explicitly per call instead). Any future instance of this pattern should expect the same restart requirement.

### Effectiveness — did it catch real bugs?

**Yes, substantively.** Across 4 rounds the subagent caught three defects that would have shipped without it:

1. **Round 2 (plan critique):** an early draft's "delete lines 965-970" instruction would have deleted `shuffle_between`'s read too, crashing **every multi-clip render** with `UnboundLocalError` on `has_xfade` — a far worse regression than the bug being fixed, and outside what the all-single-clip verification matrix could ever catch.
2. **Round 2:** an early draft used unconditional `str()` for the wrap-pass's ffmpeg command instead of `to_win_path(...) if is_amf else str(...)` — would have silently broken every 4K AMF single-clip render (feeds a WSL path to Windows-native `ffmpeg.exe`), invisible in CLI testing (CLI always falls back to libx264).
3. **Round 3 (final check):** "mirror `_boundary_reencode` exactly" would have dropped audio entirely — that helper maps video-only by design (U1g does audio separately on a whole-project track); the single-clip path has no such separate track and needed the audio map added explicitly.
4. **Round 3, secondary:** flagged that reusing final `codec_args` for both the inner pass and the wrap pass would double-encode the whole clip at final quality — fixed by making the inner pass a cheap libx264 intermediate, wrap pass only at final quality.

All four were caught via direct code reads (`Read`/`Grep` against the real repo), not guesswork — every objection cited an exact line number and was independently re-verified against the file before being trusted.

### Cross-model diversity — the real question this trial was testing

**Named directly, not glossed over:** the subagent is Claude underneath, reviewing Claude's own plan. It said so explicitly, unprompted, in Round 1 ("I have no structural advantage in judging whether the fix is correct once written beyond what any second read-through would catch... closer to 'a careful second reviewer reads the same code' than 'an architecturally distinct check'"). **Verdict for #122 specifically: cross-model diversity did not appear to matter here.** All three real defects caught were things a sufficiently careful same-architecture re-read would also catch — file-path conventions, scope/variable-lifetime bugs, and an "exactly" instruction taken too literally are RushCut-codebase-specific traps (documented in this repo's own LEARNINGS.md), not blind spots that specifically require a different training lineage to see. Whether a genuinely different architecture (GPT/Gemini/GLM) would have caught something *else* instead — a category this subagent is structurally blind to — remains untested; #122 didn't happen to surface such a case.

### Token cost

| Round              | Tokens       |
| ------------------ | ------------ |
| 1 — findings+ask   | 102,087      |
| 2 — plan critique  | 96,059       |
| 3 — final check    | 98,420       |
| 4 — wrap-readiness | 91,989       |
| **Total**          | **~388,600** |

For comparison, the #121 PP-browser trial's stated bottleneck was browser-automation round-trip overhead (CDP typing timeouts, quadratic `get_page_text` thread re-reads), not Claude-side token cost — that session didn't log a comparable token figure, so this isn't a clean apples-to-apples number, but ~390K tokens across 4 rounds for one small backend fix is a real, non-trivial cost on its own terms (roughly 4x a typical single-agent implementation pass for a fix this size).

### Verdict

**Keep using the subagent for this class of task (contained backend/pipeline bug, no UI) — it earned its cost on #122.** It's mechanically cheaper than the PP-browser loop (no CDP timeouts, no model-selector re-verification, no thread-history re-reads) and lost nothing on cross-model diversity for this particular bug, because none of the three real catches needed it. Open question for a future trial: pick an issue where the *right* answer plausibly depends on outside-the-codebase judgment (a UX/taste call, an FFmpeg approach where "what do competitors do" genuinely matters) — that's the shape of task most likely to expose the diversity gap this trial didn't.

**PP's own read on the #122 result (pasted back in, 2026-07-12):** asked to self-assess whether it would have caught the same 3 bugs, PP said 2 of 3 yes (the `shuffle_between` scope crash and the AMF `to_win_path` gap are both "just reading Python"/grepping the existing convention, not architecture-specific), and called the 3rd (dropped audio from copying `_boundary_reencode` too literally) "a tool-access question, not a model-diversity question" — i.e. it would catch it too, given the same ability to read the actual helper function. PP's conclusion: none of #122's bugs needed outside-the-codebase knowledge, so the diversity gap didn't show up because the task never exercised it. This matches Claude's own verdict above and is the basis for the tandem model below.

---

## Tandem model (adopted 2026-07-12, for all future trials)

Not a rematch — the two tools aren't competing for the same job. Route by question shape:

- **Internal subagent (`rushcut-pp-consultant`, via `general-purpose` + persona pasted inline per the registry-reload trap above)** — code-correctness rounds: root-cause findings, plan critique, implementation audit, wrap-readiness. Anything answerable by reading the actual repo. Cheap, fast, no browser babysitting, no reliability tax. Default for this half of every session.
- **Real Perplexity (RushCut Space, GLM-5.2, via `claude-in-chrome`)** — market/taste-shaped rounds only: "what does DaVinci/CapCut/Premiere do here," "what would a user expect," a naming/copy/positioning call, anything with no code-legible right answer. Only invoke this round when the actual question at that point in the plan is genuinely outside-the-codebase — don't run it reflexively every session just because the recipe exists.

### Orchestrator checklist before a market-research round (verify every time, state doesn't persist)

1. **Is Chrome connected?** Call `list_connected_browsers`. If nothing is connected, stop and ask the user to confirm the "Claude for Chrome" extension is installed and signed into the same Anthropic account (One-time setup step 1 above) — do not guess a URL or attempt a headless workaround.
2. **Select the browser.** `select_browser` with the returned `deviceId`.
3. **Navigate to Perplexity and the RushCut Space.** Go to Perplexity's site and open the **RushCut Space** from the left sidebar (no direct deep-link URL is tracked in this doc — always navigate via the sidebar, since Space URLs aren't guaranteed stable). Confirm via `read_page`/`get_page_text` that the Space name is visible before sending anything.
4. **Re-verify the model selector on EVERY send, not just the first.** It silently resets to a default ("Best"/"Pro") after navigation and, per prior-session findings, sometimes between sends in the same thread too. Set it to a model with Thinking on — GLM-5.2 has this on by default, no extra toggle. Screenshot-check the button label before typing, every time.
5. **Send the exact verbatim round template** for the round type being run (see "The exact prompt templates" section above) — do not paraphrase or compress it.
6. **Read the answer via the copy-button, not `get_page_text` on the whole page.** Per the "Efficiency fix" section above: wait ~30s, click PP's copy-to-clipboard icon under its answer, read the clipboard. `get_page_text` re-reads the entire growing thread every time and was the single biggest token cost of trial #1 — don't repeat that mistake.
7. **A `type()` CDP timeout is usually cosmetic** — the text almost always lands anyway (see Learnings #2 above). Don't blindly retry; wait ~5s and check via a targeted read instead of a full screenshot.

`.claude/agents/rushcut-pp-consultant.md` has been updated to state explicitly that market-research-shaped questions are out of its scope under this tandem model — it should not attempt `WebSearch`/`WebFetch` as a substitute for real outside judgment; that routes to real PP per this section instead.

---

## Autonomous decision authority (adopted 2026-07-12, correction after #97 session)

**What went wrong:** during the #97 planning session, the orchestrator (the Claude Code session driving `rushcut-dev-plan`) stopped to ask the user directly, twice, on questions that should have been decided by the subagent (or escalated to PP) first — once for the Step 5a "what does success look like" acceptance-criteria question, and once for a scope-expansion decision (whether to fix an identical duplicated bug found in a second file). Both times the orchestrator second-guessed whether to invoke the subagent instead of just invoking it. The user's correction, verbatim in spirit: *the agent is supposed to tackle all of such questions — make the necessary changes so it catches them automatically, decides in the user's place throughout, and only stops the user when clearly tagged `[human opinion needed]`.*

**Orchestrator rule going forward — no more per-round deliberation:**

1. **Auto-invoke, don't decide whether to invoke.** The instant `rushcut-dev-plan` reaches a checkpoint that would normally pause for a user check-in (Step 5a's acceptance-criteria question, Step 5b's plan critique, the pre-build final check, wrap-readiness, and any ad-hoc scope/objection question that comes up mid-session), invoke `rushcut-pp-consultant` immediately. Do not weigh "is this worth asking the subagent" — that weighing is itself the mistake #97 made twice.
2. **Escalation ladder, in order:**
   - Subagent (`rushcut-pp-consultant`) decides — this is the default for anything with a code-legible answer, including scope calls informed by what's actually in the repo.
   - If the subagent states it has no strong opinion (typically because the question is market/taste-shaped) — route to real Perplexity next, per the existing "Tandem model" checklist above.
   - Only if the question is **genuinely irreducible** (a pure personal-preference call PP itself can't settle, or an action blocked by tool restrictions needing the human's own hands/credentials/click) does the orchestrator stop and ask the actual user — and it must tag the ask clearly: **`[human opinion needed]`**.
3. **Batch every human-escalation item — never drip them one at a time.** If a `[human opinion needed]` item surfaces mid-session, do not stop right there. Collect it, keep going (routing everything else through the subagent/PP ladder), and present ALL accumulated `[human opinion needed]` items together in a single ask — ideally as early in the session as possible (e.g. immediately after Step 5a's findings are in, before deep planning work), so the user answers once and isn't pulled back in repeatedly.
4. **Standing constraints survive autonomy.** Logs-first (never propose a sync/perf/quality fix without real log/timing data) and one-fix-at-a-time (don't let subagent-granted scope authority turn into bundling unrelated fixes) still apply — the subagent is instructed to flag violations of either as plan objections, same as any other correctness issue.
5. **This is now the default posture for every `rushcut-dev-plan` session while this trial file exists** — not something the orchestrator opts into per-session. If the orchestrator finds itself typing `AskUserQuestion` or a mandatory-stop message for anything other items 3's two carve-outs, that's the signal it just repeated the #97 mistake.

---

## Deterministic dual-consultant spawn — supersedes manual-drive-chrome-inline (adopted 2026-07-13, after the #97 JTBD reframe)

**What changed:** the "Tandem model" section above still describes the orchestrator *itself* driving `claude-in-chrome` inline, synchronously, only when it judges a market/taste question has come up. Two things prompted a tighter version, both surfaced in the #97 session:

1. The orchestrator never actually reached for real PP for #97's own JTBD question — `rushcut-pp-consultant` (same-architecture Claude) approved the original developer-framed copy without catching the gap. It took the *user* separately consulting real Perplexity outside this pipeline entirely to catch it. A same-architecture subagent judging whether a user story is "really" user-framed vs. developer-framed is exactly the kind of question it's least equipped to catch in itself — it doesn't have an outside vantage point on what it just wrote.
2. The user, reviewing this, explicitly directed: spawn the real-PP consultation **deterministically and immediately** at the start of every `rushcut-dev-plan` session (not as a judgment call the orchestrator makes mid-session), as its own independent agent with its own context window (not the orchestrator driving Chrome inline in its own context), specifically scoped to JTBD/DoD verification and competitor research.

**What was built:** `.claude/agents/rushcut-real-pp-auditor.md` — a proper spawnable agent (not inline orchestrator browser-driving) encoding the exact setup checklist and prompt templates from this doc's "Tandem model" section, scoped narrowly to JTBD/DoD/competitor-research questions. `rushcut-dev-plan` SKILL.md's new Step 0 spawns it via the `Agent` tool with `run_in_background: true` as the very first action of every session, before Step 1 even begins — so its research (user-story sanity check + competitor angle) is ready by the time Step 1.5 needs it, rather than the session stalling on a synchronous browser-automation round.

**Routing is now three-way, not two-way:**
- `rushcut-pp-consultant` (Claude subagent) — code-correctness lane, unchanged from the Tandem model above.
- `rushcut-real-pp-auditor` (real Perplexity/GLM-5.2 via `claude-in-chrome`, spawned deterministically) — JTBD/DoD/competitor-research lane, replacing the orchestrator's old ad-hoc inline drive.
- Human — only two things now, per the user's explicit tightening: a genuinely irreducible taste verdict (flagged immediately at the session's start, not queued for later), or a crisis neither consultant can resolve. No other check-in point survives.

**Known constraint carried forward:** newly-created `.claude/agents/*.md` files are not registered as a `subagent_type` mid-session (the Agent tool's registry is fixed at conversation start — see the #122 trial note above). `rushcut-real-pp-auditor` will work correctly starting from the *next* fresh session after this file was created, not retroactively within the session that created it.

---

## Merge vs. keep-separate — resolved, and the fully-autonomous end-to-end flow (2026-07-13)

**Should `rushcut-pp-consultant` and `rushcut-real-pp-auditor` be one agent?** Asked and answered: no, keep them separate. They are not two labels on the same capability — they're mechanistically different. `rushcut-pp-consultant` is Claude (Sonnet) with its own context window, fast/cheap, deep repo access, for anything with a code-legible answer. `rushcut-real-pp-auditor` drives an actual different foundation model (GLM-5.2, via real Perplexity through a live browser) — genuine cross-architecture reasoning and materially broader search than an internal `WebSearch` call, which cannot be replicated by any internal-only agent configuration. Verified in practice, not just asserted: on its first real run (prepping #124's JTBD/competitor angle), the auditor reversed its own initial finding ("competitors revert to originals at export") after weighing it against `docs/speed-goal.md`'s render-time constraint — real outside reasoning. It also correctly declined an out-of-scope task (verifying Claude Code's own documentation, handed to it in the same session) rather than stretching to do it, confirming its scope boundary holds under real use.

**Three safety/isolation claims independently verified** (official docs + direct repo inspection, not just assumed):
1. Subagents get an isolated context window with no inheritance of the calling session's history — confirmed by `code.claude.com/docs/en/sub-agents` ("Each subagent runs in its own context window... works independently") and empirically (every subagent spawn this session required explicit context-passing).
2. Subagents cannot write, at any stage — all three current agents (`rushcut-pp-consultant`, `rushcut-real-pp-auditor`, `rushcut-qa-reviewer`) have `tools:` frontmatter with no `Edit`/`Write` at all.
3. The hard-gate's "spawn-first, block-second" design has no self-arming race for a fresh session — the compliant-spawn check runs unconditionally before any transcript read. `code.claude.com/docs/en/hooks` confirms `PreToolUse` hooks under the same matcher run in parallel with no documented precedence rule for conflicting decisions, but this design has no cross-hook state dependency, so that's not a risk here. The one real incident (documented in `feedback-deterministic-hooks-pattern.md`) was a one-time bootstrapping artifact, not a structural flaw.

**The full flow, as the user explicitly redefined it:**
1. User says "dev plan" + an issue number, optionally adding taste/success-definition direction.
2. Step 0 fires immediately: `rushcut-real-pp-auditor` spawns in the background (hard-gated, not optional).
3. Research (Steps 1-4), then the Step 1.5 JTBD gate — resolved by the auditor's findings, or `rushcut-pp-consultant` if Chrome wasn't connected.
4. Plan production (Steps 5a/5b) via `rushcut-pp-consultant`'s Round 1/2 — no human pause unless a genuine taste fork surfaces (flagged immediately, not queued).
5. Implementation (Step 6) — `rushcut-qa-reviewer` reviews each step in the background; testing/rendering happens here, in the steps between planning and wrapup, not bolted on at the end.
6. Step 6.9 — `rushcut-pp-consultant`'s Round 4 (wrap-readiness) is now the actual authorization gate, checked against `docs/PRD-DEV.md`/`speed-goal.md`/`quality-goal.md` as a stand-in for the user's own standing taste. A clean approval auto-triggers `Skill(rushcut-wrapup)` — no "does this match success?" human ask anymore. An unresolved concern after one fix-and-retry is the "crisis neither consultant can resolve" exception, and surfaces to the user.
7. Step 7 — one consolidated final report once wrapup completes. This, plus any Step 5 taste-verdict ask, are the only two points the user hears from the orchestrator about this batch.

---

## Model tiering + one-session-per-issue (adopted 2026-07-14)

Two follow-on refinements from the user, both encoded directly in `.claude/agents/rushcut-real-pp-auditor.md`:

- **Model tiering, not a single default.** The auditor runs rarely (twice per issue: JTBD verification, then competitor research), so use the strongest available model for those two mandatory gates — **GPT-5.6 Terra, Thinking toggle ON** — rather than defaulting to GLM-5.2 out of habit. GLM-5.2 remains fine for any incidental third query beyond the two gates (e.g. an ad-hoc market/taste escalation from `rushcut-pp-consultant` mid-plan).
- **One new Perplexity session per GitHub issue, never a reused thread across issues.** Gate 1 (JTBD verification) is what creates the new session — typed into the Space's empty-state "Start a session in RushCut" compose box, not into an existing thread from the Sessions list. Gate 2 (competitor research), and any later incidental query on the SAME issue, stay in that same thread. A genuinely different issue number always starts a fresh session via the empty-state box.
