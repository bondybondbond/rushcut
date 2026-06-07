import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  const [fastRender, setFastRender] = useState(() => {
    try {
      return getRenderPref(`rc_fast_render_${projectId}`) === "1";
    } catch { return false; }
  });
  const [toast, setToast] = useState<string | null>(null);
  const [doneMeta, setDoneMeta] = useState<DoneMeta | null>(null);
  // T5: true once the output file fails to load (deleted from disk). Duration
  // captured from the actual <video> element so it matches the player exactly.
  const [videoMissing, setVideoMissing] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);

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

  function handleFastRenderToggle() {
    const next = !fastRender;
    setFastRender(next);
    setRenderPref(`rc_fast_render_${projectId}`, next ? "1" : "0");
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
    setDoneMeta({ iso: job.updated_at, res: resLabel(job), analysisDuration: durationLabel(job) });
    setVideoMissing(false);
    setVideoDuration(null);
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
      // Batch R Part C: surface silent AMF -> libx264 fallback as a toast so
      // a "Fast render" toggle that did nothing doesn't look like a no-op.
      const analysis = event.payload.analysis;
      // T5: capture metadata for the freshly-finished render. Duration here is
      // the analysis fallback; the <video> element overrides it on load.
      setVideoMissing(false);
      setVideoDuration(null);
      setDoneMeta({
        iso: new Date().toISOString(),
        res: outputRes === "4k" ? "4K" : "1080p",
        analysisDuration: durationLabel({ analysis_summary: analysis ?? null }),
      });
      if (analysis && /(^|,)amf_fallback=1(,|$)/.test(analysis)) {
        setToast("Fast render unavailable -- rendered at standard quality");
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
    // U1e: every 30s, flag a stall if no progress/stage event for >120s. This does
    // NOT change phase (the render may still be alive) -- it only surfaces a soft
    // warning. The 120s window is reset by both pipeline-progress and pipeline-stage.
    const stallCheck = setInterval(() => {
      if (Date.now() - lastProgressAtRef.current > 120_000) setStalled(true);
    }, 30_000);
    return () => {
      clearInterval(interval);
      clearInterval(stallCheck);
      // U1e: leaving "rendering" (done/error) clears any standing stall warning.
      setStalled(false);
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

              <div className="border border-white/10 rounded-lg p-4 space-y-1">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fastRender}
                    data-testid="toggle-fast-render"
                    onClick={handleFastRenderToggle}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                      fastRender ? "bg-[#99B3FF]" : "bg-white/20"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                        fastRender ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span className="text-sm text-[#e5e5e5]">Fast render</span>
                </label>
                <p className="text-xs text-[#a3a3a3] pl-12">slightly lower motion quality</p>
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

          {/* Done — film view */}
          {phase === "done" && assetUrl && (
            <div className="space-y-3">
              {/* Player stays mounted (even when hidden) so onError can fire. */}
              <div
                ref={videoContainerRef}
                className={`rounded-lg overflow-hidden bg-black border border-white/10 ${videoMissing ? "hidden" : ""}`}
                style={videoHeight != null ? { height: videoHeight } : { maxHeight: "480px" }}
              >
                <video
                  data-testid="video-player"
                  src={assetUrl}
                  controls
                  autoPlay={false}
                  onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
                  onError={() => setVideoMissing(true)}
                  className="w-full h-full object-contain"
                />
              </div>

              {!videoMissing && (
                <div
                  className="w-full h-2 flex items-center justify-center cursor-ns-resize border-t border-white/10"
                  onPointerDown={onResizePointerDown}
                  onPointerMove={onResizePointerMove}
                  onPointerUp={onResizePointerUp}
                />
              )}

              {/* Missing-file note — sits alongside the metadata, never replaces it. */}
              {videoMissing && (
                <div data-testid="render-missing" className="rounded-lg border border-white/10 bg-white/5 p-4">
                  <p className="text-sm text-[#a3a3a3]">This render is no longer on disk. Render a new version to recreate it.</p>
                </div>
              )}

              <div className="flex items-center gap-3">
                {!videoMissing && (
                  <button
                    data-testid="btn-open-in-explorer"
                    onClick={() => outputPath && invoke("open_output_path", { path: outputPath })}
                    className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                  >
                    Open in Explorer
                  </button>
                )}
                <button
                  data-testid="btn-render-new"
                  onClick={startNewVersion}
                  className="px-6 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold text-base rounded-md hover:bg-[#ff9e7a] transition-all duration-200"
                >
                  Render new version
                </button>
              </div>
              {displayName && (
                <p data-testid="output-filename" className="text-sm text-[#a3a3a3]">{displayName}</p>
              )}
              {doneMeta && (
                <p data-testid="render-meta" className="text-sm text-[#a3a3a3]">
                  Rendered {absoluteDateTime(doneMeta.iso)}
                  {doneMeta.res ? <> &middot; {doneMeta.res}</> : null}
                  {durationDisplay ? <> &middot; {durationDisplay}</> : null}
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-4 space-y-3">
              <p className="text-red-300 text-sm">{errorMsg}</p>
              {inFilmCount > 0 && (
                <p className="text-sm text-[#a3a3a3]">
                  Your edits and optimised clips are safe -- Try Again just re-runs the render and reuses them.
                </p>
              )}
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
