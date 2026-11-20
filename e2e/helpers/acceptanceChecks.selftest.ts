/**
 * Self-test for acceptanceChecks.ts (#237). No unit-test runner exists in this project:
 *
 *   pnpm exec tsx e2e/helpers/acceptanceChecks.selftest.ts
 *
 * Exit 0 = the happy fixture passes AND every doctored fixture fails exactly the row it should.
 * This proves the CHECKER can fail. It does not prove production emits these lines; the report
 * labels each row's proof level for that reason.
 */
import { evaluate, exitCodeFor, readProxyTag, redact, renderReport, type AcceptanceInput, type Row } from "./acceptanceChecks";

const START = Date.parse("2026-11-19T10:00:00Z");

const GOOD_LOG = [
  "[INFO] [cache] sig=abc123 (shuffle_between=False)",
  "[INFO] [cache] MISS abc123",
  "[INFO] [Q] encoder=h264_amf is_amf=True",
  "[INFO] [U1g] segmented render: 4 batches total=92.100 xfade_dur=0.500",
  "[INFO] [U1g] segment frames=2760 expected=2760 drift=0 frame(s) (0.0ms)",
  "[INFO] [U1g] segmented render complete (no fallback) batches=4 clips_total=20 mem_avail_mb=9000",
  "[INFO] [cache] wrote abc123.mp4 (400.0 MB)",
].join("\n");

const GOOD_ANALYSIS =
  "clips_used=20,clips_total=20,output_duration_s=92.1,total_s=250,proxy_used=20,proxy_skipped=0," +
  "output_resolution=4k,encoder=h264_amf,amf_fallback=0,render_cache=miss";

function good(): AcceptanceInput {
  return {
    jobId: "job-1", res: "4k", cutCount: 20, runStartMs: START,
    proxyTagExpected: "rc-proxy-v2-qp18",
    proxies: Array.from({ length: 6 }, (_, k) => ({ idx: k, tag: "rc-proxy-v2-qp18", height: 2160, rel: `appdata/p${k}.mp4` })),
    expectedProxyCount: 6,
    jobLog: GOOD_LOG, jobLogMtimeMs: START + 60_000,
    analysis: GOOD_ANALYSIS,
    timingRows: [{ ts: "2026-11-19T10:05:00.000000Z", resolution: "4k", encoder: "h264_amf", proxy_used: 20 }],
    output: { codec: "h264", width: 3840, height: 2160, durationS: 92.1 },
    wallRenderS: 260,
    trimmerFirstFrameMs: 800, trimmerSignal: "requestVideoFrameCallback",
    isolation: { qaProxiesLanded: true, qaTempLanded: true, qaDbLanded: true, realNewFiles: [] },
    ctx: { proxies: "warm", cache: "cold", transition: "crossfade", zoom: false },
    expectSegmented: true,
  };
}

let failures = 0;
const say = (ok: boolean, msg: string) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };
const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

// 1. happy path
{
  const rows = evaluate(good());
  say(exitCodeFor(rows) === 0, "happy fixture: exit 0");
  say(rows.every((r) => r.status === "PASS"), `happy fixture: all rows PASS (${rows.map((r) => r.id + ":" + r.status).join(" ")})`);
}

