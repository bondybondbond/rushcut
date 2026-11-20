/**
 * qa-acceptance.spec.ts (#237) -- the reusable mechanical acceptance run.
 *
 * Run it through the runner, never directly:   pnpm accept -- --clips <folder>
 * The runner (e2e/run-acceptance.ts) sets RC_QA_ROOT, QA_ISOLATE_RENDER=1 and the RC_ACCEPT_*
 * inputs, and starts wdio.qa.conf.ts (own DB, WebView2 profile, ports; APPDATA/TMP/TEMP under the
 * QA root). This spec builds a disposable project from stream-copy excerpts of the user's own
 * footage (read-only; the folder comes from the command line and is never committed), walks the
 * real Trimmer -> Arrange -> Sound -> Render screens, clicks the real Render button, then hands
 * everything it harvested to the pure checker (helpers/acceptanceChecks.ts) and writes
 * report.md / report.json / verdict.json into RC_ACCEPT_OUT.
 *
 * It only judges the MECHANICS. Picture quality stays with the owner.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { trackTestProject } from "./helpers/testProjects";
import { changedSince, loadSnapshot, snapshotReal } from "./helpers/realLocations";
import {
  evaluate, exitCodeFor, readProxyTag, redact, renderReport, worstStatus,
  type AcceptanceInput, type ProxyProbe,
} from "./helpers/acceptanceChecks";

const invoke = <T,>(cmd: string, args?: Record<string, unknown>) =>
  browser.execute((c, a) => (window as any).__TAURI_INTERNALS__.invoke(c, a), cmd, args ?? {}) as Promise<T>;

const ENV = {
  clips: process.env.RC_ACCEPT_CLIPS ?? "",
  res: (process.env.RC_ACCEPT_RES === "1080p" ? "1080p" : "4k") as "4k" | "1080p",
  out: process.env.RC_ACCEPT_OUT ?? "",
  brk: process.env.RC_ACCEPT_BREAK ?? "",
  cuts: Number(process.env.RC_ACCEPT_CUTS ?? 20),
  sources: Number(process.env.RC_ACCEPT_SOURCES ?? 6),
  runId: process.env.RC_ACCEPT_RUNID ?? "run",
  keep: process.env.RC_ACCEPT_KEEP === "1",
};
// Set by wdio.qa.conf.ts before() AFTER this module loads, so they are read inside the test.
let QA_ROOT = "";
let QA_TEMP = "";
let QA_APPDATA = "";
const CUT_MS = 4500;
const WSL = (args: string[]) => spawnSync("wsl", ["-d", "Ubuntu-24.04", "-u", "root", "--", ...args], { encoding: "utf8" });

// ---- phases ------------------------------------------------------------------------------------
const phases: Array<{ name: string; startedAt: string; seconds: number; ok: boolean; error?: string }> = [];
async function phase<T>(name: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const rec = { name, startedAt: new Date(t0).toISOString(), seconds: 0, ok: false } as (typeof phases)[number];
  phases.push(rec);
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`phase '${name}' exceeded its ${Math.round(ms / 1000)} s deadline`)), ms); }),
    ]);
    rec.ok = true;
    return r;
  } catch (e) {
    rec.error = (e as Error).message;
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    rec.seconds = Math.round((Date.now() - t0) / 100) / 10;
  }
}

/** Redact the QA root, the footage folder and any C:\Users\<name> before anything is written. */
const redactAll = (t: string) => redact(t, QA_ROOT, [ENV.clips]);

function ffprobeJson(file: string, entries: string[]): any {
  const r = spawnSync("ffprobe", ["-v", "error", ...entries, "-of", "json", file], { encoding: "utf8" });
  try { return JSON.parse(r.stdout || "{}"); } catch { return {}; }
}

