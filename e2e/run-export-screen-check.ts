/**
 * run-export-screen-check.ts (#267) -- ONE command for the export-screen check (phase bar, reattach, screenshots).
 *
 *   pnpm export-screen-check -- --clips <folder> [--out <dir>] [--cuts 12] [--keep]
 *
 * Runs e2e/qa-export-screen.spec.ts in the isolated QA instance (own DB, profile, ports; APPDATA/TMP/TEMP
 * under C:\rcqa\<runid>). It presses the real Cancel render button, reads and presses the real
 * native dialog buttons with Windows UI Automation, and checks the cancel lifecycle.
 * Writes export-screen-evidence.json and screenshots into --out (default %TEMP%\rcqa\<runid>).
 * Exit code 0 only when the spec passed. Run from PowerShell, cwd = repo root, never while a real
 * render is running. Same isolation, preflight and watchdog rules as run-acceptance.ts.
 */
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { killGuarded, sweepOrphanWebviews } from "./helpers/qaProcess";

const REPO = path.resolve(__dirname, "..");
const LOCK = path.join(REPO, "e2e", ".qa-lock.json");
const HARD_LIMIT_MS = 40 * 60_000;

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "1") : undefined;
}
function fail(msg: string): never { console.error(`[export-screen-check] ${msg}`); process.exit(2); }
const wsl = (args: string[]) => spawnSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", ...args], { encoding: "utf8" });

const clips = arg("clips") ?? process.env.RC_ES_CLIPS ?? "";
const keep = arg("keep") !== undefined;
if (!clips || !fs.existsSync(clips) || !fs.statSync(clips).isDirectory()) fail("--clips <folder> is required and must exist");

const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const qaRoot = path.join("C:\\", "rcqa", runId);
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "rcqa", runId));

// ---- preflight (read-only) ---------------------------------------------------------------------
const memLine = (wsl(["free", "-m"]).stdout ?? "").split("\n").find((l) => l.startsWith("Mem:")) ?? "";
const mem = Number(memLine.trim().split(/\s+/)[6]);
if (!Number.isFinite(mem) || mem < 4096) fail(`WSL available memory ${mem} MB < 4096 MB: not starting`);
let freeGb = 0;
try { const s = fs.statfsSync("C:\\"); freeGb = (s.bavail * s.bsize) / 1024 ** 3; } catch { /* unknown */ }
if (freeGb < 10) fail(`C: has ${freeGb.toFixed(1)} GB free < 10 GB: not starting`);
try {
  const age = Date.now() - fs.statSync(path.join(os.tmpdir(), "rushcut", "pipeline-latest.log")).mtimeMs;
  if (age < 90_000) fail("the real app's pipeline log changed in the last 90 s: a real render may be running. Not starting.");
} catch { /* no real log: idle */ }
fs.mkdirSync(out, { recursive: true });
console.log(`[export-screen-check] run ${runId}: WSL free=${mem} MB C: free=${freeGb.toFixed(0)} GB; QA root ${qaRoot}; output ${out}`);

const env = {
  ...process.env,
  QA_ISOLATE_RENDER: "1",
  RC_QA_ROOT: qaRoot,
  RC_QA_KEEP: keep ? "1" : "",
  RC_ES_CLIPS: clips,
  RC_ES_OUT: out,
  RC_ES_RUNID: runId,
  RC_ES_CUTS: arg("cuts") ?? "12",
};
const logFd = fs.openSync(path.join(out, "wdio.log"), "w");
const child = spawn("pnpm", ["exec", "wdio", "run", "wdio.qa.conf.ts", "--spec", "e2e/qa-isolation.spec.ts", "--spec", "e2e/qa-export-screen.spec.ts"],
  { cwd: REPO, env, shell: true, stdio: ["ignore", logFd, logFd] });

const watchdog = setTimeout(() => {
  console.error("[export-screen-check] watchdog: hard time limit reached, killing only the processes this run spawned");
  let lock: { appPid?: number; driverPid?: number; qaRoot?: string } = {};
  try { lock = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { /* none */ }
  if (!lock.qaRoot || path.resolve(lock.qaRoot).toLowerCase() !== qaRoot.toLowerCase()) lock = {};
  if (lock.appPid) killGuarded(lock.appPid, ["rushcut.exe"]);
  if (lock.driverPid) killGuarded(lock.driverPid, ["msedgedriver.exe"]);
  if (child.pid) killGuarded(child.pid, ["cmd.exe", "node.exe", "pnpm.exe"]);
  sweepOrphanWebviews(qaRoot);
  wsl(["pkill", "-f", `/mnt/c/rcqa/${runId}/`]);
  setTimeout(() => process.exit(1), 90_000);
}, HARD_LIMIT_MS);

child.on("exit", (code) => {
  clearTimeout(watchdog);
  console.log(`[export-screen-check] ${code === 0 ? "PASS" : "FAIL"} (wdio exit ${code}); evidence in ${out}`);
  console.log(fs.existsSync(path.join(out, "cache-note.txt")) ? `[export-screen-check] ${fs.readFileSync(path.join(out, "cache-note.txt"), "utf8").trim()}` : "[export-screen-check] no cache note written");
  console.log(keep ? `[export-screen-check] --keep: QA root left at ${qaRoot}` : fs.existsSync(qaRoot) ? `[export-screen-check] WARNING: QA root still present: ${qaRoot}` : "[export-screen-check] QA root removed");
  try { fs.rmdirSync(path.join("C:\\", "rcqa")); } catch { /* not empty or absent: fine */ }
  process.exit(code === 0 ? 0 : 1);
});