// 2. doctored fixtures: each must FAIL exactly the named row (and make the run exit non-zero)
type Mut = [name: string, row: string, apply: (i: AcceptanceInput) => void];
const mutations: Mut[] = [
  ["libx264 encoder at 4K (log + analysis)", "encoder", (i) => { i.jobLog = i.jobLog!.replace("encoder=h264_amf is_amf=True", "encoder=libx264 is_amf=False"); i.analysis = i.analysis!.replace("encoder=h264_amf", "encoder=libx264"); }],
  ["AMF unavailable at 4K with amf_fallback still 0 (the trap)", "encoder", (i) => { i.jobLog = i.jobLog!.replace("is_amf=True", "is_amf=False"); }],
  ["encoder line missing", "encoder", (i) => { i.jobLog = i.jobLog!.replace(/.*\[Q\] encoder=.*\n/, ""); }],
  ["encoder line duplicated", "encoder", (i) => { i.jobLog += "\n[INFO] [Q] encoder=h264_amf is_amf=True"; }],
  ["amf_fallback=1", "amf_fallback", (i) => { i.analysis = i.analysis!.replace("amf_fallback=0", "amf_fallback=1"); }],
  ["'(with fallback)' label", "amf_fallback", (i) => { i.jobLog = i.jobLog!.replace("(no fallback)", "(with fallback)"); }],
  ["amf_fallback malformed", "amf_fallback", (i) => { i.analysis = i.analysis!.replace("amf_fallback=0", "amf_fallback=x"); }],
  ["segment drift=2", "drift", (i) => { i.jobLog = i.jobLog!.replace("drift=0 frame(s)", "drift=2 frame(s)"); }],
  ["segmented but no drift line", "drift", (i) => { i.jobLog = i.jobLog!.replace(/.*segment frames=.*\n/, ""); }],
  ["segmented-render label vanished while segmentation is expected", "drift", (i) => { i.jobLog = i.jobLog!.replace(/.*segmented render:.*\n/, "").replace(/.*segment frames=.*\n/, ""); }],
  ["drift value malformed", "drift", (i) => { i.jobLog = i.jobLog!.replace("drift=0 frame(s)", "drift=? frame(s)"); }],
  ["cache HIT", "cache", (i) => { i.jobLog = i.jobLog!.replace("[cache] MISS abc123", "[cache] HIT abc123 -> abc123.mp4"); i.analysis = i.analysis!.replace("render_cache=miss", "render_cache=hit"); }],
  ["cache MISS line duplicated", "cache", (i) => { i.jobLog += "\n[INFO] [cache] MISS def456"; }],
  ["cache MISS line missing", "cache", (i) => { i.jobLog = i.jobLog!.replace("[INFO] [cache] MISS abc123\n", ""); }],
  ["render 700 s", "render_time", (i) => { i.analysis = i.analysis!.replace("total_s=250", "total_s=700"); }],
  ["render time missing", "render_time", (i) => { i.analysis = i.analysis!.replace("total_s=250,", ""); }],
  ["render time malformed", "render_time", (i) => { i.analysis = i.analysis!.replace("total_s=250", "total_s=abc"); }],
  ["one cut skipped its proxy", "proxy_used", (i) => { i.analysis = i.analysis!.replace("proxy_used=20,proxy_skipped=0", "proxy_used=19,proxy_skipped=1"); }],
  ["proxy tag stale", "proxy_tag", (i) => { i.proxies[2].tag = ""; }],
  ["proxy too small", "proxy_tag", (i) => { i.proxies[0].height = 1080; }],
  ["proxy missing", "proxy_tag", (i) => { i.proxies.pop(); }],
  ["output wrong size", "output", (i) => { i.output = { codec: "h264", width: 1920, height: 1080, durationS: 92.1 }; }],
  ["output missing", "output", (i) => { i.output = null; }],
  ["timing row missing", "timing_row", (i) => { i.timingRows = []; }],
  ["timing row stale (older than the run)", "timing_row", (i) => { i.timingRows = [{ ts: "2026-11-18T10:05:00.000000Z", resolution: "4k", encoder: "h264_amf", proxy_used: 20 }]; }],
  ["timing row duplicated", "timing_row", (i) => { i.timingRows.push({ ...i.timingRows[0] }); }],
  ["job log missing", "binding", (i) => { i.jobLog = null; i.jobLogMtimeMs = null; }],
  ["job log older than the run (stale)", "binding", (i) => { i.jobLogMtimeMs = START - 1000; }],
  ["analysis missing", "binding", (i) => { i.analysis = null; }],
  ["state landed outside the QA root", "isolation", (i) => { i.isolation.qaProxiesLanded = false; }],
  ["new file in a real location", "isolation", (i) => { i.isolation.realNewFiles = ["C:\\real\\rushcut\\proxies\\x.mp4"]; }],
];
for (const [name, rowId, apply] of mutations) {
  const i = good();
  apply(i);
  const rows = evaluate(i);
  const r = byId(rows, rowId);
  const code = exitCodeFor(rows);
  say(r.status === "FAIL" && code !== 0, `doctored (${name}): row '${rowId}' FAILs, exit ${code}`);
}

