import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Check, Play, Folder, RotateCcw } from "lucide-react";
import type { ProjectWithClips, JobConfig, PipelineProgressEvent, Job } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";
import { buildJobConfig, readTransitionConfig } from "@/utils/buildJobConfig";
import { getRenderPref, setRenderPref, removeRenderPref } from "@/utils/renderStore";
import { absoluteDateTime } from "@/utils/timeAgo";
import { resLabel, durationLabel } from "@/utils/jobMeta";

// T5: metadata shown on the film/done view. `iso` is the render timestamp,
// `analysisDuration` is the pipeline-reported duration used only as a fallback
// when the real <video> element duration is unavailable (file missing).
type DoneMeta = { iso: string | null; res: string | null; analysisDuration: string | null };

// Basename of a Windows path, e.g. "C:\clips\processed\clips-01.mp4" -> "clips-01.mp4".
function pathBasename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

// Directory portion of a Windows path, preserving original separators.
function pathDirname(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep);
  parts.pop();
  return parts.join(sep);
}

// Compact date+time for the stats card, e.g. "13 Jun · 15:16".
function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--";
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

// Seconds -> "m:ss" (floored to match the native video control's displayed total).
function fmtDuration(sec: number): string {
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

// T5: render situation returned by get_render_status_cmd.
type RenderStatusResult = { active_job: Job | null; latest_render: Job | null };

const STAGE_LABELS: Record<string, string> = {
  normalise:    "Normalising clips...",
  silence_trim: "Trimming silence...",
  zoom:         "Applying zoom...",
  cards:        "Adding title cards...",
  render:       "Rendering transitions...",
  music:        "Mixing music...",
  loudnorm:     "Loudness normalisation...",
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

type Phase = "ready" | "starting" | "rendering" | "done" | "error";

type ProxyReadiness = {
  ready: number;
  total: number;
  blocking_clip_ids: string[];
  target_fps_int: number;
};

export default function Render() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const _cached = projectCache.get(projectId ?? "");
  const _cachedIncluded = (_cached?.clips ?? []).filter(c => c.include !== 0);
  const [inFilmCount, setInFilmCount] = useState(_cachedIncluded.length);
  const [totalMs, setTotalMs] = useState(_cachedIncluded.reduce((s, c) => s + Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0)), 0));
  const [phase, setPhase] = useState<Phase>("starting");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Starting up the magic...");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>(_cached?.name ?? "");

  const [has4K, setHas4K] = useState(false);
  const [outputRes, setOutputRes] = useState<"1080p" | "4k">(() => {
    try {
      const stored = getRenderPref(`rc_render_res_${projectId}`);
      return stored === "4k" ? "4k" : "1080p";
    } catch {
      return "1080p";
    }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [doneMeta, setDoneMeta] = useState<DoneMeta | null>(null);
  // T5: true once the output file fails to LOAD (deleted from disk). Duration
  // captured from the actual <video> element so it matches the player exactly.
  // videoLoadedRef tracks whether loadedmetadata fired for the current src —
  // if it did, onError is a WebView2 decode crash (high-bitrate 4K), not a
  // missing file. Reset whenever outputPath changes.
  const [videoMissing, setVideoMissing] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const videoLoadedRef = useRef(false);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);

  const startTimeRef = useRef<number>(Date.now());
  const [elapsedLabel, setElapsedLabel] = useState("0s");
  const completedRef = useRef(false);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // U1e: stalled-render detection. lastProgressAtRef tracks the wall-clock time of
  // the last pipeline-progress OR pipeline-stage event while rendering. A separate
  // interval flips `stalled` true when no liveness signal has arrived for 120s, so
  // the user isn't left staring at a running timer against a frozen bar.
  // NOTE: useRef re-initialises on REMOUNT (route transition back to /render/:id),
  // not just re-render -- this Date.now() default is only a safe seed; the real
  // value is corrected inside the load effect's re-attach branch (from updated_at).
  // Do not move that seed into render-body / useState init.
  const lastProgressAtRef = useRef<number>(Date.now());
  const [stalled, setStalled] = useState(false);
  // U4f: stage-aware stall threshold. The cold zoom stage emits one STAGE:zoom then
  // encodes silently (no PROGRESS) for up to ~7 min on a large project, which trips a
  // fixed 360s threshold falsely. On STAGE:zoom we extend this to 1 min/clip
  // (floor 360s, cap 600s). Reset to 360s when the render ends.
  const maxStallMsRef = useRef<number>(360_000);
  // U4f: inFilmCount mirror — the pipeline-stage listener is registered once, so a
  // bare `inFilmCount` read inside it would be a stale closure. Always read .current.
  const inFilmCountRef = useRef<number>(inFilmCount);
  useEffect(() => { inFilmCountRef.current = inFilmCount; }, [inFilmCount]);

  // Batch R: proxy-readiness gate state. Render only auto-starts once every
  // include=1 clip has a proxy that matches render.py's reuse gate; otherwise
  // we fall into the 504s full-normalise path documented in the timing log.
  const [proxyReady, setProxyReady] = useState(0);
  const [proxyTotal, setProxyTotal] = useState(0);
  const [proxyElapsedLabel, setProxyElapsedLabel] = useState("0s");
  const waitStartRef = useRef<number>(0);
  const waitStartReadyRef = useRef<number>(0);
  // U1b: stall detector — tracks last time proxyReady advanced; used to force-unblock
  // if no progress for >45s (handles 'encoding' stuck claims that survive the Rust reset).
  const stallRef = useRef<{ lastReady: number; lastAdvanceMs: number }>({ lastReady: -1, lastAdvanceMs: 0 });
  // T3: proxy wait is now the first sub-stage of the rendering progress bar
  // (no separate "awaiting-proxies" screen). The synchronisation barrier is
  // preserved -- the actual job still does not start until proxies are ready.
  const [preparing, setPreparing] = useState(false);

  const configured = useConfiguredTabs(projectId ?? "");

  const transitionVal = (() => {
    try {
      const tc = readTransitionConfig(projectId ?? "");
      return tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null);
    } catch { return null; }
  })();
  const soundMoodVal = (() => {
    try {
      const raw = getRenderPref(`rc_sound_${projectId}`);
      return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null;
    } catch { return null; }
  })();

  function handleResSelect(res: "1080p" | "4k") {
    setOutputRes(res);
    setRenderPref(`rc_render_res_${projectId}`, res);
  }

  function onResizePointerDown(e: React.PointerEvent) {
    const el = videoContainerRef.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = { startY: e.clientY, startH: el.getBoundingClientRect().height };
  }

  function onResizePointerMove(e: React.PointerEvent) {
    if (!resizeDragRef.current) return;
    const delta = e.clientY - resizeDragRef.current.startY;
    const maxH = window.innerHeight * 0.7;
    const next = Math.max(200, Math.min(maxH, resizeDragRef.current.startH + delta));
    setVideoHeight(next);
  }

  function onResizePointerUp() {
    resizeDragRef.current = null;
  }

  async function startRenderNow(pid: string) {
    const config = buildJobConfig(pid);
    setPhase("starting");
    // U1d: the moment we commit to handing the job to the pipeline, drop the
    // "pending render" intent flag. start_job runs in Rust regardless of an
    // unmount, so once we're past this point the job WILL be created -- a resume
    // on the next mount must NOT submit a second one (double-submit guard).
    removeRenderPref(`rc_render_pending_${pid}`);
    try {
      const newJobId = await invoke<string>("start_job", {
        projectId: pid,
        settingsJson: JSON.stringify(config),
      });
      setJobId(newJobId);
      setStage("Starting up the magic...");
      setProgress(0);
      // U1: seed the timer start for a brand-new render. The timer effect no
      // longer resets startTimeRef on entering "rendering" (so re-attach can
      // continue the original timer) -- fresh starts seed it here instead.
      startTimeRef.current = Date.now();
      setElapsedLabel("0s");
      // U1e: brand-new render has no prior activity -- seed the stall clock now.
      lastProgressAtRef.current = Date.now();
      // U4f: fresh render starts at the baseline threshold (extended later on STAGE:zoom).
      maxStallMsRef.current = 360_000;
      setStalled(false);
      setPhase("rendering");
    } catch (e) {
      removeRenderPref(`rc_render_pending_${pid}`);
      setErrorMsg(`Failed to start render: ${e}`);
      setPhase("error");
    }
  }

  // Batch R: gate render on proxy readiness. Returns true once proceeding to
  // actual job submit. If clips are blocking, transitions to "awaiting-proxies"
  // and lets the polling effect drive the transition.
  async function submitJob(pid: string, is4kOverride?: boolean) {
    // U1d: the mount-effect resume path calls this before the has4K state has
    // settled, so it passes the freshly-loaded value. All other callers fire
    // after has4K is set and can rely on the closure.
    const is4k = is4kOverride ?? has4K;
    // U4d: backstop zoom warm — covers done-project direct opens (Smart Open routes
    // straight to /render, skipping Trimmer's entry warm). Fire-and-forget, once per
    // submit attempt; the Rust {project_id}:zoom guard dedupes against any Trimmer fire.
    // Does NOT gate the render — it warms in parallel for this and the next render.
    if (inFilmCount > 0) {
      invoke("warm_zoom_cache_cmd", { projectId: pid }).catch(() => {});
    }
    // T5: show the spinner immediately on entry. The proxy-readiness round-trip
    // (and, for a partial-proxy 4K render, the wait that follows) can take a few
    // seconds; without this the 4K gate stayed on screen and the button looked
    // stuck. The gate itself is only ever shown BEFORE submitJob is called.
    setPhase("starting");
    try {
      const status = await invoke<ProxyReadiness>("get_proxy_readiness_cmd", {
        projectId: pid,
        outputResolution: outputRes,
      });
      setProxyReady(status.ready);
      setProxyTotal(status.total);
      // Skip gate when all proxies ready.
      // Skip gate when cold AND non-4K (normalise is fast enough at 1080p).
      // For cold 4K renders, always gate: background proxies are in flight and
      // the normalise penalty (169s) dwarfs the wait time. Batch S2.
      if (status.ready >= status.total || (status.ready === 0 && !is4k)) {
        await startRenderNow(pid);
        return;
      }
      // T3: proxies still building. Fire ONE normal-priority boost then poll
      // in the background. Phase stays "starting" (spinner) — the render bar
      // only appears once startRenderNow() is called when all proxies land.
      waitStartRef.current = Date.now();
      waitStartReadyRef.current = status.ready;
      stallRef.current = { lastReady: -1, lastAdvanceMs: 0 }; // U1b: reset stall tracker
      // U1d: we are about to wait for proxies before start_job is ever called.
      // If the user navigates away now, the polling effect (the only caller of
      // start_job on this path) is torn down and the render is silently lost.
      // Persist the intent so the next mount resumes it -- diagnosed cold-path bug.
      setRenderPref(`rc_render_pending_${pid}`, "1");
      invoke("generate_proxies_cmd", { projectId: pid, lowPriority: false }).catch(console.error);
      setPreparing(true);
    } catch (e) {
      console.error("[render] readiness check failed, proceeding without gate", e);
      await startRenderNow(pid);
    }
  }

  // T5: show an already-completed render (from get_render_status_cmd or a fresh
  // pipeline-done). Duration comes from the <video> element on load; the
  // analysis value is only a fallback for the missing-file case.
  function applyLatestRender(job: Job) {
    setOutputPath(job.local_output_path);
    const res = resLabel(job);
    setDoneMeta({ iso: job.updated_at, res, analysisDuration: durationLabel(job) });
    // Sync outputRes to the actual rendered resolution so the done-state shows
    // the correct UI path (4K placeholder vs in-app <video> player).
    if (res === "4K") setOutputRes("4k");
    setVideoMissing(false);
    setVideoDuration(null);
    videoLoadedRef.current = false;
    setProgress(100);
    setPhase("done");
  }

  // T5: explicit "Render new version" — clears the current film view and starts
  // a brand-new render (respecting the 4K gate). Replaces the old auto-on-mount
  // behaviour so a previous render is never silently clobbered.
  async function startNewVersion() {
    if (!projectId || inFilmCount === 0) return;
    setOutputPath(null);
    setDoneMeta(null);
    setVideoMissing(false);
    setVideoDuration(null);
    videoLoadedRef.current = false;
    setJobId(null);
    setProgress(0);
    setStage("Starting up the magic...");
    setErrorMsg(null);
    setElapsedLabel("0s");
    completedRef.current = false;
    if (has4K) {
      setPhase("ready");
      return;
    }
    await submitJob(projectId);
  }

  // U4g: cancel the in-flight render. Kills the WSL pipeline process group and
  // cleans its working dirs (Rust); the existing pipeline-error listener then
  // flips this screen into the error phase (with "Try Again").
  async function cancelRender() {
    if (!jobId) return;
    const ok = await confirm("Cancel this render? Your clips are safe.", {
      title: "Cancel render",
      kind: "warning",
    });
    if (!ok) return;
    await invoke("cancel_render_cmd", { jobId }).catch((e) =>
      console.error("cancel_render_cmd failed:", e),
    );
  }

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    Promise.all([
      invoke<ProjectWithClips>("get_project", { projectId }),
      invoke<boolean>("has_4k_clips_cmd", { projectId }).catch(() => false as boolean),
      invoke<RenderStatusResult>("get_render_status_cmd", { projectId }).catch(
        () => ({ active_job: null, latest_render: null }) as RenderStatusResult,
      ),
    ]).then(async ([data, is4K, status]) => {
      if (cancelled) return;

      projectCache.set(projectId, { name: data.project.name, clips: data.clips });
      const included = data.clips.filter((c) => c.include !== 0);
      const count = included.length;
      const ms = included.reduce((sum, c) => {
        const start = c.in_ms ?? 0;
        const end = c.out_ms ?? c.duration_ms;
        return sum + Math.max(0, end - start);
      }, 0);
      setInFilmCount(count);
      setTotalMs(ms);
      setProjectName(data.project.name);
      setHas4K(is4K);

      // T5: a render already in flight -> re-attach to its live progress.
      // U1: also restore the stage label and continue the elapsed timer from
      // the job's real start, instead of resetting to "Starting up..." + 0s.
      if (status.active_job) {
        // U1d: a live job exists -> the intent is fulfilled; drop any pending flag
        // so the resume branch below never double-submits.
        removeRenderPref(`rc_render_pending_${projectId}`);
        setProgress(status.active_job.progress_pct);
        setJobId(status.active_job.id);
        // stageLabel("") returns "" (raw-string fallthrough), so || keeps a
        // human label only when stage is genuinely unknown (job started, no
        // STAGE: line emitted yet).
        setStage(stageLabel(status.active_job.current_stage ?? "") || "Starting up...");
        const startedAt = Date.parse(status.active_job.created_at);
        startTimeRef.current = Number.isNaN(startedAt) ? Date.now() : startedAt;
        // Show the continued elapsed value immediately (avoid a 1s "0s" flash).
        const sec = Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000));
        setElapsedLabel(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
        // U1e: seed the stall clock from the job's LAST activity, not Date.now().
        // update_job_progress + update_job_stage both bump updated_at, so this is a
        // true "last pipeline activity" timestamp -- a render that stalled before the
        // user returned then surfaces the warning on the next 30s check instead of
        // being masked for a fresh 120s. This runs inside the load effect (post-mount),
        // so it overwrites the useRef Date.now() default before the interval fires.
        const lastActivity = Date.parse(status.active_job.updated_at);
        lastProgressAtRef.current = Number.isNaN(lastActivity) ? Date.now() : lastActivity;
        setStalled(false);
        setPhase("rendering");
        return;
      }

      // U1d: the user committed to a render but navigated away during the
      // proxy-gate wait, before start_job was ever called -> no job exists
      // (diagnosed cold-path bug). Resume it instead of showing the stale done
      // state. submitJob re-checks proxy readiness + the persisted resolution,
      // so it either starts immediately (warm) or re-enters the wait (cold).
      // Checked AFTER active_job (no double-submit) but BEFORE latest_render
      // (the new render takes precedence over the previous film).
      if (getRenderPref(`rc_render_pending_${projectId}`) === "1" && count > 0) {
        await submitJob(projectId, is4K);
        return;
      }

      // T5: a completed render exists -> show it. Rendering a new version is an
      // explicit action; we never silently re-render. Works from the editor flow
      // AND Library, and survives navigating away and back.
      if (status.latest_render) {
        applyLatestRender(status.latest_render);
        return;
      }

      // No renders yet -> first-render flow.
      if (count === 0) {
        setErrorMsg("No clips in film -- go back to Trimmer and add some.");
        setPhase("error");
        return;
      }

      if (is4K) {
        setPhase("ready");
        return;
      }

      await submitJob(projectId);
    }).catch(() => {
      if (cancelled) return;
      setErrorMsg("Failed to load project -- go back and try again.");
      setPhase("error");
    });

    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!jobId) return;

    completedRef.current = false;

    function resetActivityTimer() {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      activityTimerRef.current = setTimeout(() => {
        if (!completedRef.current) {
          setPhase("error");
          setErrorMsg("Pipeline timed out -- check WSL2 is running");
        }
      }, 10 * 60 * 1000);
    }
    resetActivityTimer();

    const unlistenProgress = listen<PipelineProgressEvent>("pipeline-progress", (event) => {
      if (event.payload.jobId !== jobId) return;
      setProgress(event.payload.progress);
      // U1e: liveness signal -- refresh the stall clock and clear any warning.
      lastProgressAtRef.current = Date.now();
      setStalled(false);
    });

    const unlistenStage = listen<{ jobId: string; stage: string }>("pipeline-stage", (event) => {
      if (event.payload.jobId !== jobId) return;
      setStage(stageLabel(event.payload.stage));
      resetActivityTimer();
      // U4f: the cold zoom stage encodes silently (no PROGRESS) -- extend the stall
      // threshold to 1 min/clip (floor 360s, cap 600s) so it never trips falsely.
      // Read inFilmCountRef.current (this listener is registered once -> stale closure).
      if (event.payload.stage === "zoom") {
        maxStallMsRef.current = Math.min(600_000, Math.max(360_000, inFilmCountRef.current * 60_000));
      }
      // U1e: a stage transition is also liveness -- long xfade stages emit no
      // progress for 2-3 min, so counting stage events here prevents false stalls.
      lastProgressAtRef.current = Date.now();
      setStalled(false);
    });

    const unlistenDone = listen<PipelineProgressEvent & { analysis?: string | null }>("pipeline-done", (event) => {
      if (event.payload.jobId !== jobId) return;
      completedRef.current = true;
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      setProgress(100);
      setOutputPath(event.payload.outputPath ?? null);
      setPhase("done");
      // U4e: AMF auto-enables for 4K (no UI toggle). Surface a silent
      // AMF -> libx264 fallback as a toast so the user knows GPU encode
      // was unavailable and the render fell back to CPU at standard quality.
      const analysis = event.payload.analysis;
      // T5: capture metadata for the freshly-finished render. Duration here is
      // the analysis fallback; the <video> element overrides it on load.
      setVideoMissing(false);
      setVideoDuration(null);
      videoLoadedRef.current = false;
      setDoneMeta({
        iso: new Date().toISOString(),
        res: outputRes === "4k" ? "4K" : "1080p",
        analysisDuration: durationLabel({ analysis_summary: analysis ?? null }),
      });
      if (analysis && /(^|,)amf_fallback=1(,|$)/.test(analysis)) {
        setToast("GPU encode unavailable -- rendered on CPU (standard quality)");
        setTimeout(() => setToast(null), 6000);
      }
      if (projectId) {
        invoke("generate_proxies_cmd", { projectId }).catch(console.error);
      }
    });

    const unlistenError = listen<PipelineProgressEvent>("pipeline-error", (event) => {
      if (event.payload.jobId !== jobId) return;
      completedRef.current = true;
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      setErrorMsg(event.payload.message || "Render failed");
      setPhase("error");
    });

    return () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      unlistenProgress.then((f) => f());
      unlistenStage.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, [jobId, projectId]);

  useEffect(() => {
    if (phase !== "rendering") return;
    // U1: do NOT reset startTimeRef here. A fresh render seeds it in
    // startRenderNow; a resume seeds it from the job's created_at on re-attach.
    // Resetting here unconditionally restarted the timer at 0s on every resume.
    const interval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedLabel(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
    }, 1000);
    // U1e: every 30s, flag a stall if no progress/stage event for >360s. This does
    // NOT change phase (the render may still be alive) -- it only surfaces a soft
    // warning. The 360s window is reset by both pipeline-progress and pipeline-stage.
    // U4: threshold raised from 120s to 360s -- a cold zoom stage runs up to 8 min
    // without emitting PROGRESS (one STAGE:zoom at start, then silent encode). With
    // the bg warm cache in place this should be <5s, but keep a generous threshold
    // for cold first-runs to avoid false stall warnings.
    const stallCheck = setInterval(() => {
      // U4f: threshold is stage-aware (extended during the cold zoom stage).
      if (Date.now() - lastProgressAtRef.current > maxStallMsRef.current) setStalled(true);
    }, 30_000);
    return () => {
      clearInterval(interval);
      clearInterval(stallCheck);
      // U1e: leaving "rendering" (done/error) clears any standing stall warning.
      setStalled(false);
      // U4f: reset the stage-aware threshold back to baseline for the next render.
      maxStallMsRef.current = 360_000;
    };
  }, [phase]);

  // Batch R+S: poll proxy readiness and listen to proxy-progress while in the
  // awaiting-proxies wait state. Elapsed timer ticks every second.
  useEffect(() => {
    if (!preparing || !projectId) return;
    let cancelled = false;

    async function check(): Promise<boolean> {
      try {
        const status = await invoke<ProxyReadiness>("get_proxy_readiness_cmd", {
          projectId: projectId!,
          outputResolution: outputRes,
        });
        if (cancelled) return true;
        setProxyReady(status.ready);
        setProxyTotal(status.total);

        if (status.ready >= status.total && status.total > 0) {
          // All proxies ready: start the render. Phase transitions from
          // "starting" (spinner) to "rendering" (progress bar) inside startRenderNow.
          setPreparing(false);
          startRenderNow(projectId!);
          return true;
        }

        // U1b stall detector: if proxyReady hasn't advanced in 45s, force-reset
        // stuck encoding claims and re-fire the boost. Covers the case where
        // a dead FFmpeg process left claims in 'encoding' that the Rust startup
        // reset didn't catch (claims were < 900s old at restart time).
        const now = Date.now();
        if (status.ready !== stallRef.current.lastReady) {
          stallRef.current = { lastReady: status.ready, lastAdvanceMs: now };
        } else if (stallRef.current.lastAdvanceMs > 0 && now - stallRef.current.lastAdvanceMs > 300_000) {
          console.warn("[render] proxy stall detected — resetting encoding claims and retrying");
          stallRef.current = { lastReady: -1, lastAdvanceMs: 0 };
          await invoke("reset_proxy_encoding_cmd", { projectId: projectId! }).catch(console.error);
          await invoke("generate_proxies_cmd", { projectId: projectId!, lowPriority: false }).catch(console.error);
        } else if (stallRef.current.lastAdvanceMs === 0) {
          stallRef.current = { lastReady: status.ready, lastAdvanceMs: now };
        }
      } catch (e) {
        console.error("[render] readiness poll failed", e);
      }
      return false;
    }

    check();
    const interval = setInterval(check, 2000);

    // Tick the elapsed label once per second so the user can see progress is happening.
    const elapsedTick = setInterval(() => {
      const sec = Math.floor((Date.now() - waitStartRef.current) / 1000);
      setProxyElapsedLabel(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
    }, 1000);

    const unlistenProxy = listen<{ projectId: string; clipId: string; winPath: string }>(
      "proxy-progress",
      (event) => {
        if (event.payload.projectId !== projectId) return;
        check();
      },
    );

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(elapsedTick);
      unlistenProxy.then((f) => f());
    };
  }, [preparing, projectId, outputRes]);

  const assetUrl = outputPath ? convertFileSrc(outputPath) : null;
  // T5: always the REAL output file name (e.g. "clips-01.mp4"), never the
  // project name -- the project "clips" renders to "clips-01.mp4".
  const displayName = outputPath ? pathBasename(outputPath) : null;
  // Duration prefers the live <video> element (matches the player); falls back
  // to the pipeline-reported value when the file is missing.
  const durationDisplay = videoDuration != null ? fmtDuration(videoDuration) : (doneMeta?.analysisDuration ?? null);

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={inFilmCount}
      totalMs={totalMs}
      activeTab="render"
      configured={configured}
      transitionValue={transitionVal}
      soundMood={soundMoodVal}
    >
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">

          <h1 className="text-3xl font-semibold text-[#FF8A65]">
            {phase === "done" ? "Your film" : "Render Your Film"}
          </h1>

          {/* Ready — 4K gate */}
          {phase === "ready" && (
            <div className="space-y-6">
              <div className="border border-white/15 rounded-lg p-6 space-y-4">
                <div>
                  <p className="text-xl font-medium text-[#e5e5e5]">Output Resolution</p>
                  <p className="text-sm text-[#a3a3a3] mt-0.5">
                    Your project contains 4K clips. Choose your output resolution before rendering.
                  </p>
                </div>
                <div className="flex gap-3">
                  {(["1080p", "4k"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      data-testid={`chip-res-${r}`}
                      onClick={() => handleResSelect(r)}
                      className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                        outputRes === r
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      {r === "4k" ? "4K" : "1080p"}
                    </button>
                  ))}
                </div>
              </div>

              <button
                data-testid="btn-render-film"
                onClick={() => projectId && submitJob(projectId)}
                className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base"
              >
                Render Film
              </button>
            </div>
          )}

          {/* Starting */}
          {phase === "starting" && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="inline-block w-5 h-5 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-sm text-[#a3a3a3]">
                  {preparing && proxyTotal > 0
                    ? `Optimising clips for playback... ${proxyReady}/${proxyTotal} ready`
                    : "Preparing your film..."}
                </span>
              </div>
              {preparing && proxyTotal > 0 && (
                <div className="space-y-1 pl-8">
                  <div className="h-1 bg-white/10 rounded-full overflow-hidden max-w-xs">
                    <div
                      className="h-full bg-[#FF8A65]/60 rounded-full transition-all duration-500"
                      style={{ width: `${Math.round((proxyReady / proxyTotal) * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-[#a3a3a3]">{proxyElapsedLabel} elapsed</p>
                </div>
              )}
            </div>
          )}

          {/* Rendering */}
          {phase === "rendering" && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span data-testid="stage-label" className="text-[#a3a3a3]">{stage}</span>
                <span data-testid="progress-pct" className="text-[#e5e5e5] font-mono">{progress}%</span>
              </div>
              <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  data-testid="progress-bar"
                  className="h-full bg-[#22c55e] rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p data-testid="elapsed-timer" className="text-xs text-[#a3a3a3]">{elapsedLabel} elapsed</p>

              {/* U4g: cancel the in-flight render. Secondary/destructive style
                  per DESIGN.md -- outlined, NOT peach (peach = positive CTA). */}
              <div className="pt-1">
                <button
                  data-testid="btn-cancel-render"
                  onClick={cancelRender}
                  className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                >
                  Cancel render
                </button>
              </div>

              {/* U1e: soft stall warning -- shown when no liveness signal for >120s.
                  Non-blocking; the render may still be running. "Try Again" reuses
                  proxies via startNewVersion. Peach left-accent per DESIGN.md (the
                  project's warning token) -- never red (red is the error phase). */}
              {stalled && (
                <div
                  data-testid="render-stall-warning"
                  className="mt-3 flex items-center justify-between gap-4 rounded-md border border-white/10 border-l-2 border-l-[#FF8A65] bg-white/5 p-3"
                >
                  <p className="text-sm text-[#e5e5e5]">
                    This is taking longer than expected -- the render may have stalled. You can wait, or try again.
                  </p>
                  <button
                    data-testid="btn-stall-retry"
                    onClick={startNewVersion}
                    className="flex-shrink-0 text-sm text-[#FF8A65] font-medium hover:underline"
                  >
                    Try Again
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Done — V3 card design */}
          {phase === "done" && outputPath && (
            <div className="flex flex-col gap-3">

              {/* Main info + actions card */}
              <div
                className="rounded-[14px] border border-white/[0.07] bg-[#1a1a1a] overflow-hidden grid"
                style={{ gridTemplateColumns: "1fr 1px 220px" }}
              >
                {/* Left: metadata */}
                <div className="p-7">
                  {/* "Export finished" pill */}
                  <div className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-[5px] rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                    <Check size={14} strokeWidth={2.5} />
                    Export finished
                  </div>

                  {/* Film name */}
                  <div
                    data-testid="output-filename"
                    className="mt-4 text-[26px] font-bold text-white tracking-tight leading-tight"
                  >
                    {displayName}
                  </div>

                  {/* Stats grid */}
                  <div className="mt-5 grid grid-cols-2 gap-x-4">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#4a4946] mb-[3px]">Format</div>
                      <div className="text-[17px] font-bold text-[#e8e6e2] tracking-tight leading-tight">
                        {outputRes === "4k" ? "4K UHD" : "1080p HD"}
                      </div>
                      <div className="text-[13px] text-[#7a7874]">
                        {outputRes === "4k" ? "3840 x 2160" : "1920 x 1080"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#4a4946] mb-[3px]">Runtime</div>
                      <div className="text-[17px] font-bold text-[#e8e6e2] tracking-tight leading-tight">
                        {durationDisplay ?? "--"}
                      </div>
                    </div>
                    <div className="mt-[10px]">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#4a4946] mb-[3px]">Rendered</div>
                      <div className="text-[15px] font-bold text-[#e8e6e2] tracking-tight leading-tight">
                        {doneMeta?.iso ? shortDateTime(doneMeta.iso) : "--"}
                      </div>
                    </div>
                    <div className="mt-[10px]">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-[#4a4946] mb-[3px]">File size</div>
                      <div className="text-[13px] text-[#7a7874]">--</div>
                    </div>
                  </div>

                  {/* Saved-to row */}
                  <div className="mt-[18px] flex items-center gap-2 text-[13px] text-[#5a5956]">
                    <Folder size={14} strokeWidth={2} className="text-[#4a4946] flex-shrink-0" />
                    <span>Saved to</span>
                    <button
                      onClick={() => invoke("open_output_path", { path: outputPath })}
                      className="text-[#7a7874] font-medium hover:text-[#c8c5c0] transition-colors overflow-hidden text-ellipsis whitespace-nowrap max-w-[28ch]"
                    >
                      {pathDirname(outputPath)}
                    </button>
                  </div>
                </div>

                {/* Vertical divider */}
                <div className="bg-white/[0.07]" />

                {/* Right: actions */}
                <div className="px-5 py-6 flex flex-col justify-center gap-2.5">
                  <button
                    data-testid="btn-open-in-player"
                    onClick={() => invoke("open_in_player_cmd", { path: outputPath })}
                    className="w-full flex items-center gap-1.5 px-[18px] py-[10px] bg-[#FF8A65] text-[#0a0a0a] font-semibold text-[14px] rounded-lg hover:bg-[#ff9e7a] transition-all duration-150"
                  >
                    <Play size={15} fill="currentColor" stroke="none" />
                    Open film
                  </button>
                  <button
                    data-testid="btn-open-in-explorer"
                    onClick={() => invoke("open_output_path", { path: outputPath })}
                    className="w-full flex items-center gap-1.5 px-[18px] py-[10px] border border-white/[0.14] text-[#c8c5c0] text-[14px] font-semibold rounded-lg hover:bg-white/[0.06] hover:border-white/[0.22] transition-all duration-150"
                  >
                    <Folder size={15} strokeWidth={2} className="text-[#8a8883]" />
                    Open folder
                  </button>
                  <button
                    data-testid="btn-render-new"
                    onClick={startNewVersion}
                    className="w-full flex items-center gap-1.5 px-[18px] py-[10px] border border-white/[0.14] text-[#c8c5c0] text-[14px] font-semibold rounded-lg hover:bg-white/[0.06] hover:border-white/[0.22] transition-all duration-150"
                  >
                    <RotateCcw size={15} strokeWidth={2} className="text-[#8a8883]" />
                    Render another version
                  </button>
                </div>
              </div>

              {/* 1080p: in-app preview panel (below the info card) */}
              {outputRes !== "4k" && !videoMissing && (
                <div className="rounded-[14px] border border-white/[0.07] bg-[#1a1a1a] overflow-hidden">
                  <div
                    ref={videoContainerRef}
                    className="relative w-full"
                    style={videoHeight != null ? { height: videoHeight } : { maxHeight: "480px" }}
                  >
                    <video
                      data-testid="video-player"
                      src={assetUrl ?? undefined}
                      controls
                      autoPlay={false}
                      onLoadedMetadata={(e) => { videoLoadedRef.current = true; setVideoDuration(e.currentTarget.duration); }}
                      onError={() => { if (!videoLoadedRef.current) setVideoMissing(true); }}
                      className="w-full h-full object-contain bg-black"
                    />
                  </div>
                  <div
                    className="h-2 w-full cursor-ns-resize"
                    onPointerDown={onResizePointerDown}
                    onPointerMove={onResizePointerMove}
                    onPointerUp={onResizePointerUp}
                  />
                  <div className="px-4 py-3 flex items-center justify-between border-t border-white/[0.06]">
                    <span className="text-[13px] text-[#7a7874]">
                      <strong className="text-[#b0aeab] font-medium">{displayName}</strong>
                      {durationDisplay ? ` · ${durationDisplay}` : ""}
                      {" · 1080p"}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-[3px] rounded-full bg-[rgba(90,144,112,0.12)] text-[#5a9070] border border-[rgba(90,144,112,0.2)]">
                      In-app preview
                    </span>
                  </div>
                </div>
              )}

              {/* 1080p: missing-file notice */}
              {outputRes !== "4k" && videoMissing && (
                <div data-testid="render-missing" className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-[#a3a3a3]">This render is no longer on disk. Render a new version to recreate it.</p>
                </div>
              )}

              {/* render-meta: off-screen element for E2E compat */}
              {doneMeta && (
                <p data-testid="render-meta" className="sr-only">
                  {absoluteDateTime(doneMeta.iso)}
                  {doneMeta.res ? ` · ${doneMeta.res}` : ""}
                  {durationDisplay ? ` · ${durationDisplay}` : ""}
                </p>
              )}

            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-4 space-y-3">
              <p className="text-red-300 text-sm font-medium">{errorMsg}</p>
              {errorMsg === "Render cancelled" ? (
                <p className="text-sm text-[#a3a3a3]">
                  No changes were made. Select Try Again to restart the render, or go back to make changes.
                </p>
              ) : inFilmCount > 0 ? (
                <p className="text-sm text-[#a3a3a3]">
                  Your edits and optimised clips are safe -- Try Again just re-runs the render and reuses them.
                </p>
              ) : null}
              <div className="flex items-center gap-3">
                {inFilmCount > 0 && (
                  <button
                    onClick={startNewVersion}
                    className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                  >
                    Try Again
                  </button>
                )}
                <button
                  data-testid="btn-my-projects"
                  onClick={() => navigate("/library")}
                  className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                >
                  My Projects
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* AMF fallback toast (above bottom tab bar) */}
      {toast && (
        <div
          data-testid="toast-amf-fallback"
          className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-[#1a1a1a] border border-white/15 border-l-2 border-l-[#FF8A65] rounded-md shadow-lg pointer-events-none"
        >
          <p className="text-sm text-[#e5e5e5] whitespace-nowrap">{toast}</p>
        </div>
      )}
    </EditorShell>
  );
}
