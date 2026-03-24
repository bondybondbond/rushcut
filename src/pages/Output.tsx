import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Job, PipelineProgressEvent } from "@/types/project";

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

// Convert a Windows output path to an asset:// URL for Tauri's asset protocol.
// e.g. C:\clips\processed\abc.mp4 -> asset://localhost/C:/clips/processed/abc.mp4
function outputPathToAssetUrl(winPath: string): string {
  const normalized = winPath.replace(/\\/g, "/");
  return `asset://localhost/${normalized}`;
}

export default function Output() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();

  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Waiting...");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load initial job state
  useEffect(() => {
    if (!jobId) return;
    invoke<Job>("get_job_cmd", { jobId })
      .then((j) => {
        setJob(j);
        setProgress(j.progress_pct);
        if (j.status === "done" && j.local_output_path) {
          setOutputPath(j.local_output_path);
          setStage("Done");
        } else if (j.status === "failed") {
          setErrorMsg(j.error_message ?? "Render failed");
        }
      })
      .catch(() => {
        // Job might not be in DB yet if we navigated very fast — ignore
      });
  }, [jobId]);

  // Listen to pipeline events
  useEffect(() => {
    if (!jobId) return;

    const unlistenProgress = listen<PipelineProgressEvent>(
      "pipeline-progress",
      (event) => {
        if (event.payload.jobId !== jobId) return;
        setProgress(event.payload.progress);
        setStage(event.payload.stage || "Rendering...");
      }
    );

    const unlistenDone = listen<PipelineProgressEvent>(
      "pipeline-done",
      (event) => {
        if (event.payload.jobId !== jobId) return;
        setProgress(100);
        setStage("Done");
        setOutputPath(event.payload.outputPath);
      }
    );

    const unlistenError = listen<PipelineProgressEvent>(
      "pipeline-error",
      (event) => {
        if (event.payload.jobId !== jobId) return;
        setErrorMsg(event.payload.message || "Render failed");
        setStage("Error");
      }
    );

    const unlistenStage = listen<{ jobId: string; stage: string }>(
      "pipeline-stage",
      (event) => {
        if (event.payload.jobId !== jobId) return;
        setStage(stageLabel(event.payload.stage));
      }
    );

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
      unlistenStage.then((f) => f());
    };
  }, [jobId]);

  const isDone = outputPath !== null;
  const isError = errorMsg !== null;
  const assetUrl = outputPath ? outputPathToAssetUrl(outputPath) : null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-[#e5e5e5]">
            {isDone ? "Your film is ready" : isError ? "Render failed" : "Rendering..."}
          </h1>
          <button
            onClick={() => navigate("/upload")}
            className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
          >
            New project
          </button>
        </div>

        {/* Progress bar */}
        {!isDone && !isError && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-[#a3a3a3]">{stage}</span>
              <span className="text-[#e5e5e5] font-mono">{progress}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#22c55e] rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Done: video player */}
        {isDone && assetUrl && (
          <div className="space-y-4">
            <div className="rounded-lg overflow-hidden bg-black border border-white/10">
              <video
                src={assetUrl}
                controls
                autoPlay={false}
                className="w-full max-h-[480px]"
              />
            </div>
            <p className="text-xs text-[#555555] break-all">{outputPath}</p>
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

        {/* Job info */}
        {job && (
          <p className="text-xs text-[#333333]">Job {jobId}</p>
        )}
      </div>
    </div>
  );
}
