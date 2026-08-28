import { ChildProcess, spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import { trackedTestProjects, clearTrackedTestProjects } from "./e2e/helpers/testProjects";
import { ensureMatchingEdgeDriver } from "./e2e/helpers/edgeDriver";

// ---------------------------------------------------------------------------
// wdio.qa.conf.ts (#170) -- ISOLATED QA E2E instance.
//
// The point: Claude can run the smoke suite even while claude-in-chrome / a live
// rushcut.exe hold CDP :9222, and a QA run can NEVER kill the user's app or Chrome.
//
// Isolation vs. wdio.conf.ts (which uses :9222 / :9515 and `taskkill /IM rushcut.exe`):
//   - CDP debug port 9223 (not 9222)         -- own remote-debugging endpoint
//   - msedgedriver port 9516 (not 9515)      -- own driver, never collides
//   - WEBVIEW2_USER_DATA_FOLDER = <qa>/profile -- own WebView2 session (a `--user-data-dir`
//       browser arg is silently ignored by WebView2; the env var is the supported lever)
//   - RUSHCUT_DATA_DIR = <qa>/data           -- own SQLite DB (db::db_path() override)
//   - PID-scoped teardown via e2e/.qa-lock.json -- only ever kills PIDs THIS config spawned,
//       plus orphaned msedgewebview2 children whose command line contains the QA data dir.
//       Never `taskkill /IM`. Never touches :9222 / :9515 / :9517 or any non-QA PID.
//
// DB-only isolation caveat: %APPDATA%\rushcut\proxies and %TEMP%\rushcut\ render-path state
// are still shared. fast.spec.ts / arrange.spec.ts trigger no render, and proxies are
// path-hash keyed (shared safely). Render-path isolation is a deferred follow-up.
// ---------------------------------------------------------------------------

let appProcess: ChildProcess;
let msEdge: ChildProcess;
let viteServer: ChildProcess;

const releasePath = path.resolve(__dirname, "src-tauri", "target", "release", "rushcut.exe");
const debugPath   = path.resolve(__dirname, "src-tauri", "target", "debug",   "rushcut.exe");
const APP_PATH    = fs.existsSync(debugPath) ? debugPath : releasePath;
const usingDebug  = APP_PATH === debugPath;

const CDP_PORT    = 9223;  // QA WebView2 remote debug port  (main config: 9222)
const DRIVER_PORT = 9516;  // QA msedgedriver port           (main config: 9515, attach: 9517)

const QA_ROOT       = path.join(os.tmpdir(), "rushcut", "qa-e2e");
const QA_DATA_DIR   = path.join(QA_ROOT, "data");     // RUSHCUT_DATA_DIR -> <this>/rushcut.db
const QA_PROFILE_DIR = path.join(QA_ROOT, "profile"); // WEBVIEW2_USER_DATA_FOLDER
const LOCK_PATH     = path.resolve(__dirname, "e2e", ".qa-lock.json");

// The real user profile's WebView2 folder. Used only when NO other rushcut.exe is running
// (a concurrently-running user instance legitimately touches its own profile, making a
// dir-mtime check meaningless -- see qa-isolation.spec.ts).
const USER_WEBVIEW_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "com.rushcut.app",
  "EBWebView",
);
let userWebviewMtimeBefore = "";
let qaWebviewCmdline = "";     // the actual command line of the QA instance's WebView2 child
let foreignRushcutCount = 0;   // other rushcut.exe processes alive alongside the QA one

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Port ${port} not available after ${timeoutMs}ms`));
        else setTimeout(attempt, 300);
      });
      req.setTimeout(1500, () => { req.destroy(); });
    }
    attempt();
  });
}

async function ensureViteRunning(): Promise<void> {
  const port1420Live = await new Promise<boolean>((resolve) => {
    const req = http.get("http://localhost:1420", () => { req.destroy(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
  if (!port1420Live) {
    viteServer = spawn("pnpm", ["exec", "vite"], { cwd: __dirname, stdio: "pipe", shell: true });
    await new Promise<void>((resolve) => {
      viteServer.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("ready in") || d.toString().includes("Local:")) resolve();
      });
      setTimeout(resolve, 10_000);
    });
  }
}

async function waitForAppRoute(timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
        let body = "";
        res.on("data", (d: Buffer) => { body += d.toString(); });
        res.on("end", () => {
          try {
            const targets = JSON.parse(body) as Array<{ url: string }>;
            const ready = targets.some((t) =>
              t.url.includes("/upload") || t.url.includes("/library") ||
              t.url.includes("/trimmer/") || t.url.includes("/arrange/") ||
              t.url.includes("/sound/") || t.url.includes("/render/"));
            if (ready) { resolve(); return; }
          } catch {}
          if (Date.now() > deadline) { resolve(); return; }
          setTimeout(check, 500);
        });
      });
      req.on("error", () => {
        if (Date.now() > deadline) { resolve(); return; }
        setTimeout(check, 500);
      });
      req.setTimeout(2000, () => { req.destroy(); setTimeout(check, 500); });
    }
    check();
  });
}

/** PID -> process image name (lowercase), or "" if the PID is gone. Used to guard every kill
 *  against PID reuse -- a recycled PID must never be terminated as if it were ours. */
function imageName(pid: number): string {
  try {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8" }).stdout ?? "";
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1].toLowerCase() : "";
  } catch { return ""; }
}

/** PIDs currently LISTENING on `port`. Get-NetTCPConnection returns one IPv4 + one IPv6 row
 *  per listener (same PID -- deduped here), and can surface OwningProcess 0 / System PIDs for
 *  half-closed sockets; those are filtered out (`n > 4`) so they never trip the fail-closed
 *  ownership check below (#170 Round 2.5). */
function portOwners(port: number): number[] {
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
    ], { encoding: "utf8" }).stdout ?? "";
    return [...new Set(
      out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 4),
    )];
  } catch { return []; }
}

/** Kill one PID and its child tree, but ONLY if its image name is one we expect to have spawned. */
function killGuarded(pid: number, expected: string[]): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const img = imageName(pid);
  if (!img) return; // already gone
  if (!expected.includes(img)) {
    console.warn(`[qa] refusing to kill PID ${pid} -- image "${img}" is not one of ${expected.join("/")} (PID reuse guard)`);
    return;
  }
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
}

/** Kill msedgewebview2.exe processes whose command line contains the QA data dir -- these are
 *  orphaned WebView2 children `taskkill /T` misses when the Tauri parent dies first (#170 F5). */
function sweepOrphanWebviews(): void {
  try {
    const marker = QA_ROOT.replace(/\\/g, "\\\\");
    spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${QA_ROOT.replace(/'/g, "''")}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: "pipe" });
    void marker;
  } catch {}
}

/** Idempotent recover/validate boundary -- runs in onPrepare (global) AND defensively at
 *  beforeSession entry. Fails CLOSED: if a QA port is held by a PID we did NOT record, throw
 *  rather than kill it -- a port tells you what is listening, not whether it is ours (#170 F14/B). */
function acquireQaPortsOrThrow(): void {
  let lock: { appPid?: number; driverPid?: number } = {};
  try { lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); } catch {}
  const ourPids = new Set([lock.appPid, lock.driverPid].filter((n): n is number => Number.isInteger(n as number)));

  for (const port of [CDP_PORT, DRIVER_PORT]) {
    for (const pid of portOwners(port)) {
      const img = imageName(pid);
      if (!img) continue; // PID already gone (stale listener row) -- nothing to kill, don't throw
      if (ourPids.has(pid)) {
        killGuarded(pid, ["rushcut.exe", "msedgewebview2.exe", "msedgedriver.exe"]);
      } else {
        throw new Error(
          `[qa] QA port ${port} is held by PID ${pid} ("${img}") which is NOT a recorded QA PID ` +
          `(e2e/.qa-lock.json = ${JSON.stringify([...ourPids])}). Refusing to kill it. Free port ${port} manually, ` +
          `or delete e2e/.qa-lock.json if it is stale, then re-run.`,
        );
      }
    }
  }
  // Any still-recorded PIDs not tied to a port (crashed parent, orphan) -- guarded-kill + sweep.
  for (const pid of ourPids) killGuarded(pid, ["rushcut.exe", "msedgedriver.exe"]);
  sweepOrphanWebviews();
  try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
}

/** Command line of the QA instance's own WebView2 child (identified by --webview-exe-name plus
 *  the QA marker on the command line). This is a POSITIVE isolation proof: it shows the QA
 *  WebView2 bound the QA profile, and it stays valid even while the user's own rushcut.exe runs. */
function webviewCmdlineFor(marker: string): string {
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*--webview-exe-name=rushcut.exe*' -and $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | ` +
      `Select-Object -First 1 -ExpandProperty CommandLine`,
    ], { encoding: "utf8" }).stdout ?? "";
    return out.trim();
  } catch { return ""; }
}

