import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectWithClips, JobConfig, PipelineProgressEvent } from "@/types/project";
import { StepNav } from "@/components/StepNav";

const VALID_MOODS = ["none", "cinematic", "upbeat", "chill", "electronic"] as const;
const VALID_VOLUMES = ["subtle", "balanced", "prominent"] as const;
const VALID_TRANSITIONS = ["none", "crossfade", "dip_to_black"] as const;

const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  transition: "none",
  intro_text: "",
  intro_color: "#000000",
  outro_text: "",
  outro_color: "#000000",
  zoom: false,
  filter_boring: true,
  music_volume: "balanced",
};

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

function buildConfig(projectId: string): JobConfig {
  const config: JobConfig = { ...DEFAULT_CONFIG };
  try {
    const t = sessionStorage.getItem(`rc_transition_${projectId}`);
    if (t && (VALID_TRANSITIONS as readonly string[]).includes(t)) {
      config.transition = t as JobConfig["transition"];
    }
  } catch { /* ignore */ }
  try {
    const raw = sessionStorage.getItem(`rc_sound_${projectId}`);
    if (raw) {
      const s = JSON.parse(raw) as { mood?: string; volume?: string };
      if (s.mood && (VALID_MOODS as readonly string[]).includes(s.mood)) {
        config.music_mood = s.mood as JobConfig["music_mood"];
      }
      if (s.volume && (VALID_VOLUMES as readonly string[]).includes(s.volume)) {
        config.music_volume = s.volume as JobConfig["music_volume"];
      }
    }
  } catch { /* ignore */ }
  return config;
}

type Phase = "starting" | "rendering" | "done" | "error";

export default function Render() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [clipCount, setClipCount] = useState(0);
  const [phase, setPhase] = useState<Phase>("starting");
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Starting up the magic...");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  const startTimeRef = useRef<number>(Date.now());
  const [elapsedLabel, setElapsedLabel] = useState("0s");
  const completedRef = useRef(false);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mount: load project then auto-start render
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    invoke<ProjectWithClips>("get_project", { projectId })
      .then(async (data) => {
        if (cancelled) return;
        const count = data.clips.filter((c) => c.include !== 0).length;
        setClipCount(count);
        setProjectName(data.project.name);

        if (count === 0) {
          setErrorMsg("No clips in film -- go back to Trimmer and add some.");
          setPhase("error");
          return;
        }

        const config = buildConfig(projectId);
        try {
          const newJobId = await invoke<string>("start_job", {
            projectId,
            settingsJson: JSON.stringify(config),
          });
          if (cancelled) return;
          setJobId(newJobId);
          setStage("Starting up the magic...");
          setProgress(0);
          setElapsedLabel("0s");
          setPhase("rendering");
        } catch (e) {
          if (cancelled) return;
          setErrorMsg(`Failed to start render: ${e}`);
          setPhase("error");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMsg("Failed to load project -- go back and try again.");
        setPhase("error");
      });

    return () => { cancelled = true; };
  }, [projectId]);

  // Attach pipeline event listeners once jobId is known
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

  // Elapsed timer — counts up while rendering
  useEffect(() => {
    if (phase !== "rendering") return;
    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedLabel(sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  async function handleRetry() {
    if (!projectId || clipCount === 0) return;
    setPhase("starting");
    setJobId(null);
    setProgress(0);
    setStage("Starting up the magic...");
    setOutputPath(null);
    setErrorMsg(null);
    setElapsedLabel("0s");
    completedRef.current = false;

    const config = buildConfig(projectId);
    try {
      const newJobId = await invoke<string>("start_job", {
        projectId,
        settingsJson: JSON.stringify(config),
      });
      setJobId(newJobId);
      setPhase("rendering");
    } catch (e) {
      setErrorMsg(`Failed to start render: ${e}`);
      setPhase("error");
    }
  }

  const assetUrl = outputPath ? convertFileSrc(outputPath) : null;
  const displayName = projectName
    ? `${projectName}.mp4`
    : outputPath
      ? (outputPath.replace(/\\/g, "/").split("/").pop() ?? outputPath)
      : null;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <StepNav active="render" projectId={projectId} />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">

          <h1 className="text-3xl font-semibold text-[#FF8A65]">
            {phase === "done" ? "Your film is ready" : "Render Your Film"}
          </h1>

          {/* Starting / loading */}
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
            <div className="space-y-4">
              <div className="rounded-lg overflow-hidden bg-black border border-white/10">
                <video
                  data-testid="video-player"
                  src={assetUrl}
                  controls
                  autoPlay={false}
                  className="w-full max-h-[480px]"
                />
              </div>
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
                {clipCount > 0 && (
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
    </div>
  );
}
