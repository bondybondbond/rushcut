import { ChildProcess, spawn } from "child_process";
import http from "http";
import { ensureMatchingEdgeDriver } from "./e2e/helpers/edgeDriver";

// Read-only, no-kill variant of wdio.conf.ts (#97 follow-on). Attaches msedgedriver to
// whatever rushcut.exe is ALREADY running (real Tauri IPC via the same CDP debuggerAddress
// attach the main WDIO config uses) instead of killing + relaunching it. Never spawns or
// kills the app, never touches the DB/test projects. Exists so a session can self-verify a
// real-IPC-dependent UI state without disrupting the user's live app or asking them to look.
//
// Limitation: only reflects source changes Vite HMR already pushed (renderer/React). Rust
// changes still need the user to rebuild + relaunch the live binary first -- this mode
// can't build or relaunch anything, by design (that's the disruption it exists to avoid).
//
// Usage: pnpm test:e2e:attach (requires rushcut.exe already running with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222)

let msEdge: ChildProcess;

const CDP_PORT    = 9222;  // Same WebView2 remote debug port the main config uses
const DRIVER_PORT = 9517;  // Different from wdio.conf.ts's 9515 -- never collide if both are live

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(
            `No live rushcut.exe found on port ${port}. This mode only attaches to an ` +
            `already-running instance -- launch one first with:\n` +
            `  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=${port}"; ` +
            `Start-Process "src-tauri\\target\\debug\\rushcut.exe"`
          ));
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
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  path: "/",
  maxInstances: 1,

  capabilities: [
    {
      browserName: "msedge",
      "ms:edgeOptions": {
        debuggerAddress: `127.0.0.1:${CDP_PORT}`,
      },
      webSocketUrl: false,
      "wdio:enforceWebDriverClassic": true,
      timeouts: { script: 90000 },
    },
  ],

  framework: "mocha",
  mochaOpts: {
    timeout: 60_000,
  },

  reporters: ["spec"],

  specs: ["./e2e/readonly-check.spec.ts"],

  beforeSession: async () => {
    // Deliberately no killStaleProcesses(), no appProcess spawn, no ensureViteRunning() --
    // this mode observes whatever is already live. Fast-fail with a clear message if nothing is.
    await waitForPort(CDP_PORT, 5_000);
    await ensureMatchingEdgeDriver(CDP_PORT);

    msEdge = spawn(
      `${process.env.USERPROFILE}\\.cargo\\bin\\msedgedriver.exe`,
      [`--port=${DRIVER_PORT}`, "--disable-bidi"],
      { stdio: "pipe", shell: false }
    );
    await new Promise<void>((r) => setTimeout(r, 3000));
  },

  // No navigation here -- only selects whichever window handle is on a known route, so the
  // user's current screen is never moved away from what they're looking at.
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
            url.includes("/arrange") ||
            url.includes("/sound") ||
            url.includes("/render")
          ) {
            return;
          }
        }
      } catch {}
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  },

  // No test projects touched in this mode -- nothing to clean up.

  afterSession: async () => {
    // Only kill the driver process we spawned. Never touch appProcess (never spawned one)
    // or viteServer (never touched it) -- the user's live session is untouched throughout.
    if (msEdge) msEdge.kill("SIGTERM");
  },
};
