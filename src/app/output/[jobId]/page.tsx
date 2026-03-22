"use client";

import { useParams } from "next/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { useJobPoll, PROGRESS_LABELS } from "@/hooks/useJobPoll";

export default function OutputPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const poll = useJobPoll(jobId);

  const projectId = poll.phase === "ready" ? poll.job.project_id : null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="render" />
      </div>

      {/* Rendering */}
      {poll.phase === "polling" && (
        <>
          <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">Rendering your film</h2>
          <p className="text-[#e5e5e5] text-base mb-6">
            {PROGRESS_LABELS[poll.status]}
          </p>
          <div className="border border-white/10 rounded-lg p-6">
            {poll.progressPct != null ? (
              <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#22c55e] rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${poll.progressPct}%` }}
                />
              </div>
            ) : (
              <div className="h-2 bg-white/10 rounded-full overflow-hidden relative">
                <div className="progress-indeterminate absolute top-0 bottom-0 bg-[#22c55e] rounded-full" />
              </div>
            )}
            <p className="text-[#a3a3a3] text-sm mt-4">
              {poll.progressPct != null ? `${poll.progressPct}% — ` : ""}Rendering on our servers — switch tabs and come back whenever.
            </p>
          </div>
          <p className="text-[#a3a3a3] text-sm mt-3">
            1080p renders take 2–5 min regardless of clip length.
          </p>
        </>
      )}

      {/* Timeout */}
      {poll.phase === "timeout" && (
        <>
          <h2 className="text-3xl font-semibold text-[#e5e5e5] mb-2">Still rendering…</h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-[#e5e5e5] text-base mb-6">
              Full quality renders can take up to 5 minutes for longer edits.
            </p>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden relative mb-6">
              <div className="progress-indeterminate absolute top-0 bottom-0 bg-[#22c55e] rounded-full" />
            </div>
            <button
              onClick={poll.retry}
              className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
            >
              Check again
            </button>
          </div>
        </>
      )}

      {/* Failed */}
      {poll.phase === "failed" && (
        <>
          <h2 className="text-3xl font-semibold text-[#e5e5e5] mb-2">Render failed</h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-red-400 text-base mb-4">{poll.error}</p>
            <div className="flex items-center gap-3">
              <button
                onClick={poll.retry}
                className="px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold text-base rounded-md hover:bg-[#ff9e7a] transition-all duration-200"
              >
                Retry
              </button>
              <a
                href="/upload"
                className="inline-flex px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
              >
                Start over
              </a>
            </div>
          </div>
        </>
      )}

      {/* Ready */}
      {poll.phase === "ready" && poll.job.finalUrl && (
        <>
          <h2 className="text-3xl font-semibold text-[#FF8A65] mb-3">Your film is ready</h2>

          {/* Inline video player — 1080p badge overlaid top-right */}
          <div className="relative mb-4">
            <video
              src={poll.job.finalUrl}
              controls
              playsInline
              className="w-full rounded-lg bg-black"
              style={{ maxHeight: "480px" }}
            />
            <span className="absolute top-2 right-2 text-xs font-medium bg-black/70 text-[#e5e5e5] rounded px-2 py-1 pointer-events-none">
              1080p
            </span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <a
              href={poll.job.finalUrl}
              download
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a.5.5 0 0 1 .5.5v7.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 .708-.708L7.5 9.293V1.5A.5.5 0 0 1 8 1zm-5 11a.5.5 0 0 0 0 1h10a.5.5 0 0 0 0-1H3z" />
              </svg>
              Download film
            </a>
            {projectId && (
              <a
                href={`/editor/${projectId}`}
                className="inline-flex px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
              >
                Edit again
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
