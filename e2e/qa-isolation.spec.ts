/**
 * qa-isolation.spec.ts (#170) -- the FIRST spec every `wdio.qa.conf.ts` run executes.
 *
 * Hard-asserts that WDIO attached to the ISOLATED QA instance, not the user's live app:
 *   - the QA SQLite DB is a fresh, near-empty DB (RUSHCUT_DATA_DIR took effect), NOT the
 *     user's populated %APPDATA%\rushcut\rushcut.db
 *   - the QA WebView2 user-data folder was created (WEBVIEW2_USER_DATA_FOLDER took effect)
 *   - the user's real com.rushcut.app\EBWebView folder was NOT modified during startup
 *   - the CDP target we're driving is on the QA port
 *
 * A config `before()` throw does not reliably abort a WDIO run (#170 F6), so these live in a
 * real spec: a failure here is a visible ❌, and (with mochaOpts.failZero) a run where this
 * spec did not execute is itself a failure.
 */

import fs from "fs";
import path from "path";
import { trackTestProject } from "./helpers/testProjects";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  browser.execute(
    (c, a) => (window as any).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args ?? {},
  ) as Promise<T>;

describe("#170 QA isolation preflight", () => {
  before(async () => {
    await browser.waitUntil(
      async () => {
        try {
          const url = await browser.getUrl();
          return ["/upload", "/library", "/trimmer", "/arrange", "/sound", "/render"].some((r) => url.includes(r));
        } catch { return false; }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" },
    );
  });

  it("RUSHCUT_DATA_DIR took effect: QA DB file exists under the QA data dir", () => {
    const qaDataDir = process.env.QA_DATA_DIR;
    expect(qaDataDir).toBeDefined();
    const dbFile = path.join(qaDataDir as string, "rushcut.db");
    expect(fs.existsSync(dbFile)).toBe(true);
  });

  it("attached to the ISOLATED DB, not the user's: project list is empty or the single seed only", async () => {
    // The QA DB starts empty. The config's before() has not seeded yet at this point in some
    // orderings, so accept 0; qa-seed below creates exactly one. The user's real DB has many.
    const projects = await invoke<Array<{ id: string; name: string }>>("list_projects_cmd");
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeLessThanOrEqual(1);
  });

  it("seeds exactly one project and it is the only one (proves an isolated empty DB)", async () => {
    const metas = await invoke<any[]>("scan_folder", { folderPath: "C:\\clips" });
    expect(Array.isArray(metas) && metas.length > 0).toBe(true);
    const clips = metas.slice(0, 2).map((m) => ({
      filename: m.filename, local_path: m.local_path, size_bytes: m.size_bytes,
      duration_ms: m.duration_ms, width: m.width, height: m.height,
      has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null,
    }));
    const projectId = await invoke<string>("create_project", { name: "QA Isolation Seed", clips });
    trackTestProject(projectId);

    const projects = await invoke<Array<{ id: string }>>("list_projects_cmd");
    expect(projects.length).toBe(1);
    expect(projects[0].id).toBe(projectId);
  });

  it("WEBVIEW2_USER_DATA_FOLDER took effect: the QA profile's EBWebView folder exists and is populated", () => {
    const qaProfileDir = process.env.QA_PROFILE_DIR as string;
    expect(qaProfileDir).toBeDefined();
    const ebw = path.join(qaProfileDir, "EBWebView");
    expect(fs.existsSync(ebw)).toBe(true);
    // A real WebView2 session writes several entries here (Default/, Local State, ...).
    // An empty EBWebView would mean the env var did not actually take effect.
    expect(fs.readdirSync(ebw).length).toBeGreaterThan(0);
  });

  it("the QA WebView2 bound the isolated profile, not the user's com.rushcut.app\\EBWebView", () => {
    const cmdline = process.env.QA_WEBVIEW_CMDLINE ?? "";
    const qaProfileDir = process.env.QA_PROFILE_DIR as string;
    // Positive proof that survives a concurrently-running user instance: the QA rushcut.exe's
    // own WebView2 child references the QA profile on its command line and never the user's.
    expect(cmdline.length).toBeGreaterThan(0);
    expect(cmdline).toContain(qaProfileDir);
    expect(cmdline).not.toContain("com.rushcut.app\\EBWebView");
  });

  it("the user's real com.rushcut.app\\EBWebView was NOT modified during QA startup (only checkable with no concurrent user instance)", () => {
    const userDir = process.env.QA_USER_WEBVIEW_DIR as string;
    const before = process.env.QA_USER_WEBVIEW_MTIME_BEFORE ?? "";
    const foreignRunning = (process.env.QA_FOREIGN_RUSHCUT ?? "0") !== "0";
    if (!userDir || !fs.existsSync(userDir)) return; // app never launched on this box -- nothing to protect
    if (foreignRunning) {
      // A user rushcut.exe is running alongside the QA one and legitimately writes to its own
      // profile dir, so a dir-mtime delta here proves nothing. The previous spec's command-line
      // check is the isolation proof in this case; assert only that a foreign instance is indeed
      // why we're skipping, so this branch can't silently hide a real regression.
      expect(process.env.QA_WEBVIEW_CMDLINE).toContain(process.env.QA_PROFILE_DIR as string);
      return;
    }
    const now = fs.statSync(userDir).mtime.toISOString();
    expect(now).toBe(before);
  });

  it("the CDP target being driven is the QA debug port, not :9222", async () => {
    const expected = process.env.QA_CDP_PORT ?? "9223";
    // capabilities.ms:edgeOptions.debuggerAddress is what msedgedriver attached to.
    const caps = (browser as any).capabilities ?? {};
    const dbg = caps["ms:edgeOptions"]?.debuggerAddress
      ?? (browser as any).requestedCapabilities?.["ms:edgeOptions"]?.debuggerAddress
      ?? "";
    expect(String(dbg)).toContain(`:${expected}`);
    expect(String(dbg)).not.toContain(":9222");
  });
});
