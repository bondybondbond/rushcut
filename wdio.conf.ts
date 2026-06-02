import { ChildProcess, spawn } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";
import { trackedTestProjects, clearTrackedTestProjects } from "./e2e/helpers/testProjects";

let appProcess: ChildProcess;
let msEdge: ChildProcess;
let viteServer: ChildProcess;

// Prefer debug binary (loads from Vite dev server -- always reflects latest source).
// Fall back to release binary only if debug binary doesn't exist.
const releasePath = path.resolve(__dirname, "src-tauri", "target", "release", "rushcut.exe");
const debugPath   = path.resolve(__dirname, "src-tauri", "target", "debug",   "rushcut.exe");
const APP_PATH    = fs.existsSync(debugPath) ? debugPath : releasePath;
const usingDebug  = APP_PATH === debugPath;

const CDP_PORT    = 9222;  // WebView2 remote debug port
const DRIVER_PORT = 9515;  // msedgedriver port

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
        if (Date.now() > deadline) {
          reject(new Error(`Port ${port} not available after ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
      req.setTimeout(1500, () => { req.destroy(); });
    }
    attempt();
  });
}

/** Kill stale rushcut, msedgedriver, and any process holding the CDP port. */
async function killStaleProcesses(): Promise<void> {
  spawn("taskkill", ["/F", "/IM", "rushcut.exe"], { stdio: "pipe" });
  spawn("taskkill", ["/F", "/IM", "msedgedriver.exe"], { stdio: "pipe" });
  spawn("powershell.exe", [
    "-Command",
    `$p = Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: "pipe" });
  await new Promise<void>((r) => setTimeout(r, 2000));
}

/** Start Vite dev server if port 1420 is not already live. */
async function ensureViteRunning(): Promise<void> {
  const port1420Live = await new Promise<boolean>((resolve) => {
    const req = http.get("http://localhost:1420", () => { req.destroy(); resolve(true); });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
  if (!port1420Live) {
    viteServer = spawn("pnpm", ["exec", "vite"], {
      cwd: __dirname,
      stdio: "pipe",
      shell: true,
    });
    await new Promise<void>((resolve) => {
      viteServer.stdout?.on("data", (d: Buffer) => {
        if (d.toString().includes("ready in") || d.toString().includes("Local:")) resolve();
      });
      setTimeout(resolve, 10_000);
    });
  }
}

/**
 * Poll CDP /json/list until a React Router route appears (/upload, /library, /editor/).
 * This is a stronger signal than "any non-blank URL" -- proves React has mounted.
 */
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
              t.url.includes("/upload") ||
              t.url.includes("/library") ||
              t.url.includes("/trimmer/") ||
              t.url.includes("/arrange/") ||
              t.url.includes("/sound/") ||
              t.url.includes("/render/")
            );
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

// ---------------------------------------------------------------------------
// WebdriverIO config
// ---------------------------------------------------------------------------

export const config: WebdriverIO.Config = {
  // Connect to msedgedriver (not directly to CDP port)
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  path: "/",
  maxInstances: 1,

  capabilities: [
    {
      browserName: "msedge",
      // Tell msedgedriver to attach to the already-running WebView2 instance.
      "ms:edgeOptions": {
        debuggerAddress: `127.0.0.1:${CDP_PORT}`,
      },
      // Layer 2: prevent WDIO from requesting BiDi during session negotiation.
      webSocketUrl: false,
      // Belt-and-suspenders: force classic WebDriver protocol.
      "wdio:enforceWebDriverClassic": true,
      // scan_folder + create_project call WSL2 synchronously -- can take >30s on cold start.
      timeouts: { script: 90000 },
    },
  ],

  framework: "mocha",
  mochaOpts: {
    timeout: 600_000,
  },

  reporters: ["spec"],

  specs: ["./e2e/**/*.spec.ts"],

  beforeSession: async () => {
    await killStaleProcesses();
    if (usingDebug) await ensureViteRunning();

    // Launch Tauri binary with WebView2 remote debugging enabled.
    appProcess = spawn(APP_PATH, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: "pipe",
    });

    // Wait for CDP endpoint, then for a real React Router route.
    await waitForPort(CDP_PORT, 30_000);
    await waitForAppRoute(30_000);

    // Brief pause for DOM hydration after CDP reports the route.
    await new Promise<void>((r) => setTimeout(r, 2000));

    // Layer 1: --disable-bidi prevents BiDi WebSocket negotiation entirely.
    // Without this, WDIO v9 + msedgedriver 146 negotiate BiDi and call
    // browsingContext.navigate, which hangs on Vite's HMR WebSocket.
    msEdge = spawn(
      "C:\\Users\\Manasak\\.cargo\\bin\\msedgedriver.exe",
      [`--port=${DRIVER_PORT}`, "--disable-bidi"],
      { stdio: "pipe", shell: false }
    );
    await new Promise<void>((r) => setTimeout(r, 3000));
  },

  // Batch A: second Tauri splash window removed. This guard is now a no-op (only one window
  // handle exists), but kept for safety in case msedgedriver still attaches to a stale handle.
  before: async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const handles = await browser.getWindowHandles();
        for (const handle of handles) {
          await browser.switchToWindow(handle);
          const url = await browser.getUrl();
          if (
            url.includes("/upload") ||
            url.includes("/library") ||
            url.includes("/trimmer") ||
            url.includes("/render")
          ) {
            return;
          }
        }
      } catch {}
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  },

  // Batch T7: before the binary is SIGTERM'd in afterSession, reset any stale 'encoding'
  // proxy claims for the test projects this spec touched. WDIO kills the binary mid-encode,
  // which otherwise leaves proxy_status='encoding' stuck in the SHARED DB. Scoped per
  // project_id (via reset_proxy_encoding_cmd) so the user's real projects are never touched.
  // Mirrors the specs' invoke access pattern exactly: window.__TAURI_INTERNALS__.invoke.
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
      const screenshotsDir = path.resolve(__dirname, "e2e", "screenshots");
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      const safeName = test.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 80);
      await browser.saveScreenshot(path.join(screenshotsDir, `${safeName}-FAIL.png`));
    }
  },

  afterSession: async () => {
    if (msEdge)     msEdge.kill("SIGTERM");
    if (appProcess) appProcess.kill("SIGTERM");
    if (viteServer) viteServer.kill("SIGTERM");
  },
};
