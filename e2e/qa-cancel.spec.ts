/**
 * qa-cancel.spec.ts (#261) -- the cancel-render lifecycle, through the REAL native dialog.
 *
 * Run it through the runner, never directly:   pnpm cancel-check -- --clips <folder>
 * The runner (e2e/run-cancel-check.ts) starts wdio.qa.conf.ts isolated (own DB, profile, ports;
 * APPDATA/TMP/TEMP under C:\rcqa\<runid>) and sets RC_CANCEL_CLIPS / RC_CANCEL_OUT.
 *
 * What it proves (all through production code and the real buttons):
 *   1. Pressing Cancel export opens the native dialog; its title, message and button names are read
 *      back with Windows UI Automation (WebDriver cannot reach a native dialog, UI Automation can).
 *   2. "Keep exporting" -> the render carries on (still processing, progress does not stop).
 *   3. "Stop exporting" -> "Export cancelled" shows exactly once, the job row is failed /
 *      Render cancelled, no done / progress event revives it (#252), and 10 s later no process
 *      carrying the job id is alive (Linux ps + Windows command lines).
 *   4. A new render started straight after the cancel completes normally (negative case).
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { trackTestProject } from "./helpers/testProjects";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  browser.execute((c, a) => (window as any).__TAURI_INTERNALS__.invoke(c, a), cmd, args ?? {}) as Promise<T>;

const CLIPS = process.env.RC_CANCEL_CLIPS ?? "";
const OUT = process.env.RC_CANCEL_OUT ?? "";
const RUNID = process.env.RC_CANCEL_RUNID ?? "run";
const CUTS = Number(process.env.RC_CANCEL_CUTS ?? 12);
const CUT_MS = 4500;
const DIALOG_TITLE = "Stop exporting this video?";
const WSL = (args: string[]) => spawnSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", ...args], { encoding: "utf8" });
const evidence: Record<string, unknown> = {};

function dialog(pid: number, button: string, inspectOnly = false, shot = ""): any {
  const ps1 = path.resolve(__dirname, "helpers", "clickNativeDialog.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ProcId", String(pid), "-Title", DIALOG_TITLE, "-TimeoutSec", "25"];
  if (shot) args.push("-ShotPath", shot);
  if (inspectOnly) args.push("-InspectOnly"); else args.push("-Button", button);
  const r = spawnSync("powershell", args, { encoding: "utf8" });
  const line = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "{}";
  try { return JSON.parse(line); } catch { return { found: false, error: `unparseable: ${line} ${r.stderr}` }; }
}

/** processes still carrying the job id: Linux argv + Windows command lines (our own tooling excluded). */
function liveJobProcesses(jobId: string): string[] {
  const linux = (WSL(["ps", "-eo", "pid,args"]).stdout ?? "").split(/\r?\n/)
    .filter((l) => l.includes(jobId) && !/^\s*\d+\s+ps\s/.test(l)).map((l) => "linux: " + l.trim().slice(0, 120));
  const win = spawnSync("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + jobId + "*' -and $_.Name -notmatch '^(powershell|pwsh|cmd|node|conhost)\\.exe$' } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }"],
    { encoding: "utf8" });
  const winLines = (win.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => "windows: " + s);
  return [...linux, ...winLines];
}

