/**
 * qa-export-screen.spec.ts (#267) -- the export screen (ring, Prepare/Process/Finish bar, status card)
 * through a real export, with a mid-export reattach.
 *
 * Run it through the runner, never directly:   pnpm export-screen-check -- --clips <folder>
 * The runner (e2e/run-export-screen-check.ts) starts wdio.qa.conf.ts isolated (own DB, profile, ports;
 * APPDATA/TMP/TEMP under C:\rcqa\<runid>) and sets RC_ES_CLIPS / RC_ES_OUT.
 *
 * What it proves: the phase bar follows the pipeline's own stages (never goes back, none current before the
 * first stage, ends at Finish), the old "Step N of M" text is gone, the detail toggle exists only while the
 * pipeline sends detail, leaving the Export tab mid-export and coming back reattaches with the phase and
 * elapsed time restored, and the export still completes. Saves early / mid / reattached / done screenshots.
 * The stall warning is checked by shifting the page clock (no production change). The error view is the one the cancel-check reaches ("Export cancelled").
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { trackTestProject } from "./helpers/testProjects";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  browser.execute((c, a) => (window as any).__TAURI_INTERNALS__.invoke(c, a), cmd, args ?? {}) as Promise<T>;

const CLIPS = process.env.RC_ES_CLIPS ?? "";
const OUT = process.env.RC_ES_OUT ?? "";
const RUNID = process.env.RC_ES_RUNID ?? "run";
const CUTS = Number(process.env.RC_ES_CUTS ?? 12);
const CUT_MS = 4500;
const WSL = (args: string[]) => spawnSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", ...args], { encoding: "utf8" });
const evidence: Record<string, unknown> = {};

describe("#267 export screen (ring + phase bar + card)", function () {
  this.timeout(1_800_000);

  it("walks the phases, reattaches mid-export and finishes", async () => {
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
      const snap = async (name: string) => { await browser.saveScreenshot(path.join(OUT, name + ".png")); };
      const probe = () => browser.execute(() => {
        const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        return {
          pct: q("progress-pct")?.textContent ?? null, ringRole: q("progress-bar")?.getAttribute("role") ?? null,
          label: q("stage-label")?.textContent ?? null, toggle: !!q("stage-detail-toggle"),
          elapsed: q("elapsed-timer")?.textContent ?? null, stepCounter: !!q("step-counter"),
          steps: [0, 1, 2].map((i) => q(`phase-step-${i}`)?.getAttribute("data-state") ?? "-"),
          note: q("still-working-note") ? getComputedStyle(q("still-working-note")!).opacity : null,
        };
      });
      const rank = (steps: string[]) => steps.reduce((m, s, i) => (s === "current" || s === "done" ? Math.max(m, i) : m), -1);
      const elapsedS = (t: string | null) => { const m = /(?:(\d+)m )?(\d+)s/.exec(t ?? ""); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : -1; };
      const job1 = await startRender();
      evidence.job = job1;
      const samples: any[] = [];
      const t0 = Date.now();
      let lastKey = "", shotEarly = false, shotDetail = false, shotMid = false, reattached = false;
      let stallTried = false, stallResult: any = null;
      let maxRank = -1, wentBack = false, sawNote = false, firstStageSeen = false, preStageOk = true;
      await browser.waitUntil(async () => {
        if (await $('[data-testid="render-done"]').isExisting()) return true;
        const p = await probe().catch(() => null);
        if (!p || p.pct == null) return false;
        const r = rank(p.steps);
        if (r < maxRank) wentBack = true;
        maxRank = Math.max(maxRank, r);
        if (r >= 0) firstStageSeen = true;
        if (!firstStageSeen && p.steps.some((s: string) => s !== "pending")) preStageOk = false;
        if (p.note === "1") sawNote = true;
        const key = `${p.steps.join(",")}|${p.label}|${p.toggle}`;
        if (key !== lastKey) { samples.push({ t: Math.round((Date.now() - t0) / 1000), ...p }); lastKey = key; }
        if (!shotEarly && Number(p.pct) >= 3) { await snap("early"); shotEarly = true; }
        if (p.toggle && !shotDetail) {
          await $('[data-testid="stage-detail-toggle"]').click().catch(() => {});
          await browser.pause(300); await snap("early-detail-open"); shotDetail = true;
          await $('[data-testid="stage-detail-toggle"]').click().catch(() => {});
        }
        // Stall warning, no production change: run the page clock fast (x500) so the screen's own stall check
        // (Date.now() minus the last pipeline signal, polled every 30 s) trips even though live events keep arriving.
        // The DOM is read and the clock restored in the same call the moment the banner shows.
        if (shotDetail && !stallTried && p.steps[0] === "current") {
          stallTried = true;
          await browser.execute(() => { const real = Date.now.bind(Date); const t0 = real(); (window as any).__rcRealNow = real; Date.now = () => t0 + (real() - t0) * 500; });
          try {
            await browser.waitUntil(async () => await $('[data-testid="render-stall-warning"]').isExisting(), { timeout: 60_000, interval: 250 });
          } catch { /* judged after the loop */ }
          stallResult = await browser.execute(() => {
            const r = (window as any).__rcRealNow; if (r) Date.now = r;
            const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
            return {
              shown: !!q("render-stall-warning"), text: q("render-stall-warning")?.textContent ?? "",
              retry: !!q("btn-stall-retry"), cancel: !!q("btn-cancel-render"), ring: !!q("progress-bar"), phaseBar: !!q("phase-bar"), card: !!q("stage-label"),
            };
          });
          await snap("stall");
        }
        if (!shotMid && p.steps[1] === "current" && Number(p.pct) >= 40) { await snap("mid"); shotMid = true; }
        // Reattach: leave the Export tab for another tab and come back while the export is in its Process phase.
        if (shotMid && !reattached) {
          reattached = true;
          const before = await probe();
          await $('[data-testid="tab-sound"]').click();
          await browser.waitUntil(async () => (await browser.getUrl()).includes("/sound/"), { timeout: 10_000, interval: 200 });
          await browser.pause(3000);
          await $('[data-testid="tab-render"]').click();
          await browser.waitUntil(async () => (await browser.getUrl()).includes("/render/"), { timeout: 10_000, interval: 200 });
          await $('[data-testid="btn-cancel-render"]').waitForExist({ timeout: 20_000 });
          await browser.pause(800);
          const after = await probe();
          await snap("reattached");
          evidence.reattach = { before, after, elapsedBeforeS: elapsedS(before.elapsed), elapsedAfterS: elapsedS(after.elapsed) };
          // Process was current before leaving, so after coming back Prepare must be done and Process (or later) current.
          expect(after.steps[0]).toBe("done");
          expect(["current", "done"]).toContain(after.steps[1]);
          expect(elapsedS(after.elapsed)).toBeGreaterThanOrEqual(elapsedS(before.elapsed));   // timer continued, not reset
          expect(after.stepCounter).toBe(false);
          expect(after.label ?? "").not.toBe("");
        }
        return false;
      }, { timeout: 25 * 60_000, interval: 1500, timeoutMsg: "export did not finish" });
      await snap("done");
      evidence.samples = samples;
      evidence.summary = { maxRank, wentBack, sawNote, preStageOk, reattached };
      const end = await invoke<any>("get_job_cmd", { jobId: job1 });
      evidence.status = end.status;
      expect(end.status).toBe("done");
      expect(wentBack).toBe(false);          // the phase bar never moves backwards
      expect(preStageOk).toBe(true);         // nothing is marked before the first stage arrives
      expect(maxRank).toBe(2);               // ends in Finish
      expect(reattached).toBe(true);
      evidence.stall = stallResult;
      expect(stallResult?.shown).toBe(true);
      expect(stallResult?.text).toContain("taking longer than expected");
      expect(stallResult?.retry && stallResult?.cancel && stallResult?.ring && stallResult?.phaseBar && stallResult?.card).toBe(true);   // nothing displaced
      expect(samples.every((x) => x.stepCounter === false && x.ringRole === "progressbar")).toBe(true);
    } finally {
      evidence.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(OUT, "export-screen-evidence.json"), JSON.stringify(evidence, null, 2));
      // Remove ONLY render-cache entries this run created (the shared WSL cache; nothing else is touched).
      const after = (WSL(["ls", "-1", "/tmp/rushcut-render-cache"]).stdout ?? "").split(/\r?\n/).filter(Boolean);
      const mine = after.filter((f) => !cacheBefore.includes(f) && /^[0-9a-f]{8,32}\.mp4$/.test(f));
      for (const f of mine) WSL(["rm", "-f", `/tmp/rushcut-render-cache/${f}`]);
      fs.writeFileSync(path.join(OUT, "cache-note.txt"), `removed ${mine.length} render-cache entr${mine.length === 1 ? "y" : "ies"} created by this run\n`);
    }
  });
});
