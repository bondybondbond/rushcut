# Batch N — Background Proxy Pre-Generation
## Planning Brief (2026-05-18)

> This file is a planning scratch pad for Batch N. It contains the full analysis from the
> founding conversation + the advisor review. Superseded by PRD-DEV.md once build starts.
> Delete after Batch N ships.

---

## Problem statement

First render for 6 DJI 4K clips (1:37 film) takes ~5 min total — ~2.5 min normalisation alone.
The proxy-reuse optimisation (Batch C) only fires on *re-renders*. Re-renders happen when
the user is already unhappy with the output. First-time triers — the users who matter most
for launch — always pay the full cost.

The 1080p H.264 proxy file and the normalise intermediate are the *same file*. If the proxy
exists before render starts, normalise is skipped (~2s vs ~2.5 min). The gap between the
Trimmer and hitting Render is ~5 min of natural user activity (Arrange + Sound tabs).
That window is the opportunity.

---

## Decision: Option B — trigger on Trimmer exit

**Trigger:** user navigates away from Trimmer tab (bottom tab bar click, first time only or
any time they leave).

**Why not on upload:** wastes CPU on pantry clips. 60-clip session → 10 min background work
for clips that never render.

**Why not at render time:** too late. User is already waiting.

**The math:**
- 6 included clips × ~10s per proxy (ultrafast, 1 thread) = ~60s background work
- User spends ~5 min on Arrange + Sound tabs
- Proxies done before Render on any typical session

---

## Advisor review (founder, 2026-05-18)

> Option B is correct. Three things to validate/build:
>
> 1. **Confirm Trimmer exit is a single clean event** — not a multi-fire. The re-trigger
>    guard ("only queue clips with proxy_status IS NULL") handles bouncing, but verify
>    the check is O(1) (a DB flag), not a file-existence call in the hot path.
>
> 2. **Log-first, fix second** — add `[PROXY_BG] started clip_id=X` / `[PROXY_BG] done
>    clip_id=X elapsed=Xs` before touching render logic. Confirm background proxying fires
>    at the right time. Only then update the render path to skip normalise.
>
> 3. **Add `proxy_status` DB column** — `NULL | 'queued' | 'done'`. Makes re-trigger logic
>    trivial and avoids file-existence checks inside the render hot path.
>
> **Devil's advocate:** the 5-min Arrange window is an estimate. Power users may spend 30s
> on Arrange. If they hit Render at second 35 and proxy gen takes 60s, they see the
> "Preparing clips" fallback for a few clips — not a failure, just not "instant". Don't
> market as instant until real timing data confirms the median session covers the window.
>
> **On parallelism:** the actual win is time-shifting, not parallelism. Running 6 clips
> serially at nice 10 / 1 thread during the Arrange window is the correct approach. True
> parallelism (multiple FFmpeg processes) hits the WSL2→NTFS disk I/O ceiling before CPU.

---

## Files to change

| File | Change |
|---|---|
| `src-tauri/src/db.rs` | Add `proxy_status TEXT DEFAULT NULL` column; additive migration |
| `src-tauri/src/lib.rs` | Pass `low_priority` bool through `generate_proxies_cmd`; use existing Arc<Mutex> concurrency guard |
| `pipeline/proxy.py` | `low_priority: bool = False` param → `nice -n 10 ionice -c3 -threads 1` prefix; `[PROXY_BG]` log lines; set `proxy_status='done'` after `is_valid_proxy()` passes |
| `src/components/BottomTabBar.tsx` | Detect `activeTab === "trimmer"` → other; fire `generate_proxies_cmd({ lowPriority: true })` for include=1 clips with no proxy |
| `pipeline/run.py` + `render.py` | Check `proxy_status='done'` (or `is_valid_proxy()`) before normalise; rename stage label "Normalising" → "Preparing clips" |

---

## Build order (log-first discipline)

1. DB migration: `proxy_status` column (additive, no data loss)
2. `proxy.py`: low_priority path + `[PROXY_BG]` logs
3. Rust: `generate_proxies_cmd` low-priority flag wiring
4. BottomTabBar trigger on Trimmer exit — **log only, don't change render path yet**
5. **Validate on real session:** leave Trimmer, open `pipeline-latest.log`, confirm
   `[PROXY_BG] done` lines appear within ~90s. Measure elapsed per clip.
6. Only after validation: wire render path to skip normalise when proxy ready
7. Rename stage label "Normalising" → "Preparing clips"
8. E2E smoke + render timing comparison

---

## Pre-build check (do this in step 0)

**Is Trimmer tab exit a single, clean event?**

Check `BottomTabBar.tsx` — does it call `onTabChange` exactly once per navigation? If the
user rapidly clicks Trimmer → Arrange → Trimmer → Arrange, does `onTabChange("arrange")`
fire once per visit or once total?

The `proxy_status='queued'` guard handles duplicates at the clip level, but if the tab event
fires twice for the same navigation, we'd spawn two Rust commands simultaneously. The
`Arc<Mutex<HashSet<String>>>` in `generate_proxies_cmd` already prevents duplicate FFmpeg
spawns per clip_id, so this is a "belt and braces" check, not a blocker.

---

## Acceptance checks

- [ ] Leaving Trimmer fires background proxy gen — confirmed in `pipeline-latest.log`
- [ ] Background gen is imperceptible: UI stays responsive on Arrange/Sound tabs
- [ ] Rapid Trimmer ↔ Arrange bouncing does NOT spawn duplicate FFmpeg processes per clip
- [ ] First render AFTER background gen completes: normalise stage ~2s total
- [ ] First render BEFORE background gen completes: graceful fallback, no crash or hang
- [ ] `proxy_status` persists across app restarts (DB-backed, not in-memory)
- [ ] All existing render E2E specs still pass

---

## Known caveats

- **4K renders:** 4K proxy per clip ~40s. Background window may not cover all clips in a
  large session before the user hits Render. Acceptable: renders fall through to full
  normalise for uncovered clips. Still faster than today for any clips that completed.
- **Power users:** median session time assumption (5 min Arrange) needs validating with real
  usage data before marketing as "fast first render".
- **Disk I/O:** `ionice -c3` (idle I/O class) in addition to `nice -n 10` ensures proxy gen
  yields on disk access to any foreground process including UI redraws and thumbnail loads.
