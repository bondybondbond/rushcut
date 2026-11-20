/**
 * #237 acceptance-run checker. PURE: no wdio, no fs, no process. Takes what the spec harvested
 * and returns report rows. Fails CLOSED: a missing, duplicated or malformed line is a FAIL,
 * never a silent pass.
 *
 * Self-test (every check must FAIL on its doctored input):
 *   pnpm exec tsx e2e/helpers/acceptanceChecks.selftest.ts
 */

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface Row {
  id: string;
  check: string;
  expected: string;
  actual: string;
  status: Status;
  /** How strongly this row is proven (see the report legend). */
  proof: string;
  /** Verbatim log line(s) the verdict was read from ("" when none applies). */
  line: string;
}

export interface ProxyProbe { idx: number; tag: string; height: number; rel: string }

export interface AcceptanceInput {
  jobId: string;
  res: "4k" | "1080p";
  cutCount: number;
  runStartMs: number;
  /** PROXY_TAG constant read from src-tauri/src/lib.rs (never hard-coded here). */
  proxyTagExpected: string;
  proxies: ProxyProbe[];
  expectedProxyCount: number;
  /** pipeline-<jobId>.log text and its mtime (ms). null = file missing. */
  jobLog: string | null;
  jobLogMtimeMs: number | null;
  /** jobs.analysis_summary for this job id ("k=v,k=v"), null = missing. */
  analysis: string | null;
  /** Rows parsed from the QA instance's own render-timing-log.jsonl (fresh file per run). */
  timingRows: Array<Record<string, unknown>>;
  output: { codec: string; width: number; height: number; durationS: number } | null;
  wallRenderS: number | null;
  trimmerFirstFrameMs: number | null;
  trimmerSignal: string | null;
  /** True when the setup is known to produce a segmented render (the default 20-cut runs). */
  expectSegmented?: boolean;
  /** Diagnostic text about the Trimmer's video elements (shown when no frame was measured). */
  trimmerNote?: string;
  isolation: {
    qaProxiesLanded: boolean;
    qaTempLanded: boolean;
    qaDbLanded: boolean;
    /** New/changed files seen in the real locations; null = not checkable (another rushcut.exe alive). */
    realNewFiles: string[] | null;
  };
  /** Context stamped on the render-time row. */
  ctx: { proxies: "warm" | "cold"; cache: "warm" | "cold"; transition: string; zoom: boolean };
}

const PROXY_TAG_RE = /const\s+PROXY_TAG\s*:\s*&str\s*=\s*"([^"]+)"/;
export function readProxyTag(libRsText: string): string | null {
  const m = libRsText.match(PROXY_TAG_RE);
  return m ? m[1] : null;
}

