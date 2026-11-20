import { spawnSync } from "child_process";

// Guarded process helpers shared by wdio.qa.conf.ts and the #237 acceptance runner, so there
// is exactly ONE implementation of "only ever kill PIDs we spawned" (moved out of the config
// unchanged; sweepOrphanWebviews now takes the QA root as an argument).

/** PID -> process image name (lowercase), or "" if the PID is gone. Used to guard every kill
 *  against PID reuse -- a recycled PID must never be terminated as if it were ours. */
export function imageName(pid: number): string {
  try {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1].toLowerCase() : "";
  } catch { return ""; }
}

/** Kill one PID and its child tree, but ONLY if its image name is one we expect to have spawned. */
export function killGuarded(pid: number, expected: string[]): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const img = imageName(pid);
  if (!img) return; // already gone
  if (!expected.includes(img)) {
    console.warn(`[qa] refusing to kill PID ${pid} -- image "${img}" is not one of ${expected.join("/")} (PID reuse guard)`);
    return;
  }
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
}

/** Kill msedgewebview2.exe processes whose command line contains the QA root -- these are
 *  orphaned WebView2 children `taskkill /T` misses when the Tauri parent dies first (#170 F5). */
export function sweepOrphanWebviews(qaRoot: string): void {
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${qaRoot.replace(/'/g, "''")}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: "pipe" });
  } catch {}
}