describe("#261 cancel-render lifecycle (real native dialog)", function () {
  this.timeout(1_800_000);

  it("keeps rendering on 'Keep exporting', cancels cleanly on 'Stop exporting', and renders again", async () => {
    const QA_ROOT = process.env.QA_ROOT ?? "";
    expect(QA_ROOT.length).toBeGreaterThan(0);
    expect((process.env.QA_TEMP_DIR ?? "").length).toBeGreaterThan(0);   // empty => not isolated
    expect(CLIPS.length).toBeGreaterThan(0);
    expect(OUT.length).toBeGreaterThan(0);
    fs.mkdirSync(OUT, { recursive: true });
    const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, ".qa-lock.json"), "utf8"));
    const appPid = Number(lock.appPid);
    expect(Number.isInteger(appPid)).toBe(true);
    const cacheBefore = (WSL(["ls", "-1", "/tmp/rushcut-render-cache"]).stdout ?? "").split(/\r?\n/).filter(Boolean);

    try {
      // ---- setup: excerpts + project (production commands only; same recipe as qa-acceptance) ----
      const ffprobeDur = (f: string) => {
        const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", f], { encoding: "utf8" });
        try { return Number(JSON.parse(r.stdout).format.duration); } catch { return 0; }
      };
      const all = fs.readdirSync(CLIPS).filter((f) => /\.(mp4|mov|mkv)$/i.test(f)).sort();
      const picked = all.map((f) => ({ f, d: ffprobeDur(path.join(CLIPS, f)) })).filter((x) => x.d >= 6)
        .sort((a, b) => b.d - a.d || a.f.localeCompare(b.f)).slice(0, 3).map((x) => x.f);
      expect(picked.length).toBeGreaterThan(0);
      const exDir = path.join(QA_ROOT, `clips-${RUNID}`);
      fs.mkdirSync(exDir, { recursive: true });
      picked.forEach((f, k) => {
        const dst = path.join(exDir, `clip-${String(k + 1).padStart(2, "0")}.mp4`);
        const r = spawnSync("ffmpeg", ["-y", "-ss", "0", "-t", "36", "-i", path.join(CLIPS, f), "-c", "copy", dst], { encoding: "utf8" });
        if (r.status !== 0 || !fs.existsSync(dst)) throw new Error(`excerpt ${k + 1} failed`);
      });
      const metas = await invoke<any[]>("scan_folder", { folderPath: exDir });
      const projectName = `Cancel ${RUNID}`;
      const projectId = await invoke<string>("create_project", {
        name: projectName,
        clips: metas.map((m) => ({ filename: m.filename, local_path: m.local_path, size_bytes: m.size_bytes, duration_ms: m.duration_ms,
          width: m.width, height: m.height, has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null })),
      });
      trackTestProject(projectId);
      const proj = await invoke<any>("get_project", { projectId });
      const sources = proj.clips.filter((c: any) => c.include === 0).sort((a: any, b: any) => a.sort_order - b.sort_order);
      const cap = sources.map((s: any) => Math.max(0, Math.floor((Number(s.duration_ms) / 1000 - 0.3) / (CUT_MS / 1000))));
      const plan: Array<{ id: string; slot: number }> = [];
      for (let slot = 0; plan.length < CUTS && slot < 64; slot++) {
        sources.forEach((s: any, i: number) => { if (slot < cap[i] && plan.length < CUTS) plan.push({ id: s.id, slot }); });
      }
      expect(plan.length).toBe(CUTS);
      const cutIds: string[] = [];
      for (const { id, slot } of plan) {
        const cut = await invoke<any>("add_clip_cut_cmd", { projectId, sourceClipId: id, inMs: slot * CUT_MS, outMs: slot * CUT_MS + CUT_MS });
        cutIds.push(cut.id);
      }
      await invoke("reorder_clips_cmd", { clipIds: cutIds });
      fs.mkdirSync(path.join(OUT, "film"), { recursive: true });
      await invoke("set_output_folder_cmd", { folder: path.join(OUT, "film") });
      await invoke("generate_proxies_cmd", { projectId, lowPriority: false });
      const res = "1080p";
      await browser.waitUntil(async () => {
        const r = await invoke<any>("get_proxy_readiness_cmd", { projectId, outputResolution: res });
        return r.total === CUTS && r.ready === r.total;
      }, { timeout: 15 * 60_000, interval: 3000, timeoutMsg: "proxies never became ready" });

      // ---- Trimmer -> Arrange (crossfade => segmented, so the render is long enough to cancel) -> Render ----
      await browser.execute(() => { (window as any).history.pushState({}, "", "/library"); window.dispatchEvent(new PopStateEvent("popstate")); });
      await browser.waitUntil(async () => (await browser.getUrl()).includes("/library"), { timeout: 10_000, interval: 200 });
      await browser.pause(400);
      let opened = false;
      for (const c of await $$('[data-testid="project-card"]')) {
        if ((await c.getText()).includes(projectName) || (await c.$(`input[value="${projectName}"]`).isExisting())) {
          await c.$('[data-testid="btn-open-project"]').click(); opened = true; break;
        }
      }
      expect(opened).toBe(true);
      await browser.waitUntil(async () => (await browser.getUrl()).includes("/trimmer/"), { timeout: 15_000, interval: 200 });
      await $('[data-testid="tab-arrange"]').click();
      await browser.waitUntil(async () => (await browser.getUrl()).includes("/arrange/"), { timeout: 10_000, interval: 200 });
      const tt = await $('[data-testid="arrange-tab-transitions"]'); await tt.waitForExist({ timeout: 10_000 }); await tt.click();
      const chip = await $('[data-testid="chip-transition-crossfade"]'); await chip.waitForExist({ timeout: 10_000 }); await chip.click();
      await $('[data-testid="tab-sound"]').click();
      await browser.waitUntil(async () => (await browser.getUrl()).includes("/sound/"), { timeout: 10_000, interval: 200 });
      await $('[data-testid="tab-render"]').click();
      await browser.waitUntil(async () => (await browser.getUrl()).includes("/render/"), { timeout: 10_000, interval: 200 });

      const startRender = async () => {
        const btn = await $('[data-testid="btn-render-film"]');
        await btn.waitForExist({ timeout: 20_000 });
        const resChip = await $(`[data-testid="chip-res-${res}"]`);
        if (await resChip.isExisting()) await resChip.click();
        await browser.waitUntil(async () => await btn.isEnabled(), { timeout: 15_000, interval: 200 });
        await btn.click();
        const cancelBtn = await $('[data-testid="btn-cancel-render"]');
        await cancelBtn.waitForExist({ timeout: 30_000 });
        let jobId = "";
        await browser.waitUntil(async () => {
          const s = await invoke<any>("get_render_status_cmd", { projectId });
          jobId = s?.active_job?.id ?? "";
          return jobId.length > 0;
        }, { timeout: 30_000, interval: 500 });
        return jobId;
      };
      const progressPct = async () => Number((await $('[data-testid="progress-pct"]').getText()).replace(/[^0-9]/g, "") || 0);
      const bodyText = () => browser.execute(() => document.body.textContent ?? "");
      const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

      // ---- render 1: Keep exporting, then Stop exporting ----------------------------------------
      const job1 = await startRender();
      await browser.waitUntil(async () => (await progressPct()) >= 8, { timeout: 5 * 60_000, interval: 1000, timeoutMsg: "render never passed 8%" });

      await $('[data-testid="btn-cancel-render"]').click();
      const seen = dialog(appPid, "Keep exporting", false, path.join(OUT, "cancel-dialog.png"));
      evidence.dialog = { found: seen.found, texts: seen.texts, buttons: seen.buttons, clickedKeep: seen.clicked, error: seen.error, windows: seen.windows };
      expect(seen.found).toBe(true);
      expect(seen.texts.join(" | ")).toContain("You can export it again any time.");
      expect(seen.buttons).toContain("Stop exporting");
      expect(seen.buttons).toContain("Keep exporting");
      expect(seen.texts.join(" | ")).not.toMatch(/clips are safe/i);
      expect(seen.clicked).toBe("Keep exporting");

      const p0 = await progressPct();
      await browser.pause(8000);
      const jobAfterKeep = await invoke<any>("get_job_cmd", { jobId: job1 });
      evidence.keepPath = { status: jobAfterKeep.status, pctBefore: p0, pctAfter: await progressPct().catch(() => -1) };
      expect(jobAfterKeep.status).toBe("processing");
      expect(await $('[data-testid="btn-cancel-render"]').isExisting()).toBe(true);
      expect(await bodyText()).not.toContain("Export cancelled");

      await $('[data-testid="btn-cancel-render"]').click();
      const stop = dialog(appPid, "Stop exporting");
      expect(stop.clicked).toBe("Stop exporting");
      const cancelAt = Date.now();
      await browser.waitUntil(async () => (await bodyText()).includes("Export cancelled"), { timeout: 60_000, interval: 500, timeoutMsg: "no 'Export cancelled' after Stop exporting" });
      await browser.pause(15_000);   // #252: a late done / error / progress event would show up in this window
      const txt = await bodyText();
      const job1End = await invoke<any>("get_job_cmd", { jobId: job1 });
      evidence.stopPath = { cancelledCount: countOf(txt, "Export cancelled"), doneShown: txt.includes("Your film"), status: job1End.status, error: job1End.error_message };
      expect(countOf(txt, "Export cancelled")).toBe(1);
      expect(await $('[data-testid="render-done"]').isExisting()).toBe(false);
      expect(await $('[data-testid="progress-bar"]').isExisting()).toBe(false);
      expect(job1End.status).toBe("failed");
      expect(String(job1End.error_message)).toContain("Render cancelled");

      const waitLeft = Math.max(0, 10_000 - (Date.now() - cancelAt));
      if (waitLeft) await browser.pause(waitLeft);
      const alive = liveJobProcesses(job1);
      evidence.processesAfter10s = alive;
      expect(alive).toEqual([]);

      // ---- render 2 straight after the cancel: must complete (negative case) -------------------
      await $("button=Try Again").click();
      const job2 = await startRender();
      expect(job2).not.toBe(job1);
      await browser.waitUntil(async () => await $('[data-testid="render-done"]').isExisting(), { timeout: 15 * 60_000, interval: 3000, timeoutMsg: "the render after a cancel did not finish" });
      const job2End = await invoke<any>("get_job_cmd", { jobId: job2 });
      evidence.renderAfterCancel = { status: job2End.status, output: job2End.local_output_path ? path.basename(String(job2End.local_output_path)) : null };
      expect(job2End.status).toBe("done");
      expect(job2End.local_output_path ? fs.existsSync(job2End.local_output_path) : false).toBe(true);
    } finally {
      evidence.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(OUT, "cancel-evidence.json"), JSON.stringify(evidence, null, 2));
      // Remove ONLY render-cache entries this run created (the shared WSL cache; nothing else is touched).
      const after = (WSL(["ls", "-1", "/tmp/rushcut-render-cache"]).stdout ?? "").split(/\r?\n/).filter(Boolean);
      const mine = after.filter((f) => !cacheBefore.includes(f) && /^[0-9a-f]{8,32}\.mp4$/.test(f));
      for (const f of mine) WSL(["rm", "-f", `/tmp/rushcut-render-cache/${f}`]);
      fs.writeFileSync(path.join(OUT, "cache-note.txt"), `removed ${mine.length} render-cache entr${mine.length === 1 ? "y" : "ies"} created by this run\n`);
    }
  });
});
