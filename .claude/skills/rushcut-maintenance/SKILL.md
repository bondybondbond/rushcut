---
name: rushcut-maintenance
description: Periodic disk-usage report + optional manual cleanup for RushCut's local caches (Rust build cache, proxy cache, render-cache, WSL2). Use when the user asks to check disk usage, clean up disk space, or run maintenance on RushCut — or when /rushcut-wrapup's Step 5 build-cache flag pointed here. Report-only by default; never deletes without an explicit yes for that specific action. Not auto-triggered — run manually every few weeks or whenever disk space looks off.
---

# RushCut disk maintenance

Report-only by default. This skill's job is visibility first — every cleanup action below is a separate manual prompt the user must approve before it runs. Nothing is deleted automatically, matching the "logs first, fixes second" discipline already used for pipeline/sync fixes.

**`C:\clips\processed` is explicitly out of scope for this skill.** It holds user-owned render output, not repo/cache artifacts — its size is not evidence of a cleanup problem and it should never be offered for deletion here.

---

## Step 1 — Report current sizes (read-only)

```powershell
Write-Host "--- src-tauri/target (Rust build cache) ---"
if (Test-Path C:\apps\rushcut\src-tauri\target) {
  $s = (Get-ChildItem C:\apps\rushcut\src-tauri\target -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  Write-Host "$([math]::Round($s/1GB,2)) GB"
} else { Write-Host "0 GB (already clean)" }

Write-Host "--- .git ---"
$g = (Get-ChildItem C:\apps\rushcut\.git -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host "$([math]::Round($g/1MB,1)) MB"

Write-Host "--- proxy cache (%APPDATA%\rushcut\proxies) ---"
$p = (Get-ChildItem "$env:APPDATA\rushcut\proxies" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host "$([math]::Round($p/1MB,1)) MB"

Write-Host "--- render-cache (%APPDATA%\rushcut\render-cache) ---"
$rc = (Get-ChildItem "$env:APPDATA\rushcut\render-cache" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
Write-Host "$([math]::Round($rc/1MB,1)) MB (self-pruning via render_cache.py prune() -- no action needed here, size is for visibility only)"

Write-Host "--- WSL2 disk usage ---"
wsl -d Ubuntu-24.04 -u root -- df -h /
```

---

## Step 2 — Offer cleanup only where warranted (each requires explicit yes)

**If `target/` exceeds ~15GB:** offer `cargo clean`. Explain the tradeoff before asking: reclaims the space immediately, but the next `pnpm dev` / `cargo build` will be a full rebuild (5-15 min) instead of incremental.

```powershell
cd C:\apps\rushcut\src-tauri
cargo clean
```

**If `.git` has grown unexpectedly large again** (e.g. a build artifact got accidentally committed and later removed, same pattern as the March 2026 `target/`-in-history incident): this is a one-off history-rewrite decision, not something this skill automates. Report the anomaly, identify the offending path via `git log --all --oneline -- <path>`, and let the user decide whether a `git-filter-repo` rewrite + force-push is worth doing — each occurrence is a deliberate call, never routine.

**Proxy cache and render-cache:** report only. Proxy cache is actively used working state (don't offer to clear unless the user is troubleshooting a specific proxy bug elsewhere). Render-cache is already self-bounding (age+count pruned automatically in `render_cache.py`) — no manual action is ever needed for it.

---

## Notes

- This skill does not touch `C:\clips\processed`, WDIO test artifacts, or session temp files — those are `/rushcut-wrapup` Step 5's job (ephemeral, per-session).
- This skill does not perform git history rewrites itself — see Step 2's note above.
- `git-filter-repo` (if ever needed again) is not installed on the Windows Python (which has a broken `pip` on this machine as of 2026-07-10) — use WSL2's Python3/pip instead: `wsl -d Ubuntu-24.04 -u root -- pip3 install --break-system-packages git-filter-repo`, then run `git filter-repo` from WSL against `/mnt/c/apps/rushcut`.
