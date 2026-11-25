/**
 * run-acceptance.ts (#237) -- ONE command for the mechanical acceptance run.
 *
 *   pnpm accept -- --clips <folder> [--res 4k|1080p] [--out <dir>] [--break stale-proxy]
 *                  [--cuts 20] [--sources 6] [--short 3:2000,6:900] [--keep]
 *
 * --clips   folder of raw footage (read-only; only stream-copy excerpts are ever written).
 *           Also taken from RC_ACCEPT_CLIPS. Never committed anywhere.
 * --res     4k (default) or 1080p.
 * --out     where report.md / report.json / the film go. Default %TEMP%\rcqa\<runid>.
 * --break   stale-proxy: strip the version tag from one finished proxy (the real negative control).
 *           The run must exit non-zero with the 'Proxy version and height' row FAILed.
 *           (A deleted proxy is not a valid control: the app regenerates it before rendering.)
 * --short   position:milliseconds pairs: cut number `position` (0-based film order) is that long instead
 *           of 4500 ms (#284: short clips on the render's batch boundaries are positions 3, 6, 9, ...).
 * --keep    leave the QA root (DB, proxies, logs, excerpts) for a post-mortem.
 *
 * Exit code: 0 PASS or WARN, 1 on any FAIL, a run error, or a missing verdict. No retries.
 * Run from PowerShell, with cwd = the repo root. Never while a real render is in progress.
 */
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { killGuarded, sweepOrphanWebviews } from "./helpers/qaProcess";
import { redact } from "./helpers/acceptanceChecks";

const REPO = path.resolve(__dirname, "..");
const LOCK = path.join(REPO, "e2e", ".qa-lock.json");
const HARD_LIMIT_MS = 55 * 60_000;      // above the spec's mocha timeout (50 min), which is above its phase deadlines (44 min)

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "1") : undefined;
}
function fail(msg: string): never { console.error(`[accept] ${msg}`); process.exit(2); }
const wsl = (args: string[]) => spawnSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", ...args], { encoding: "utf8" });

const clips = arg("clips") ?? process.env.RC_ACCEPT_CLIPS ?? "";
const res = (arg("res") ?? "4k").toLowerCase();
const brk = arg("break") ?? "";
const keep = arg("keep") !== undefined;
if (!clips || !fs.existsSync(clips) || !fs.statSync(clips).isDirectory()) fail("--clips <folder> is required and must exist");
if (!["4k", "1080p"].includes(res)) fail("--res must be 4k or 1080p");
if (brk && brk !== "stale-proxy") fail("--break only supports stale-proxy");

const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const qaRoot = path.join("C:\\", "rcqa", runId);                       // SHORT: a long TEMP breaks GetTempPath and /mnt/c paths
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "rcqa", runId));

// ---- preflight (recorded in the console and the report header; read-only) --------------------
// Parse in Node: quotes inside a wsl.exe argument list get mangled (awk '$7' arrives broken).
const memLine = (wsl(["free", "-m"]).stdout ?? "").split("\n").find((l) => l.startsWith("Mem:")) ?? "";
const mem = Number(memLine.trim().split(/\s+/)[6]);
if (!Number.isFinite(mem) || mem < 4096) fail(`WSL available memory ${mem} MB < 4096 MB: not starting (a render would be unreliable)`);
let freeGb = 0;
try { const s = fs.statfsSync("C:\\"); freeGb = (s.bavail * s.bsize) / 1024 ** 3; } catch { /* unknown */ }
if (freeGb < 10) fail(`C: has ${freeGb.toFixed(1)} GB free < 10 GB: not starting`);
const realLog = path.join(os.tmpdir(), "rushcut", "pipeline-latest.log");
try {
  const age = Date.now() - fs.statSync(realLog).mtimeMs;
  if (age < 90_000) fail("the real app's pipeline log changed in the last 90 s: a real render may be running. Not starting.");
} catch { /* no real log: idle */ }
fs.mkdirSync(out, { recursive: true });
// A reused --out folder must never leak a PREVIOUS run's verdict or report into this run
// (a verdict from run 1 would be read as run 2's, including its cache-ownership proof).
for (const stale of ["verdict.json", "report.md", "report.json"]) fs.rmSync(path.join(out, stale), { force: true });
console.log(`[accept] run ${runId}: res=${res} break=${brk || "none"} WSL free=${mem} MB C: free=${freeGb.toFixed(0)} GB`);
console.log(`[accept] QA root ${qaRoot}`);
console.log(`[accept] output ${out}`);