export function parseAnalysis(s: string | null): Record<string, string> | null {
  if (!s || !s.includes("=")) return null;
  const out: Record<string, string> = {};
  for (const kv of s.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

function lines(log: string | null, re: RegExp): string[] {
  return (log ?? "").split(/\r?\n/).filter((l) => re.test(l));
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "" || !/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Number(v);
}

const row = (id: string, check: string, expected: string, actual: string, status: Status, proof: string, line = ""): Row =>
  ({ id, check, expected, actual, status, proof, line });

const P_LIVE = "live run";
const P_LIVE_FIX = "live run + fixture negative";
const P_FIX = "fixture only (not provable end to end)";
const P_REAL = "live run + real negative (--break stale-proxy)";

export function evaluate(i: AcceptanceInput): Row[] {
  const rows: Row[] = [];
  const A = parseAnalysis(i.analysis);

  // 0. evidence binding -------------------------------------------------------------------
  {
    const okLog = i.jobLog !== null && i.jobLog.length > 0 && /\[cache\] sig=/.test(i.jobLog);
    const fresh = i.jobLogMtimeMs !== null && i.jobLogMtimeMs >= i.runStartMs;
    const st: Status = okLog && fresh && A !== null ? "PASS" : "FAIL";
    rows.push(row("binding", "Evidence is this run's own",
      "job log pipeline-<jobId>.log present, newer than run start, with a cache line; analysis summary present",
      `log=${i.jobLog === null ? "missing" : okLog ? "ok" : "empty/unrecognised"}, fresh=${fresh}, analysis=${A === null ? "missing" : "ok"}`,
      st, P_LIVE_FIX, ""));
  }

  // 1. isolation proof --------------------------------------------------------------------
  {
    const f = i.isolation;
    const landed = f.qaProxiesLanded && f.qaTempLanded && f.qaDbLanded;
    let st: Status = "PASS";
    let actual = `QA root holds proxies=${f.qaProxiesLanded}, temp/logs=${f.qaTempLanded}, db=${f.qaDbLanded}; `;
    if (!landed) st = "FAIL";
    if (f.realNewFiles === null) {
      actual += "real-location check NOT run (another rushcut.exe was alive, or the pre-start baseline was missing)";
      if (st === "PASS") st = "WARN";
    } else if (f.realNewFiles.length > 0) {
      actual += `${f.realNewFiles.length} new/changed file(s) in real locations: ${f.realNewFiles.slice(0, 3).join("; ")}`;
      st = "FAIL";
    } else {
      actual += "0 new/changed files in real Roaming, Temp or MSIX-container locations";
    }
    rows.push(row("isolation", "Isolation proof", "all app state under the QA root; nothing new in the real locations", actual, st, P_LIVE_FIX));
  }

  // 2. proxies ----------------------------------------------------------------------------
  {
    const bad = i.proxies.filter((p) => p.tag !== i.proxyTagExpected || !(p.height >= 2160));
    const countOk = i.proxies.length === i.expectedProxyCount && i.proxies.length > 0;
    const st: Status = bad.length === 0 && countOk ? "PASS" : "FAIL";
    rows.push(row("proxy_tag", "Proxy version and height",
      `${i.expectedProxyCount} proxies, each tagged ${i.proxyTagExpected}, height >= 2160`,
      `${i.proxies.length} proxies; ${bad.length} wrong${bad.length ? " (" + bad.slice(0, 3).map((p) => `#${p.idx} tag=${p.tag || "none"} h=${p.height}`).join(", ") + ")" : ""}`,
      st, P_REAL));
  }

  // 3. proxy_used -------------------------------------------------------------------------
  {
    const used = num(A?.proxy_used), skipped = num(A?.proxy_skipped);
    const ok = used !== null && skipped !== null && used === i.cutCount && skipped === 0;
    rows.push(row("proxy_used", "Every cut used its proxy",
      `proxy_used=${i.cutCount}, proxy_skipped=0`,
      `proxy_used=${A?.proxy_used ?? "missing"}, proxy_skipped=${A?.proxy_skipped ?? "missing"}`,
      ok ? "PASS" : "FAIL", P_LIVE_FIX, i.analysis ? `ANALYSIS proxy_used=${A?.proxy_used},proxy_skipped=${A?.proxy_skipped}` : ""));
  }

  // 4. cache ------------------------------------------------------------------------------
  {
    const miss = lines(i.jobLog, /\[cache\] MISS /);
    const hit = lines(i.jobLog, /\[cache\] HIT /);
    const ok = miss.length === 1 && hit.length === 0 && A?.render_cache === "miss";
    rows.push(row("cache", "Render really encoded (cache MISS)",
      "exactly one '[cache] MISS', no '[cache] HIT', render_cache=miss",
      `MISS lines=${miss.length}, HIT lines=${hit.length}, render_cache=${A?.render_cache ?? "missing"}`,
      ok ? "PASS" : "FAIL", P_LIVE_FIX, miss[0] ?? hit[0] ?? ""));
  }

  // 5. encoder ----------------------------------------------------------------------------
  {
    const want = i.res === "4k" ? "h264_amf" : "libx264";
    const qLines = lines(i.jobLog, /\[Q\] encoder=/);
    const m = qLines.length === 1 ? qLines[0].match(/encoder=(\S+) is_amf=(True|False)/) : null;
    const logEnc = m ? m[1] : null;
    const ok = !!m && logEnc === want && (want !== "h264_amf" || m[2] === "True") && A?.encoder === want;
    rows.push(row("encoder", "Intended encoder was used",
      `encoder=${want}${want === "h264_amf" ? " is_amf=True" : " (default 1080p path)"} in the log AND the analysis`,
      `log=${logEnc ?? (qLines.length === 0 ? "missing" : qLines.length > 1 ? "duplicate" : "malformed")}, analysis=${A?.encoder ?? "missing"}`,
      ok ? "PASS" : "FAIL", P_LIVE_FIX, qLines[0] ?? ""));
  }

  // 6. fallback ---------------------------------------------------------------------------
  {
    const withFb = lines(i.jobLog, /\(with fallback\)/);
    const fb = num(A?.amf_fallback);
    const ok = fb === 0 && withFb.length === 0;
    rows.push(row("amf_fallback", "No silent encoder fallback",
      "amf_fallback=0 and no '(with fallback)' line",
      `amf_fallback=${A?.amf_fallback ?? "missing"}, 'with fallback' lines=${withFb.length}`,
      ok ? "PASS" : "FAIL", P_FIX, withFb[0] ?? ""));
  }

  // 7. drift ------------------------------------------------------------------------------
  {
    const segmented = lines(i.jobLog, /\[U1g\] segmented render:/).length > 0;
    const seg = lines(i.jobLog, /\[U1g\] segment frames=/);
    const oc = lines(i.jobLog, /\[U1g\] boundary-only open\/close frames=/);
    if (!segmented) {
      // The default 20-cut setup is always segmented. If that label disappears (renamed log line,
      // changed threshold) drift checking must not go silent: that is a FAIL, not a SKIP.
      rows.push(i.expectSegmented
        ? row("drift", "Frame drift is zero", "a '[U1g] segmented render:' line (this setup is always segmented), then drift=0 lines",
            "no segmented-render line in the log", "FAIL", P_FIX)
        : row("drift", "Frame drift", "n/a: no frame-drift line is emitted unless the render is segmented",
            "render was not segmented", "SKIP", P_FIX));
    } else {
      const vals = [...seg, ...oc].map((l) => { const m = l.match(/drift=(\d+) frame/); return m ? Number(m[1]) : NaN; });
      const ok = seg.length >= 1 && vals.every((v) => v === 0);
      rows.push(row("drift", "Frame drift is zero",
        "every '[U1g] segment ... drift=0' (and boundary) line, at least one present",
        `${seg.length} segment line(s), ${oc.length} boundary line(s), drift values=[${vals.join(",")}]`,
        ok ? "PASS" : "FAIL", P_FIX, seg[0] ?? ""));
    }
  }

  // 8. output file ------------------------------------------------------------------------
  {
    const [w, h] = i.res === "4k" ? [3840, 2160] : [1920, 1080];
    const dur = num(A?.output_duration_s);
    const o = i.output;
    const ok = !!o && o.codec === "h264" && o.width === w && o.height === h && dur !== null && Math.abs(o.durationS - dur) <= 1.0;
    rows.push(row("output", "Output file is what was asked for",
      `h264 ${w}x${h}, duration within 1 s of the analysis (${A?.output_duration_s ?? "?"} s)`,
      o ? `${o.codec} ${o.width}x${o.height}, ${o.durationS.toFixed(1)} s` : "no output probed",
      ok ? "PASS" : "FAIL", P_LIVE));
  }

  // 9. render time ------------------------------------------------------------------------
  {
    const t = num(A?.total_s);
    const st: Status = t === null ? "FAIL" : t <= 300 ? "PASS" : t <= 600 ? "WARN" : "FAIL";
    const c = i.ctx;
    rows.push(row("render_time", "Render time",
      "t_total_s <= 300 PASS, <= 600 WARN, > 600 FAIL",
      `t_total_s=${A?.total_s ?? "missing"}, click-to-done wall=${i.wallRenderS === null ? "n/a" : i.wallRenderS.toFixed(0) + " s"}; ` +
      `proxies ${c.proxies}, cache ${c.cache}, transition ${c.transition}, zoom ${c.zoom ? "on" : "off"}; ` +
      `DISPOSABLE PROJECT, NOT THE REFERENCE FILM (do not cite against the 5/10 minute target)`,
      st, P_LIVE_FIX));
  }

  // 10. timing row ------------------------------------------------------------------------
  {
    const startIso = new Date(i.runStartMs).toISOString();
    const fresh = i.timingRows.filter((r) => typeof r.ts === "string" && (r.ts as string) >= startIso.slice(0, 19));
    const r = fresh.length === 1 ? fresh[0] : null;
    const ok = !!r && r.resolution === i.res && r.encoder === (A?.encoder ?? "?") && num(String(r.proxy_used)) === i.cutCount;
    rows.push(row("timing_row", "Timing log row written for this run",
      `exactly one fresh row, resolution=${i.res}, encoder and proxy_used matching the analysis`,
      fresh.length === 1 ? `1 row: resolution=${r!.resolution}, encoder=${r!.encoder}, proxy_used=${r!.proxy_used}` : `${fresh.length} fresh rows`,
      ok ? "PASS" : "FAIL", P_LIVE_FIX));
  }

  // 11. trimmer readiness -----------------------------------------------------------------
  {
    const t = i.trimmerFirstFrameMs;
    const st: Status = t === null ? "WARN" : t <= 3000 ? "PASS" : "WARN";
    rows.push(row("trimmer_ready", "Trimmer shows a frame promptly",
      "first presented video frame within 3000 ms (WARN only until a baseline exists)",
      t === null ? `not measured${i.trimmerNote ? " (" + i.trimmerNote + ")" : ""}` : `${Math.round(t)} ms (signal: ${i.trimmerSignal ?? "unknown"}, clock from route entry)`,
      st, P_LIVE));
  }

  return rows;
}

export function worstStatus(rows: Row[]): Status {
  if (rows.some((r) => r.status === "FAIL")) return "FAIL";
  if (rows.some((r) => r.status === "WARN")) return "WARN";
  return "PASS";
}

/** Process exit code: non-zero on any FAIL; WARN and SKIP do not fail the run. */
export function exitCodeFor(rows: Row[]): number {
  return rows.some((r) => r.status === "FAIL") ? 1 : 0;
}

/** Strip anything that could carry a footage path or the user name before a report is written. */
export function redact(text: string, qaRoot: string, extra: string[] = []): string {
  let t = text;
  // A literal backslash in a target matches ONE OR TWO backslashes in the text: tool logs (WDIO)
  // print Windows paths JSON-escaped, e.g. C:\\Users\\name\\...
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\/g, "\\\\{1,2}");
  const wslForm = qaRoot.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
  for (const p of [qaRoot, qaRoot.replace(/\\/g, "/"), wslForm, ...extra]) {
    if (p) t = t.replace(new RegExp(esc(p), "gi"), "<QA>");
  }
  t = t.replace(/[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"';]+/g, "<HOME>");
  t = t.replace(/\/mnt\/[a-z]\/Users\/[^/\s"';]+/g, "<HOME>");
  return t;
}

export function renderReport(rows: Row[], header: Record<string, string>, qaRoot: string, extra: string[] = []): string {
  const cell = (s: string) => redact(s, qaRoot, extra).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const out: string[] = [];
  out.push(`# RushCut acceptance run: ${worstStatus(rows)}`, "");
  for (const [k, v] of Object.entries(header)) out.push(`- **${k}:** ${redact(v, qaRoot, extra)}`);
  out.push("", "| Check | Expected | Actual | Result | Proof level |", "|---|---|---|---|---|");
  for (const r of rows) out.push(`| ${cell(r.check)} | ${cell(r.expected)} | ${cell(r.actual)} | **${r.status}** | ${cell(r.proof)} |`);
  out.push("", "## Log lines read", "");
  for (const r of rows) if (r.line) out.push(`- ${r.id}: \`${redact(r.line, qaRoot, extra).replace(/`/g, "'")}\``);
  out.push("", "Proof levels: 'live run' = read from this real run. 'fixture negative' = the checker is also proven to FAIL on a doctored input.",
    "'fixture only' = the failing side cannot be produced in a real run without a product contract change (a real forced encoder fallback needs a new manifest field), so only the parser is proven.", "");
  return out.join("\n");
}
