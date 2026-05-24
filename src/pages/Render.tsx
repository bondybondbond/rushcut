import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectWithClips, JobConfig, PipelineProgressEvent } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";
import { buildJobConfig, readTransitionConfig } from "@/utils/buildJobConfig";

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

type Phase = "ready" | "awaiting-proxies" | "starting" | "rendering" | "done" | "error";

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
      const stored = sessionStorage.getItem(`rc_render_res_${projectId}`);
      return stored === "4k" ? "4k" : "1080p";
    } catch {
      return "1080p";
    }
  });
  const [fastRender, setFastRender] = useState(() => {
    try { return sessionStorage.getItem(`rc_fast_render_${projectId}`) === "1"; } catch { return false; }
  });

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);

  const startTimeRef = useRef<number>(Date.now());
  const [elapsedLabel, setElapsedLabel] = useState("0s");
  const completedRef = useRef(false);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Batch R: proxy-readiness gate state. Render only auto-starts once every
  // include=1 clip has a proxy that matches render.py's reuse gate; otherwise
  // we fall into the 504s full-normalise path documented in the timing log.
  const [proxyReady, setProxyReady] = useState(0);
  const [proxyTotal, setProxyTotal] = useState(0);
  const [proxyEtaLabel, setProxyEtaLabel] = useState<string>("Estimating...");
  const waitStartRef = useRef<number>(0);
  const waitStartReadyRef = useRef<number>(0);

  const configured = useConfiguredTabs(projectId ?? "");

  const transitionVal = (() => {
    try {
      const tc = readTransitionConfig(projectId ?? "");
      return tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null);
    } catch { return null; }
  })();
  const soundMoodVal = (() => {
    try {
      const raw = sessionStorage.getItem(`rc_sound_${projectId}`);
      return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null;
    } catch { return null; }
  })();

  function handleResSelect(res: "1080p" | "4k") {
    setOutputRes(res);
    try { sessionStorage.setItem(`rc_render_res_${projectId}`, res); } catch { /* ignore */ }
  }

  function handleFastRenderToggle() {
    const next = !fastRender;
    setFastRender(next);
    try { sessionStorage.setItem(`rc_fast_render_${projectId}`, next ? "1" : "0"); } catch { /* ignore */ }
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
    try {
      const newJobId = await invoke<string>("start_job", {
        projectId: pid,
        settingsJson: JSON.stringify(config),
      });
      setJobId(newJobId);
      setStage("Starting up the magic...");
      setProgress(0);
      setElapsedLabel("0s");
      setPhase("rendering");
    } catch (e) {
      setErrorMsg(`Failed to start render: ${e}`);
      setPhase("error");
    }
  }

  // Batch R: gate render on proxy readiness. Returns true once proceeding to
  // actual job submit. If clips are blocking, transitions to "awaiting-proxies"
  // and lets the polling effect drive the transition.
  async function submitJob(pid: string) {
    try {
      const status = await invoke<ProxyReadiness>("get_proxy_readiness_cmd", {
        projectId: pid,
        outputResolution: outputRes,
      });
      setProxyReady(status.ready);
      setProxyTotal(status.total);
      // Skip gate when all proxies ready OR none exist at all (cold render).
      // Gate only holds when partially done: some clips ready, some not.
      if (status.ready >= status.total || status.ready === 0) {
        await startRenderNow(pid);
        return;
      }
      // Kick off normal-priority proxy gen and enter wait state.
      waitStartRef.current = Date.now();
      waitStartReadyRef.current = status.ready;
      setProxyEtaLabel("Estimating...");
      setPhase("awaiting-proxies");
      invoke("generate_proxies_cmd", { projectId: pid, lowPriority: false }).catch(console.error);
    } catch (e) {
      console.error("[render] readiness check failed, proceeding without gate", e);
      await startRenderNow(pid);
    }
  }

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    Promise.all([
      invoke<ProjectWithClips>("get_project", { projectId }),
      invoke<boolean>("has_4k_clips_cmd", { projectId }).catch(() => false as boolean),
    ]).then(async ([data, is4K]) => {
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
    });

    const unlistenStage = listen<{ jobId: string; stage: string }>("pipeline-stage", (event) => {
      if (event.payload.jobId !== jobId) return;
      setStage(stageLabel(event.payload.stage));
      resetActivityTimer();
    });

    const unlistenDone = listen<PipelineProgressEvent>("pipeline-done", (event) => {
      if (event.payload.jobId !== jobId) return;
      completedRef.current = true;
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      setProgress(100);
      setOutputPath(event.payload.outputPath ?? null);
      setPhase("done");
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
    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedLabel(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  // Batch R: poll proxy readiness and listen to proxy-progress while in the
  // awaiting-proxies wait state. ETA = (remaining * elapsed/completed_so_far);
  // shows "Estimating..." until at least one proxy lands during the wait.
  useEffect(() => {
    if (phase !== "awaiting-proxies" || !projectId) return;
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

        const completedSinceStart = status.ready - waitStartReadyRef.current;
        if (completedSinceStart > 0) {
          const elapsedSec = (Date.now() - waitStartRef.current) / 1000;
          const avgPerClip = elapsedSec / completedSinceStart;
          const remaining = Math.max(0, status.total - status.ready);
          const eta = Math.round(avgPerClip * remaining);
          setProxyEtaLabel(remaining === 0 ? "Ready" : `About ~${eta}s remaining`);
        }

        if (status.ready >= status.total && status.total > 0) {
          startRenderNow(projectId!);
          return true;
        }
      } catch (e) {
        console.error("[render] readiness poll failed", e);
      }
      return false;
    }

    check();
    const interval = setInterval(check, 2000);

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
      unlistenProxy.then((f) => f());
    };
  }, [phase, projectId, outputRes]);

  async function handleRetry() {
    if (!projectId || inFilmCount === 0) return;
    setPhase("starting");
    setJobId(null);
    setProgress(0);
    setStage("Starting up the magic...");
    setOutputPath(null);
    setErrorMsg(null);
    setElapsedLabel("0s");
    completedRef.current = false;
    await submitJob(projectId);
  }

  const assetUrl = outputPath ? convertFileSrc(outputPath) : null;
  const displayName = projectName
    ? `${projectName}.mp4`
    : outputPath
      ? (outputPath.replace(/\\/g, "/").split("/").pop() ?? outputPath)
      : null;

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
            {phase === "done" ? "Your film is ready" : "Render Your Film"}
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

          {/* Awaiting proxies — Batch R gate */}
          {phase === "awaiting-proxies" && (
            <div className="space-y-4" data-testid="awaiting-proxies">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-[#e5e5e5]">
                    Preparing proxies -- {proxyReady} / {proxyTotal} ready
                  </span>
                  <span className="text-[#a3a3a3] font-mono" data-testid="proxy-eta">
                    {proxyEtaLabel}
                  </span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#22c55e] rounded-full transition-all duration-500"
                    style={{ width: `${proxyTotal > 0 ? Math.round((proxyReady / proxyTotal) * 100) : 0}%` }}
                  />
                </div>
                <p className="text-xs text-[#a3a3a3]">
                  Render starts automatically when proxies finish. Skipping makes this render much slower.
                </p>
              </div>
              <button
                type="button"
                data-testid="btn-start-anyway"
                onClick={() => projectId && startRenderNow(projectId)}
                className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-sm rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
              >
                Start anyway (slower)
              </button>
            </div>
          )}

          {/* Starting */}
          {phase === "starting" && (
            <div className="flex items-center gap-3">
              <span className="inline-block w-5 h-5 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
              <span className="text-sm text-[#a3a3a3]">Preparing your film...</span>
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
            </div>
          )}

          {/* Done */}
          {phase === "done" && assetUrl && (
            <div className="space-y-3">
              <div
                ref={videoContainerRef}
                className="rounded-lg overflow-hidden bg-black border border-white/10"
                style={videoHeight != null ? { height: videoHeight } : { maxHeight: "480px" }}
              >
                <video
                  data-testid="video-player"
                  src={assetUrl}
                  controls
                  autoPlay={false}
                  className="w-full h-full object-contain"
                />
              </div>

              <div
                className="w-full h-2 flex items-center justify-center cursor-ns-resize border-t border-white/10"
                onPointerDown={onResizePointerDown}
                onPointerMove={onResizePointerMove}
                onPointerUp={onResizePointerUp}
              />

              <div className="flex items-center gap-3">
                <button
                  data-testid="btn-open-in-explorer"
                  onClick={() => outputPath && invoke("open_output_path", { path: outputPath })}
                  className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                >
                  Open in Explorer
                </button>
                <button
                  data-testid="btn-my-projects"
                  onClick={() => navigate("/library")}
                  className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
                >
                  My Projects
                </button>
              </div>
              {displayName && (
                <p data-testid="output-filename" className="text-sm text-[#a3a3a3]">{displayName}</p>
              )}
            </div>
          )}

          {/* Error */}
          {phase === "error" && (
            <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-4 space-y-3">
              <p className="text-red-300 text-sm">{errorMsg}</p>
              <div className="flex items-center gap-3">
                {inFilmCount > 0 && (
                  <button
                    onClick={handleRetry}
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
    </EditorShell>
  );
}