const env = {
  ...process.env,
  QA_ISOLATE_RENDER: "1",
  RC_QA_ROOT: qaRoot,
  RC_QA_KEEP: keep ? "1" : "",
  RC_ACCEPT_CLIPS: clips,
  RC_ACCEPT_RES: res,
  RC_ACCEPT_OUT: out,
  RC_ACCEPT_BREAK: brk,
  RC_ACCEPT_CUTS: arg("cuts") ?? "20",
  RC_ACCEPT_SOURCES: arg("sources") ?? "6",
  RC_ACCEPT_SHORT: arg("short") ?? "",
  RC_ACCEPT_RUNID: runId,
  RC_ACCEPT_KEEP: keep ? "1" : "",
};

const logFd = fs.openSync(path.join(out, "wdio.log"), "w");
const child = spawn("pnpm", ["exec", "wdio", "run", "wdio.qa.conf.ts", "--spec", "e2e/qa-isolation.spec.ts", "--spec", "e2e/qa-acceptance.spec.ts"],
  { cwd: REPO, env, shell: true, stdio: ["ignore", logFd, logFd] });

/** wdio.log is raw tool output: redact it like the report so it can be pasted safely (every exit path). */
function redactWdioLog() {
  try {
    const wl = path.join(out, "wdio.log");
    // Also hide every filename in the footage folder: the existing isolation spec scans it and WDIO echoes the result.
    let names: string[] = [];
    try { names = fs.readdirSync(clips).filter((n) => n.length >= 4); } catch { /* none */ }
    fs.writeFileSync(wl, redact(fs.readFileSync(wl, "utf8"), qaRoot, [clips, ...names]));
  } catch { /* leave as is */ }
}

let timedOut = false;
const watchdog = setTimeout(() => {
  timedOut = true;
  console.error("[accept] watchdog: hard time limit reached, killing only the processes this run spawned");
  let lock: { appPid?: number; driverPid?: number; qaRoot?: string } = {};
  try { lock = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { /* none */ }
  // The lockfile is shared: only trust PIDs recorded by THIS run (an old crashed run's PID may have been reused).
  if (!lock.qaRoot || path.resolve(lock.qaRoot).toLowerCase() !== qaRoot.toLowerCase()) lock = {};
  if (lock.appPid) killGuarded(lock.appPid, ["rushcut.exe"]);
  if (lock.driverPid) killGuarded(lock.driverPid, ["msedgedriver.exe"]);
  if (child.pid) killGuarded(child.pid, ["cmd.exe", "node.exe", "pnpm.exe"]);
  sweepOrphanWebviews(qaRoot);
  // Pipeline processes inside WSL outlive the Windows tree: match ONLY this run's QA root.
  wsl(["pkill", "-f", `/mnt/c/rcqa/${runId}/`]);
  // If the kills did not make wdio exit, do not wait forever.
  setTimeout(() => { console.error("[accept] FAIL: the run did not exit after the watchdog kill"); redactWdioLog(); process.exit(1); }, 90_000);
}, HARD_LIMIT_MS);

child.on("exit", (code) => {
  clearTimeout(watchdog);
  let verdict: { status?: string; exitCode?: number; cacheOwnership?: { ok: boolean; file: string; reason: string } } | null = null;
  try { verdict = JSON.parse(fs.readFileSync(path.join(out, "verdict.json"), "utf8")); } catch { /* none */ }

  // Render-cache cleanup: ONLY a file the spec proved this run created (see the spec's ownership rule).
  let cacheNote = "no render-cache entry to remove";
  const own = verdict?.cacheOwnership;
  if (own?.ok && /^[0-9a-f]{8,32}\.mp4$/.test(own.file)) {
    const r = wsl(["rm", "-f", `/tmp/rushcut-render-cache/${own.file}`]);
    cacheNote = r.status === 0 ? `removed this run's own cache entry ${own.file}` : `cache removal failed (exit ${r.status})`;
  } else if (own) {
    cacheNote = `cache entry left untouched: ${own.reason}`;
  }

  redactWdioLog();

  let code2 = 1;
  if (!verdict) {
    fs.writeFileSync(path.join(out, "report.md"), `# RushCut acceptance run: FAIL\n\nNo verdict was written${timedOut ? " (hard time limit hit)" : ""}. See wdio.log in this folder.\n`);
    console.error("[accept] FAIL: no verdict was produced");
  } else {
    code2 = Math.max(verdict.exitCode ?? 1, code ? 1 : 0);
    console.log(`[accept] ${verdict.status}  (report: ${path.join(out, "report.md")})`);
  }
  console.log(`[accept] ${cacheNote}`);
  const qaGone = !fs.existsSync(qaRoot);
  console.log(keep ? `[accept] --keep: QA root left at ${qaRoot}` : qaGone ? "[accept] QA root removed" : `[accept] WARNING: QA root still present: ${qaRoot}`);
  try { fs.rmdirSync(path.join("C:\\", "rcqa")); } catch { /* not empty or absent: fine */ }
  process.exit(code2);
});