// 3. non-failing statuses
{
  const i = good(); i.trimmerFirstFrameMs = 4500;
  const rows = evaluate(i);
  say(byId(rows, "trimmer_ready").status === "WARN" && exitCodeFor(rows) === 0, "slow Trimmer first frame is WARN, not FAIL");
  const j = good(); j.analysis = j.analysis!.replace("total_s=250", "total_s=450");
  const r2 = evaluate(j);
  say(byId(r2, "render_time").status === "WARN" && exitCodeFor(r2) === 0, "render 450 s is WARN (5-10 minute band), exit 0");
  const k = good(); k.isolation.realNewFiles = null;
  say(byId(evaluate(k), "isolation").status === "WARN", "real-location check not runnable is WARN");
  const l = good(); l.expectSegmented = false; l.jobLog = l.jobLog!.replace(/.*segmented render:.*\n/, "").replace(/.*segment frames=.*\n/, "");
  say(byId(evaluate(l), "drift").status === "SKIP", "short project (segmentation not expected): drift row is SKIP");
  const m = good(); m.res = "1080p"; m.analysis = m.analysis!.replace(/h264_amf/, "libx264"); m.jobLog = m.jobLog!.replace("encoder=h264_amf is_amf=True", "encoder=libx264 is_amf=False");
  m.output = { codec: "h264", width: 1920, height: 1080, durationS: 92.1 }; m.timingRows = [{ ts: "2026-11-19T10:05:00.000000Z", resolution: "1080p", encoder: "libx264", proxy_used: 20 }];
  say(evaluate(m).every((r) => r.status === "PASS"), "1080p happy fixture (libx264 default) all PASS");
}

// 4. proxy tag constant is read from lib.rs text, not hard-coded
say(readProxyTag('const PROXY_TAG: &str = "rc-proxy-v9-qp20";') === "rc-proxy-v9-qp20", "readProxyTag reads the constant");
say(readProxyTag("nothing here") === null, "readProxyTag returns null when absent (caller must fail)");

// 5. redaction: no footage path, no user name, no QA root survives in the report
{
  const rep = renderReport(evaluate(good()), { Note: "C:\\Users\\SomeOne\\clips\\a.mp4 and /mnt/c/Users/SomeOne/x and C:\\rcqa\\r1\\temp\\rushcut\\a.log" }, "C:\\rcqa\\r1");
  say(!/SomeOne/.test(rep) && !/rcqa/i.test(rep) && rep.includes("<QA>") && rep.includes("<HOME>"), "report redacts user name, home paths and the QA root");
  say(redact("/mnt/c/rcqa/r1/temp/x", "C:\\rcqa\\r1") === "<QA>/temp/x", "WSL-form QA root is redacted too");
}

{
  const logged = '{"folder":"C:\\\\Users\\\\SomeOne\\\\AppData\\\\Local\\\\Temp\\\\rcqa\\\\r1\\\\film","p":"C:\\\\rcqa\\\\r1\\\\clips-r1","c":"D:\\\\Family 2026\\\\raw\\\\a.mp4"}';
  const red = redact(logged, "C:\\rcqa\\r1", ["D:\\Family 2026\\raw"]);
  say(!/SomeOne/.test(red) && !/Family/.test(red) && red.includes("<HOME>") && red.includes("<QA>") && !red.includes("C:\\\\rcqa"),
    "JSON-escaped (doubled-backslash) paths are redacted too (the wdio.log case)");
}

console.log(failures === 0 ? "\nALL SELFTESTS PASSED" : `\n${failures} SELFTEST FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
