"use client";

import { useParams } from "next/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { useJobPoll, PROGRESS_LABELS } from "@/hooks/useJobPoll";

export default function DownloadPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const poll = useJobPoll(jobId);

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="download" />
      </div>

      {/* STATE A — processing */}
      {poll.phase === "polling" && (
        <>
          <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-8">
            Your edit is being processed
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-[#a3a3a3] text-sm mb-4">
              {PROGRESS_LABELS[poll.status]} Full quality render takes 2–5 min.
            </p>
            <div className="mb-2">
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-[#e5e5e5] rounded-full animate-pulse w-1/2" />
              </div>
            </div>
          </div>
        </>
      )}

      {/* Timeout */}
      {poll.phase === "timeout" && (
        <>
          <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-8">
            Still rendering...
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-[#a3a3a3] text-sm mb-4">
              Your render is taking longer than usual. Full quality renders can take up to 5 minutes.
            </p>
            <button
              onClick={poll.retry}
              className="px-4 py-2 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 transition-all duration-200"
            >
              Check again
            </button>
          </div>
        </>
      )}

      {/* Failed */}
      {poll.phase === "failed" && (
        <>
          <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-8">
            Render failed
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-red-400 text-sm mb-4">{poll.error}</p>
            <a
              href="/upload"
              className="px-4 py-2 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 transition-all duration-200"
            >
              Start over
            </a>
          </div>
        </>
      )}

      {/* STATE B — ready */}
      {poll.phase === "ready" && poll.job.finalUrl && (
        <>
          <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-8">
            Your edit is ready
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-[#a3a3a3] text-sm mb-4">
              Your 1080p file is ready to download.
            </p>
            <div className="flex items-center gap-2 mb-6">
              <span className="text-xs font-medium bg-white/10 text-[#e5e5e5] rounded px-2 py-0.5">
                1080p
              </span>
            </div>
            <a
              href={poll.job.finalUrl}
              download
              className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200 text-sm"
            >
              Download edit
            </a>
          </div>
        </>
      )}

      <p className="text-[#a3a3a3] text-xs">Saved to your library for 30 days.</p>
    </div>
  );
}
