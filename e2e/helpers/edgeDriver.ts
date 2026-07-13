import { spawnSync } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

// Auto-resolve/download a matching msedgedriver at runtime instead of hand-pinning one binary
// that goes stale the moment WebView2 auto-updates (#97 follow-on). Compares only the first
// 3 version components (major.minor.build) -- the 4th (patch) drifts constantly and driver/
// browser compatibility doesn't require an exact patch match, per Microsoft's own WebDriver
// version-matching guidance.

const DRIVER_PATH = path.join(process.env.USERPROFILE || "", ".cargo", "bin", "msedgedriver.exe");

function getPinnedDriverVersion(): string | null {
  try {
    const out = spawnSync(DRIVER_PATH, ["--version"], { encoding: "utf8" }).stdout ?? "";
    const m = out.match(/([\d]+\.[\d]+\.[\d]+\.[\d]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function getRunningBrowserVersion(cdpPort: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => { body += d.toString(); });
      res.on("end", () => {
        try {
          const json = JSON.parse(body) as { Browser?: string };
          const m = (json.Browser ?? "").match(/([\d]+\.[\d]+\.[\d]+\.[\d]+)$/);
          resolve(m ? m[1] : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

function sameCompatVersion(a: string, b: string): boolean {
  return a.split(".").slice(0, 3).join(".") === b.split(".").slice(0, 3).join(".");
}

/**
 * Downloads and installs a matching msedgedriver if the pinned one doesn't compatibility-match
 * the live WebView2 build. Requires the CDP port to already be up (call after waitForPort).
 * Safe no-op if version detection fails either side -- falls through so the real session
 * attempt surfaces whatever the actual error is, rather than masking it here.
 */
export async function ensureMatchingEdgeDriver(cdpPort: number): Promise<void> {
  const browserVersion = await getRunningBrowserVersion(cdpPort);
  if (!browserVersion) return;

  const driverVersion = getPinnedDriverVersion();
  if (driverVersion && sameCompatVersion(driverVersion, browserVersion)) return;

  console.log(`[edgedriver] mismatch: driver=${driverVersion ?? "none"} browser=${browserVersion} -- downloading matching msedgedriver`);

  // NOTE: msedgedriver.azureedge.net (the old CDN) was fully decommissioned -- confirmed via
  // DNS failure ("name does not exist") 2026-07-13. msedgedriver.microsoft.com is the current host.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edgedriver-"));
  const zipPath = path.join(tmpDir, "edgedriver.zip");

  let res = await fetch(`https://msedgedriver.microsoft.com/${browserVersion}/edgedriver_win64.zip`);
  if (!res.ok) {
    // WebView2 Runtime (Evergreen) and stable-channel Edge browser releases don't always share
    // an exact driver build even on the same major version (confirmed live: browser build
    // 150.0.7871.101 has no published driver, while LATEST_RELEASE_150 pointed at 150.0.4078.65
    // -- a same-major, very different patch/build). Fall back to that major version's latest
    // published driver rather than failing outright.
    const major = browserVersion.split(".")[0];
    const pointerRes = await fetch(`https://msedgedriver.microsoft.com/LATEST_RELEASE_${major}`);
    if (!pointerRes.ok) {
      throw new Error(`[edgedriver] no driver for ${browserVersion} and LATEST_RELEASE_${major} lookup failed (${pointerRes.status})`);
    }
    // LATEST_RELEASE_* files are served as UTF-16LE with a BOM -- decode explicitly rather
    // than relying on fetch's default UTF-8 text() (which would garble every other byte).
    const buf = Buffer.from(await pointerRes.arrayBuffer());
    const hasUtf16Bom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const fallbackVersion = (hasUtf16Bom ? buf.toString("utf16le", 2) : buf.toString("utf8")).trim();
    console.log(`[edgedriver] no exact driver for ${browserVersion} -- falling back to major-version latest ${fallbackVersion}`);
    res = await fetch(`https://msedgedriver.microsoft.com/${fallbackVersion}/edgedriver_win64.zip`);
    if (!res.ok) {
      throw new Error(`[edgedriver] fallback download failed (${res.status}): version ${fallbackVersion}`);
    }
  }
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  const extractDir = path.join(tmpDir, "extracted");
  const ps = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${extractDir}" -Force`,
  ]);
  if (ps.status !== 0) {
    throw new Error(`[edgedriver] extract failed: ${ps.stderr?.toString() ?? ps.status}`);
  }

  const newDriver = path.join(extractDir, "msedgedriver.exe");
  if (!fs.existsSync(newDriver)) {
    throw new Error(`[edgedriver] extracted zip did not contain msedgedriver.exe`);
  }

  fs.mkdirSync(path.dirname(DRIVER_PATH), { recursive: true });
  fs.copyFileSync(newDriver, DRIVER_PATH);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Confirm the driver we just installed actually compatibility-matches the live browser --
  // it might not (e.g. WebView2 Evergreen ships a build with no published driver at all yet,
  // confirmed live on 2026-07-13: browser 150.0.7871.101 vs every available driver build).
  // Print a clear, human-readable message NOW instead of letting a cryptic "unrecognized
  // Microsoft Edge version" surface deep inside WebDriver session-creation retries.
  const installedVersion = getPinnedDriverVersion();
  if (installedVersion && sameCompatVersion(installedVersion, browserVersion)) {
    console.log(`[edgedriver] updated to ${installedVersion} at ${DRIVER_PATH} -- matches live browser ${browserVersion}`);
  } else {
    console.warn(
      `[edgedriver] WARNING: installed driver ${installedVersion ?? "unknown"} does NOT compatibility-match ` +
      `the live browser build ${browserVersion}. This is a known upstream gap, not a bug in this script -- ` +
      `Microsoft's driver catalog hasn't published a build for ${browserVersion} yet (or the WebView2 ` +
      `runtime this app loaded isn't the one reported by the system's registry/install location -- see ` +
      `docs/LEARNINGS.md "msedgedriver.azureedge.net CDN fully decommissioned..." for the full 2026-07-13 ` +
      `investigation). The WDIO session below will likely fail with "unrecognized Microsoft Edge version" -- ` +
      `that failure is expected right now, not a new regression.`
    );
  }
}
