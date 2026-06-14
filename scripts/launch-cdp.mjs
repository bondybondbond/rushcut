// Launches rushcut.exe with CDP port 9222, waits for WebView2 to open
import { spawn } from "child_process";
import { createConnection } from "net";

const APP = "C:/apps/rushcut/src-tauri/target/debug/rushcut.exe";
const CDP_PORT = 9222;

const proc = spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "pipe",
  detached: true,
});

proc.stdout.on("data", (d) => process.stdout.write(d));
proc.stderr.on("data", (d) => process.stderr.write(d));

function waitForPort(port, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function attempt() {
      const sock = createConnection({ port }, () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        if (Date.now() > deadline) return reject(new Error(`Port ${port} not open after ${timeout}ms`));
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

await waitForPort(CDP_PORT, 90_000);
console.log(`CDP ready on port ${CDP_PORT}, PID ${proc.pid}`);
proc.unref();
