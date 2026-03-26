import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Job, PipelineProgressEvent } from "@/types/project";
import { NavDrawer } from "@/components/NavDrawer";

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
  const [stage, setStage] = useState("Waiting...");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

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
      })
      .catch(() => {
        // Job might not be in DB yet if we navigated very fast — ignore
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

  const isDone = outputPath !== null;
  const isError = errorMsg !== null;

  // Use Tauri's convertFileSrc for correct asset:// URL on Windows
  const assetUrl = outputPath ? convertFileSrc(outputPath) : null;

  // Human-readable filename from path
  const filename = outputPath
    ? outputPath.replace(/\\/g, "/").split("/").pop() ?? outputPath
    : null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <NavDrawer />
            <h1 className="text-2xl font-semibold text-[#FF8A65]">
              {isDone ? "Your film is ready" : isError ? "Render failed" : "Rendering..."}
            </h1>
          </div>
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
            <p className="text-xs text-[#a3a3a3]">
              1080p renders take 2–5 min — switch tabs and come back whenever.
            </p>
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
            <div className="flex items-center justify-between">
              {filename && (
                <p data-testid="output-filename" className="text-sm text-[#a3a3a3]">{filename}</p>
              )}
              <button
                data-testid="btn-my-projects"
                onClick={() => navigate("/library")}
                className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
              >
                ← My Projects
              </button>
            </div>
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