/** Count of rushcut.exe processes OTHER than ours -- i.e. is the user's app running concurrently. */
function countOtherRushcut(ourPid: number | undefined): number {
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command",
      `@(Get-Process rushcut -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${ourPid ?? 0} }).Count`,
    ], { encoding: "utf8" }).stdout ?? "";
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

function dirMtime(p: string): string {
  try { return fs.statSync(p).mtime.toISOString(); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// WebdriverIO config
// ---------------------------------------------------------------------------

export const config: WebdriverIO.Config = {
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  path: "/",
  maxInstances: 1,

  capabilities: [
    {
      browserName: "msedge",
      "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${CDP_PORT}` },
      webSocketUrl: false,
      "wdio:enforceWebDriverClassic": true,
      timeouts: { script: 90000 },
    },
  ],

  framework: "mocha",
  // failZero: a run where zero specs/tests executed is a FAILURE, not a silent pass (#170 F10).
  mochaOpts: { timeout: 600_000, failZero: true },

  reporters: ["spec"],

  // qa-isolation.spec.ts must run FIRST -- it hard-asserts isolation before any real spec.
  // (WDIO runs specs in listed order at maxInstances:1.) A --spec override from package.json
  // should always keep qa-isolation.spec.ts as the first entry.
  specs: ["./e2e/qa-isolation.spec.ts", "./e2e/fast.spec.ts"],

  // --- Global acquire / recover / validate boundary (#170 F7: onPrepare, not beforeSession) ---
  onPrepare: () => {
    fs.mkdirSync(QA_DATA_DIR, { recursive: true });
    fs.mkdirSync(QA_PROFILE_DIR, { recursive: true });
    acquireQaPortsOrThrow();
  },

  beforeSession: async () => {
    acquireQaPortsOrThrow(); // defensive re-run at session entry
    if (usingDebug) await ensureViteRunning();

    userWebviewMtimeBefore = dirMtime(USER_WEBVIEW_DIR);

    appProcess = spawn(APP_PATH, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: QA_PROFILE_DIR,
        RUSHCUT_DATA_DIR: QA_DATA_DIR,
      },
      stdio: "pipe",
    });

    fs.writeFileSync(LOCK_PATH, JSON.stringify({
      appPid: appProcess.pid,
      driverPid: null,
      qaRoot: QA_ROOT,
      startedAt: new Date().toISOString(),
    }, null, 2));

    await waitForPort(CDP_PORT, 30_000);
    await waitForAppRoute(30_000);
    await new Promise<void>((r) => setTimeout(r, 2000));

    // Positive isolation facts, captured while everything is live.
    qaWebviewCmdline = webviewCmdlineFor(QA_PROFILE_DIR);
    foreignRushcutCount = countOtherRushcut(appProcess.pid);

    await ensureMatchingEdgeDriver(CDP_PORT);

    msEdge = spawn(
      `${process.env.USERPROFILE}\\.cargo\\bin\\msedgedriver.exe`,
      [`--port=${DRIVER_PORT}`, "--disable-bidi"],
      { stdio: "pipe", shell: false },
    );
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      lock.driverPid = msEdge.pid;
      fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
    } catch {}
    await new Promise<void>((r) => setTimeout(r, 3000));
  },

  // Expose isolation facts to qa-isolation.spec.ts via env (spec runs in the WDIO worker).
  before: async () => {
    process.env.QA_DATA_DIR = QA_DATA_DIR;
    process.env.QA_PROFILE_DIR = QA_PROFILE_DIR;
    process.env.QA_CDP_PORT = String(CDP_PORT);
    process.env.QA_USER_WEBVIEW_DIR = USER_WEBVIEW_DIR;
    process.env.QA_USER_WEBVIEW_MTIME_BEFORE = userWebviewMtimeBefore;
    process.env.QA_WEBVIEW_CMDLINE = qaWebviewCmdline;
    process.env.QA_FOREIGN_RUSHCUT = String(foreignRushcutCount);

    // Select whichever window handle is already on a known route.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const handles = await browser.getWindowHandles();
        for (const handle of handles) {
          await browser.switchToWindow(handle);
          const url = await browser.getUrl();
          if (["/upload", "/library", "/trimmer", "/arrange", "/sound", "/render"].some((r) => url.includes(r))) return;
        }
      } catch {}
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  },

  after: async () => {
    for (const id of trackedTestProjects()) {
      try {
        await browser.execute(async (pid: string) => {
          await (window as any).__TAURI_INTERNALS__.invoke("reset_proxy_encoding_cmd", { projectId: pid });
        }, id);
      } catch {}
    }
    clearTrackedTestProjects();
  },

  afterTest: async (test, _ctx, result) => {
    if (result.error) {
      const dir = path.resolve(__dirname, "e2e", "screenshots");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safe = test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 80);
      try { await browser.saveScreenshot(path.join(dir, `qa-${safe}-FAIL.png`)); } catch {}
    }
  },

  // Teardown ORDER matters (#170 F13): kill the Tauri parent TREE first (Node's SIGTERM only
  // hits the parent on Windows -- confirmed Round 2.5 -- so `taskkill /T /F` while it's still
  // alive is what actually reaches the msedgewebview2 children), WAIT for it all to exit, sweep
  // any orphan, THEN delete the temp UDF -- never delete a UDF still held open.
  afterSession: async () => {
    if (msEdge && msEdge.pid) killGuarded(msEdge.pid, ["msedgedriver.exe"]);

    if (appProcess && appProcess.pid) {
      const pid = appProcess.pid;
      killGuarded(pid, ["rushcut.exe"]);      // taskkill /T /F -- whole tree, parent still alive
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && imageName(pid)) {
        await new Promise<void>((r) => setTimeout(r, 250));
      }
      try { appProcess.kill("SIGKILL"); } catch {} // belt: reap the Node handle
    }
    sweepOrphanWebviews();
    await new Promise<void>((r) => setTimeout(r, 750)); // let file handles release

    if (viteServer) viteServer.kill("SIGTERM");

    try { fs.rmSync(QA_ROOT, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
  },
};
