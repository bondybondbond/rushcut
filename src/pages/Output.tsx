import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Job, PipelineProgressEvent, ProjectWithClips } from "@/types/project";

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

export default function Output() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Starting up the magic...");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const startTimeRef = useRef<number>(Date.now());
  const [elapsedLabel, setElapsedLabel] = useState<string>("0s");

  // Load initial job state (handles page refresh on already-done job)
  useEffect(() => {
    if (!jobId) return;
    invoke<Job>("get_job_cmd", { jobId })
      .then((j) => {
        setProgress(j.progress_pct);
        if (j.status === "done" && j.local_output_path) {
          setOutputPath(j.local_output_path);
          setStage("Done");
        } else if (j.status === "failed") {
          setErrorMsg(j.error_message ?? "Render failed");
          setStage("Error");
        }
        // Fetch project name for friendly filename display
        return invoke<ProjectWithClips>("get_project", { projectId: j.project_id });
      })
      .then((pw) => {
        setProjectName(pw.project.name);
      })
      .catch(() => {
        // Non-fatal — filename falls back to path-derived name
      });
  }, [jobId]);

  // Listen to pipeline events
  useEffect(() => {
    if (!jobId) return;

    const unlistenProgress = listen<PipelineProgressEvent>("pipeline-progress", (event) => {
      if (event.payload.jobId !== jobId) return;
      setProgress(event.payload.progress);
    });

    const unlistenDone = listen<PipelineProgressEvent>("pipeline-done", (event) => {
      if (event.payload.jobId !== jobId) return;
      setProgress(100);
      setStage("Done");
      setOutputPath(event.payload.outputPath);
    });

    const unlistenError = listen<PipelineProgressEvent>("pipeline-error", (event) => {
      if (event.payload.jobId !== jobId) return;
      setErrorMsg(event.payload.message || "Render failed");
      setStage("Error");
    });

    const unlistenStage = listen<{ jobId: string; stage: string }>("pipeline-stage", (event) => {
      if (event.payload.jobId !== jobId) return;
      setStage(stageLabel(event.payload.stage));
    });

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
      unlistenStage.then((f) => f());
    };
  }, [jobId]);

  // Elapsed timer — counts up every second while rendering
  useEffect(() => {
    if (outputPath || errorMsg) return;
    // Start counting from first progress event
    const interval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTimeRef.current) / 1000);
      if (sec < 60) {
        setElapsedLabel(`${sec}s`);
      } else {
        setElapsedLabel(`${Math.floor(sec / 60)}m ${sec % 60}s`);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [outputPath, errorMsg]);

  const isDone = outputPath !== null;
  const isError = errorMsg !== null;

  const assetUrl = outputPath ? convertFileSrc(outputPath) : null;

  // Display name: project name if available, otherwise derive from filename
  const displayName = projectName
    ? `${projectName}.mp4`
    : outputPath
      ? (outputPath.replace(/\\/g, "/").split("/").pop() ?? outputPath)
      : null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-[#FF8A65]">
            {isDone ? "Your film is ready" : isError ? "Render failed" : "Rendering..."}
          </h1>
          <button
            data-testid="btn-my-projects"
            onClick={() => navigate("/library")}
            className="px-4 py-2 bg-[#E1F2CE] text-[#1a1a1a] font-semibold text-sm rounded-md hover:bg-[#d0e8b8] transition-colors"
          >
            My Projects
          </button>
        </div>

        {/* Progress bar */}
        {!isDone && !isError && (
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
            <p className="text-xs text-[#a3a3a3]">{elapsedLabel} elapsed</p>
          </div>
        )}

        {/* Done: video player */}
        {isDone && assetUrl && (
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
            <button
              data-testid="btn-open-file"
              onClick={() => invoke("open_output_path", { path: outputPath })}
              className="w-full px-5 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors"
            >
              Open File in Explorer
            </button>
            {displayName && (
              <p data-testid="output-filename" className="text-sm text-[#a3a3a3] text-center">{displayName}</p>
            )}
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-4 space-y-3">
            <p className="text-red-300 text-sm">{errorMsg}</p>
            <button
              onClick={() => navigate(-1)}
              className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
            >
              Go back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