describe("#237 reusable acceptance run", function () {
  this.timeout(3_000_000);   // 50 min > the phase deadlines (44 min) so the report is always written

  it("runs the mechanical acceptance flow and writes the report", async () => {
    // ---- guards: this spec must only ever run isolated, via the runner --------------------
    QA_ROOT = process.env.QA_ROOT ?? "";
    QA_TEMP = process.env.QA_TEMP_DIR ?? "";
    QA_APPDATA = process.env.QA_APPDATA_DIR ?? "";
    expect(QA_ROOT.length).toBeGreaterThan(0);
    expect(QA_APPDATA.length).toBeGreaterThan(0);                      // empty => config was not in isolate mode
    expect(QA_TEMP.length).toBeGreaterThan(0);
    expect(ENV.clips.length).toBeGreaterThan(0);
    expect(ENV.out.length).toBeGreaterThan(0);
    fs.mkdirSync(ENV.out, { recursive: true });
    fs.mkdirSync(path.join(ENV.out, "logs"), { recursive: true });

    const runStartMs = Date.now();
    const state: Partial<AcceptanceInput> & Record<string, any> = {
      res: ENV.res, cutCount: ENV.cuts, runStartMs, proxies: [] as ProxyProbe[], timingRows: [],
      jobLog: null, jobLogMtimeMs: null, analysis: null, output: null, wallRenderS: null,
      trimmerFirstFrameMs: null, trimmerSignal: null, expectSegmented: ENV.cuts > 4,   // the spec always picks crossfade, and the product segments any crossfade film of more than 4 clips
      ctx: { proxies: "cold", cache: "cold", transition: "crossfade", zoom: false },
    };
    let phaseError: Error | null = null;
    let jobId = "";
    let cacheOwnership: { ok: boolean; file: string; reason: string } = { ok: false, file: "", reason: "render did not run" };

    const libRs = fs.readFileSync(path.resolve(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
    state.proxyTagExpected = readProxyTag(libRs) ?? "";
    expect(state.proxyTagExpected).not.toBe("");                       // fail closed: no tag constant, no run

    const realBefore = loadSnapshot(path.join(QA_ROOT, "real-before.json"));   // null => not checkable (reported as WARN)
    const wslCacheBefore = (WSL(["ls", "-1", "/tmp/rushcut-render-cache"]).stdout ?? "").split(/\r?\n/).filter(Boolean);
    const foreign = (process.env.QA_FOREIGN_RUSHCUT ?? "0") !== "0";

    try {
      // ---- setup: excerpts + project (production commands only) ---------------------------
      const projectName = `Acceptance ${ENV.runId}`;
      let projectId = "";
      let sourceCount = 0;
      let capacity: number[] = [];
      const cutIds: string[] = [];
      await phase("setup", 8 * 60_000, async () => {
        const all = fs.readdirSync(ENV.clips).filter((f) => /\.(mp4|mov|mkv)$/i.test(f)).sort();
        expect(all.length).toBeGreaterThan(0);
        // Pick the LONGEST sources: cut windows must fit inside each excerpt's real duration
        // (a cut past the end gives the pipeline a negative trim length).
        const durS = (f: string) => Number(ffprobeJson(path.join(ENV.clips, f), ["-show_entries", "format=duration"])?.format?.duration ?? 0);
        const withDur = all.map((f) => ({ f, d: durS(f) })).filter((x) => x.d >= 6).sort((a, b) => b.d - a.d || a.f.localeCompare(b.f));
        const picked = withDur.slice(0, ENV.sources).map((x) => x.f);
        capacity = withDur.slice(0, ENV.sources).map((x) => Math.floor(Math.min(36, x.d) / (CUT_MS / 1000)));
        const total = capacity.reduce((a, b) => a + b, 0);
        if (total < ENV.cuts) throw new Error(`the footage folder only holds ${total} cut slots of ${CUT_MS} ms in its ${picked.length} longest clips; ${ENV.cuts} cuts were requested`);
        const exDir = path.join(QA_ROOT, `clips-${ENV.runId}`);        // unique path per run => cache key MISS
        fs.mkdirSync(exDir, { recursive: true });
        picked.forEach((f, k) => {
          const dst = path.join(exDir, `clip-${String(k + 1).padStart(2, "0")}.mp4`);   // renamed: no footage name reaches any log
          const r = spawnSync("ffmpeg", ["-y", "-ss", "0", "-t", "36", "-i", path.join(ENV.clips, f), "-c", "copy", dst], { encoding: "utf8" });
          if (r.status !== 0 || !fs.existsSync(dst)) throw new Error(`excerpt ${k + 1} failed (ffmpeg exit ${r.status})`);
        });
        const metas = await invoke<any[]>("scan_folder", { folderPath: exDir });
        expect(metas.length).toBe(picked.length);
        sourceCount = metas.length;
        capacity = new Array(picked.length).fill(0);
        for (const m of metas) {
          const n = Number(String(m.filename).match(/clip-(\d+)/)?.[1] ?? 0) - 1;
          if (n >= 0 && n < capacity.length) capacity[n] = Math.max(0, Math.floor((Number(m.duration_ms) / 1000 - 0.3) / (CUT_MS / 1000)));
        }
        if (capacity.reduce((x, y) => x + y, 0) < ENV.cuts) throw new Error(`the excerpts only hold ${capacity.reduce((x, y) => x + y, 0)} cut slots; ${ENV.cuts} requested`);
        const clips = metas.map((m) => ({
          filename: m.filename, local_path: m.local_path, size_bytes: m.size_bytes, duration_ms: m.duration_ms,
          width: m.width, height: m.height, has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null,
        }));
        projectId = await invoke<string>("create_project", { name: projectName, clips });
        trackTestProject(projectId);
        const proj = await invoke<any>("get_project", { projectId });
        const sources = proj.clips.filter((c: any) => c.include === 0).sort((a: any, b: any) => a.sort_order - b.sort_order);
        expect(sources.length).toBe(sourceCount);
        // Interleave sources slot by slot; a source stops contributing once its excerpt is used up.
        const plan: Array<{ srcId: string; slot: number }> = [];
        for (let slot = 0; plan.length < ENV.cuts && slot < 64; slot++) {
          for (const s of sources) {
            const n = Number(String(s.filename).match(/clip-(\d+)/)?.[1] ?? 0) - 1;
            if (slot < (capacity[n] ?? 0) && plan.length < ENV.cuts) plan.push({ srcId: s.id, slot });
          }
        }
        expect(plan.length).toBe(ENV.cuts);
        for (const { srcId, slot } of plan) {
          const inMs = slot * CUT_MS;
          const cut = await invoke<any>("add_clip_cut_cmd", { projectId, sourceClipId: srcId, inMs, outMs: inMs + CUT_MS });
          cutIds.push(cut.id);
        }
        await invoke("reorder_clips_cmd", { clipIds: cutIds });          // stable order (e2e.md tied sort_order trap)
        fs.mkdirSync(path.join(ENV.out, "film"), { recursive: true });
        await invoke("set_output_folder_cmd", { folder: path.join(ENV.out, "film") });
      });

      // ---- proxies ------------------------------------------------------------------------
      await phase("proxies", 20 * 60_000, async () => {
        await invoke("generate_proxies_cmd", { projectId, lowPriority: false });
        await browser.waitUntil(async () => {
          const r = await invoke<any>("get_proxy_readiness_cmd", { projectId, outputResolution: ENV.res });
          return r.total === ENV.cuts && r.ready === r.total;
        }, { timeout: 19 * 60_000, interval: 3000, timeoutMsg: "proxies never became ready" });
        state.ctx!.proxies = "cold";      // generated fresh inside the QA root by construction
        const proj = await invoke<any>("get_project", { projectId });
        const paths = [...new Set<string>(proj.clips.filter((c: any) => c.include === 1 && c.proxy_path).map((c: any) => c.proxy_path as string))];
        state.expectedProxyCount = sourceCount;
        const outside = paths.filter((p) => !p.toLowerCase().startsWith((QA_ROOT + path.sep).toLowerCase()));
        if (outside.length > 0) throw new Error(`isolation failed: ${outside.length} proxy file(s) are outside the QA root`);
        if (ENV.brk === "stale-proxy" && paths.length > 0) {
          // The real negative control: make ONE finished proxy look like an old-version file by
          // re-muxing it without its version tag. (Deleting a proxy is NOT a valid control: the
          // app silently regenerates a missing proxy before the render starts. Checked 2026-11-19.)
          const stale = paths[0] + ".stale.mp4";
          const r = spawnSync("ffmpeg", ["-y", "-i", paths[0], "-c", "copy", "-map_metadata", "-1", stale], { encoding: "utf8" });
          if (r.status !== 0) throw new Error(`could not make the stale-proxy control (ffmpeg exit ${r.status})`);
          fs.renameSync(stale, paths[0]);
        }
        paths.forEach((p, idx) => {
          const j = ffprobeJson(p, ["-select_streams", "v:0", "-show_entries", "stream=height", "-show_entries", "format_tags=comment"]);
          (state.proxies as ProxyProbe[]).push({
            idx, tag: String(j?.format?.tags?.comment ?? ""), height: Number(j?.streams?.[0]?.height ?? 0),
            rel: path.relative(QA_ROOT, p).replace(/\\/g, "/"),
          });
        });
      });

      // ---- Trimmer (real UI) --------------------------------------------------------------
      await phase("trimmer", 2 * 60_000, async () => {
        await browser.execute(() => { (window as any).history.pushState({}, "", "/library"); window.dispatchEvent(new PopStateEvent("popstate")); });
        await browser.waitUntil(async () => (await browser.getUrl()).includes("/library"), { timeout: 10_000, interval: 200 });
        await browser.pause(400);
        const cards = await $$('[data-testid="project-card"]');
        let opened = false;
        for (const c of cards) {
          if ((await c.getText()).includes(projectName) || (await c.$(`input[value="${projectName}"]`).isExisting())) {
            await browser.execute(() => { (window as any).__rcT0 = performance.now(); });
            await c.$('[data-testid="btn-open-project"]').click();
            opened = true; break;
          }
        }
        if (!opened) throw new Error("project card not found in the Library");
        // The Trimmer mounts FOUR <video> elements (clip A/B, film A/B) whose src is set
        // imperatively, so watch every one that actually has a source, not the first in the DOM.
        const t = await browser.executeAsync((done: (r: { ms: number; signal: string; diag: string }) => void) => {
          const t0 = (window as any).__rcT0 as number;
          const deadline = performance.now() + 25_000;
          let fin = false, readyAt = 0;
          const diag = () => {
            const vs = Array.from(document.querySelectorAll("video")) as HTMLVideoElement[];
            return `${vs.length} video element(s), ${vs.filter((v) => v.currentSrc || v.getAttribute("src")).length} with a source, max readyState ${Math.max(0, ...vs.map((v) => v.readyState))}`;
          };
          const end = (signal: string) => { if (!fin) { fin = true; done({ ms: performance.now() - t0, signal, diag: diag() }); } };
          const tick = () => {
            if (fin) return;
            const vs = (Array.from(document.querySelectorAll("video")) as HTMLVideoElement[]).filter((v) => v.currentSrc || v.getAttribute("src"));
            for (const v of vs) {
              if (!(v as any).__rcWatched && typeof (v as any).requestVideoFrameCallback === "function") {
                (v as any).__rcWatched = true;
                (v as any).requestVideoFrameCallback(() => end("requestVideoFrameCallback"));
              }
            }
            if (vs.some((v) => v.readyState >= 2)) {
              if (!readyAt) readyAt = performance.now();
              else if (performance.now() - readyAt > 1500) { end("readyState>=2 (rVFC did not fire)"); return; }
            }
            if (performance.now() > deadline) { end("timeout"); return; }
            setTimeout(tick, 25);
          };
          tick();
        });
        state.trimmerNote = t.diag;
        if (t.signal !== "timeout") { state.trimmerFirstFrameMs = t.ms; state.trimmerSignal = t.signal; }
        await browser.waitUntil(async () => (await browser.getUrl()).includes("/trimmer/"), { timeout: 10_000, interval: 200 });
      });

      // ---- Arrange + Sound (real UI) ------------------------------------------------------
      await phase("arrange_sound", 2 * 60_000, async () => {
        await $('[data-testid="tab-arrange"]').click();
        await browser.waitUntil(async () => (await browser.getUrl()).includes("/arrange/"), { timeout: 10_000, interval: 200 });
        const tt = await $('[data-testid="arrange-tab-transitions"]');
        await tt.waitForExist({ timeout: 10_000 });
        await tt.click();
        const chip = await $('[data-testid="chip-transition-crossfade"]');
        await chip.waitForExist({ timeout: 10_000 });
        await chip.click();
        await $('[data-testid="tab-sound"]').click();
        await browser.waitUntil(async () => (await browser.getUrl()).includes("/sound/"), { timeout: 10_000, interval: 200 });
        // Arrange is configured, so the Render tab raises no native confirm (which CDP cannot dismiss).
        await $('[data-testid="tab-render"]').click();
        await browser.waitUntil(async () => (await browser.getUrl()).includes("/render/"), { timeout: 10_000, interval: 200 });
      });

      // ---- Render (real button) -----------------------------------------------------------
      await phase("render", 12 * 60_000, async () => {
        const btn = await $('[data-testid="btn-render-film"]');
        await btn.waitForExist({ timeout: 20_000 });
        const resChip = await $(`[data-testid="chip-res-${ENV.res}"]`);
        if (await resChip.isExisting()) await resChip.click();
        else if (ENV.res === "4k") throw new Error("no 4K resolution chip: the disposable project has no 4K clips");
        await browser.waitUntil(async () => await btn.isEnabled(), { timeout: 15_000, interval: 200, timeoutMsg: "Render button stayed disabled" });
        const clickAt = Date.now();
        await btn.click();
        await browser.waitUntil(async () => {
          if (await $('[data-testid="render-done"]').isExisting()) return true;
          const failed = await browser.execute(() => /something went wrong|render failed|error/i.test(document.body.textContent ?? "") && !document.querySelector('[data-testid="progress-bar"]'));
          if (failed) throw new Error("the Render screen shows an error state");
          return false;
        }, { timeout: 11 * 60_000, interval: 3000, timeoutMsg: "render did not finish within 11 minutes" });
        state.wallRenderS = (Date.now() - clickAt) / 1000;
      });
    } catch (e) {
      phaseError = e as Error;
    }

    // ---- harvest (always, even after a failure: the evidence is what we are here for) -------
    try {
      const logDir = path.join(QA_TEMP, "rushcut");
      let logs: string[] = [];
      try { logs = fs.readdirSync(logDir).filter((f) => /^pipeline-[0-9a-f-]{36}\.log$/.test(f)); } catch { /* none */ }
      if (logs.length === 1) {
        jobId = logs[0].slice("pipeline-".length, -".log".length);
        const lp = path.join(logDir, logs[0]);
        state.jobLog = fs.readFileSync(lp, "utf8");
        state.jobLogMtimeMs = fs.statSync(lp).mtimeMs;
        try {
          const job = await invoke<any>("get_job_cmd", { jobId });
          state.analysis = job.analysis_summary ?? null;
          if (job.local_output_path && fs.existsSync(job.local_output_path)) {
            const j = ffprobeJson(job.local_output_path, ["-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration"]);
            const s = j?.streams?.[0];
            if (s) state.output = { codec: String(s.codec_name), width: Number(s.width), height: Number(s.height), durationS: Number(j?.format?.duration ?? 0) };
          }
        } catch { /* leave null; the checker fails closed */ }
      }
      state.jobId = jobId;
      try {
        const tl = fs.readFileSync(path.join(logDir, "render-timing-log.jsonl"), "utf8").split(/\r?\n/).filter(Boolean);
        state.timingRows = tl.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      } catch { state.timingRows = []; }

      // isolation proof, from where files physically landed
      const proxyDir = path.join(QA_APPDATA, "rushcut", "proxies");
      const changed = realBefore ? changedSince(realBefore, snapshotReal(QA_ROOT)) : [];
      state.isolation = {
        qaProxiesLanded: fs.existsSync(proxyDir) && fs.readdirSync(proxyDir).some((f) => f.endsWith(".mp4")),
        qaTempLanded: fs.existsSync(path.join(logDir, "render-timing-log.jsonl")) && logs.length === 1 && fs.existsSync(path.join(logDir, "proxy-bg.log")),
        qaDbLanded: fs.existsSync(path.join(process.env.QA_DATA_DIR ?? "", "rushcut.db")),
        realNewFiles: foreign || !realBefore ? null : changed.map((p) => redactAll(p)),
      };

      // render-cache ownership: only a file this run provably created may ever be removed
      const sigLine = (state.jobLog ?? "").split(/\r?\n/).filter((l) => /\[cache\] sig=/.test(l));
      const wroteLine = (state.jobLog ?? "").split(/\r?\n/).filter((l) => /\[cache\] wrote [0-9a-f]+\.mp4/.test(l));
      const missLine = (state.jobLog ?? "").split(/\r?\n/).filter((l) => /\[cache\] MISS /.test(l));
      if (sigLine.length === 1 && wroteLine.length === 1 && missLine.length === 1) {
        const sig = (sigLine[0].match(/sig=([0-9a-f]+)/) ?? [])[1] ?? "";
        const file = `${sig}.mp4`;
        const after = (WSL(["ls", "-1", "/tmp/rushcut-render-cache"]).stdout ?? "").split(/\r?\n/).filter(Boolean);
        const mt = Number((WSL(["stat", "-c", "%Y", `/tmp/rushcut-render-cache/${file}`]).stdout ?? "").trim()) * 1000;
        if (!sig || !wroteLine[0].includes(file)) cacheOwnership = { ok: false, file, reason: "log lines disagree about the cache file" };
        else if (wslCacheBefore.includes(file)) cacheOwnership = { ok: false, file, reason: "the file existed before this run" };
        else if (!after.includes(file)) cacheOwnership = { ok: false, file, reason: "the file is not present after the run" };
        else if (!(mt >= runStartMs - 2000)) cacheOwnership = { ok: false, file, reason: "the file's mtime is older than the run start" };
        else cacheOwnership = { ok: true, file, reason: "created by this run (absent before, MISS + wrote in this job's log, newer than run start)" };
      } else {
        cacheOwnership = { ok: false, file: "", reason: "this run's cache lines were not exactly one sig/MISS/wrote" };
      }

      for (const f of ["proxy-bg.log"]) {
        const src = path.join(logDir, f);
        if (fs.existsSync(src)) fs.writeFileSync(path.join(ENV.out, "logs", f), redactAll(fs.readFileSync(src, "utf8")));
      }
      if (state.jobLog) fs.writeFileSync(path.join(ENV.out, "logs", "pipeline.log"), redactAll(state.jobLog));
    } catch (e) {
      phaseError = phaseError ?? (e as Error);
    }

    // ---- verdict --------------------------------------------------------------------------
    const input = {
      jobId, proxies: [], proxyTagExpected: "", expectedProxyCount: 0, timingRows: [], jobLog: null, jobLogMtimeMs: null,
      analysis: null, output: null, wallRenderS: null, trimmerFirstFrameMs: null, trimmerSignal: null,
      isolation: { qaProxiesLanded: false, qaTempLanded: false, qaDbLanded: false, realNewFiles: [] },
      ...state,
    } as AcceptanceInput;
    const rows = evaluate(input);
    const deep = (v: unknown): unknown => typeof v === "string" ? redactAll(v) : Array.isArray(v) ? v.map(deep)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deep(x)])) : v;
    const header: Record<string, string> = {
      "Run id": ENV.runId,
      "Resolution": ENV.res,
      "Cuts / sources": `${ENV.cuts} cuts from ${ENV.sources} excerpts of the owner's footage (read-only; excerpts are stream copies)`,
      "Negative control": ENV.brk ? `--break ${ENV.brk}` : "none",
      "Phases": phases.map((p) => `${p.name} ${p.seconds}s${p.ok ? "" : " FAILED: " + p.error}`).join("; "),
      "Render-cache entry": `${cacheOwnership.file || "none"} (${cacheOwnership.ok ? "owned by this run, safe to remove" : "NOT removed: " + cacheOwnership.reason})`,
      "Disclosed side effect": "the render cache is shared across all renders; this run's cache write also triggers the app's own prune there (keeps 20 entries, 7 days), so an old cached film of the owner's may be dropped (one slower re-render, never data loss)",
    };
    if (phaseError) header["Run error"] = phaseError.message;
    const md = renderReport(rows, header, QA_ROOT, [ENV.clips]);
    fs.writeFileSync(path.join(ENV.out, "report.md"), md);
    fs.writeFileSync(path.join(ENV.out, "report.json"), JSON.stringify({ header: deep(header), rows: deep(rows) }, null, 2));
    fs.writeFileSync(path.join(ENV.out, "verdict.json"), JSON.stringify({
      status: worstStatus(rows), exitCode: phaseError ? 1 : exitCodeFor(rows), cacheOwnership,
      keep: ENV.keep,
    }, null, 2));

    if (phaseError) throw phaseError;
    expect(exitCodeFor(rows)).toBe(0);
  });
});
