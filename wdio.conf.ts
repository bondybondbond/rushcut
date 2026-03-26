import { ChildProcess, spawn } from "child_process";
import path from "path";
import fs from "fs";
import http from "http";

let appProcess: ChildProcess;
let msEdge: ChildProcess;
let viteServer: ChildProcess;

// Prefer debug binary (loads from Vite dev server — always reflects latest source).
// Fall back to release binary only if debug binary doesn't exist.
const releasePath = path.resolve(__dirname, "src-tauri", "target", "release", "rushcut.exe");
const debugPath   = path.resolve(__dirname, "src-tauri", "target", "debug",   "rushcut.exe");
const APP_PATH    = fs.existsSync(debugPath) ? debugPath : releasePath;
const usingDebug  = APP_PATH === debugPath;

const CDP_PORT    = 9222;  // WebView2 remote debug port
const DRIVER_PORT = 9515;  // msedgedriver port

function waitForPort(port: number, timeoutMs = 20000): Promise<void> {
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
      // BiDi protocol reports stale about:blank for WebView2 attach mode.
      // Force classic WebDriver to get correct URL and DOM access.
      "wdio:enforceWebDriverClassic": true,
    },
  ],

  framework: "mocha",
  mochaOpts: {
    timeout: 300_000,
  },

  reporters: ["spec"],

  specs: ["./e2e/**/*.spec.ts"],

  beforeSession: async () => {
    // Kill any stale processes from previous runs (including WebView2 subprocess on port 9222)
    spawn("taskkill", ["/F", "/IM", "rushcut.exe"], { stdio: "pipe" });
    spawn("taskkill", ["/F", "/IM", "msedgedriver.exe"], { stdio: "pipe" });
    // Kill whatever process is holding the CDP port (usually a WebView2 leftover)
    spawn("powershell.exe", [
      "-Command",
      `$p = Get-NetTCPConnection -LocalPort ${CDP_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: "pipe" });
    await new Promise<void>((r) => setTimeout(r, 2000));

    // Start Vite dev server if using debug binary and 1420 is not live
    if (usingDebug) {
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
        // Wait for Vite "ready" signal or up to 10s
        await new Promise<void>((resolve) => {
          viteServer.stdout?.on("data", (d: Buffer) => {
            if (d.toString().includes("ready in") || d.toString().includes("Local:")) resolve();
          });
          setTimeout(resolve, 10_000);
        });
      }
    }

    // Launch the Tauri binary with WebView2 remote debugging enabled.
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is read by the WebView2 host process
    // and causes it to open a CDP debug endpoint on CDP_PORT.
    appProcess = spawn(APP_PATH, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      },
      stdio: "pipe",
    });

    // Wait for the WebView2 CDP endpoint to become available
    await waitForPort(CDP_PORT, 20000);

    // Wait for the app to navigate away from the initial blank page
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 20_000;
      function checkTargets() {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, (res) => {
          let body = "";
          res.on("data", (d: Buffer) => { body += d.toString(); });
          res.on("end", () => {
            try {
              const targets = JSON.parse(body) as Array<{ url: string }>;
              const loaded = targets.some((t) => t.url !== "about:blank" && t.url !== "");
              if (loaded) { resolve(); return; }
            } catch {}
            if (Date.now() > deadline) { resolve(); return; }
            setTimeout(checkTargets, 300);
          });
        });
        req.on("error", () => {
          if (Date.now() > deadline) { resolve(); return; }
          setTimeout(checkTargets, 300);
        });
        req.setTimeout(2000, () => { req.destroy(); setTimeout(checkTargets, 300); });
      }
      checkTargets();
    });

    // Extra wait: attaching msedgedriver while the page is navigating resets it to about:blank.
    // Wait for the navigation to fully complete (React Router redirect + render).
    await new Promise<void>((r) => setTimeout(r, 6000));

    // Start msedgedriver as the WebDriver intermediary
    msEdge = spawn(
      "C:\\Users\\Manasak\\.cargo\\bin\\msedgedriver.exe",
      [`--port=${DRIVER_PORT}`],
      { stdio: "pipe", shell: false }
    );
    // Give msedgedriver time to start
    await new Promise<void>((r) => setTimeout(r, 3000));
  },

  afterSession: async () => {
    if (msEdge)     msEdge.kill("SIGTERM");
    if (appProcess) appProcess.kill("SIGTERM");
    if (viteServer) viteServer.kill("SIGTERM");
  },
};
