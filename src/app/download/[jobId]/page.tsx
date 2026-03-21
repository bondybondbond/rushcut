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

      {/* Processing */}
      {poll.phase === "polling" && (
        <>
          <h2 className="text-3xl font-semibold text-[#e5e5e5] mb-2">
            Rendering your edit
          </h2>
          <p className="text-[#e5e5e5] text-base mb-8">
            {PROGRESS_LABELS[poll.status]} — full quality takes 2–5 min.
          </p>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            {/* Animated indeterminate green bar */}
            <div className="h-2 bg-white/10 rounded-full overflow-hidden relative">
              <div className="progress-indeterminate absolute top-0 bottom-0 bg-[#22c55e] rounded-full" />
            </div>
            <p className="text-[#a3a3a3] text-sm mt-4">
              You can safely leave this tab open — we will let you know when it is done.
            </p>
          </div>
        </>
      )}

      {/* Timeout */}
      {poll.phase === "timeout" && (
        <>
          <h2 className="text-3xl font-semibold text-[#e5e5e5] mb-2">
            Still rendering…
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-[#e5e5e5] text-base mb-6">
              Full quality renders can take up to 5 minutes for longer edits.
            </p>
            {/* Still-animated bar during timeout */}
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
          <h2 className="text-3xl font-semibold text-[#e5e5e5] mb-2">
            Render failed
          </h2>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            <p className="text-red-400 text-base mb-6">{poll.error}</p>
            <a
              href="/upload"
              className="inline-flex px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
            >
              Start over
            </a>
          </div>
        </>
      )}

      {/* Ready */}
      {poll.phase === "ready" && poll.job.finalUrl && (
        <>
          <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">
            Your edit is ready
          </h2>
          <p className="text-[#e5e5e5] text-base mb-8">
            Your 1080p file is ready to download.
          </p>
          <div className="border border-white/10 rounded-lg p-6 mb-6">
            {/* Full green bar on completion */}
            <div className="h-2 bg-white/10 rounded-full overflow-hidden mb-6">
              <div className="h-full w-full bg-[#22c55e] rounded-full" />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium bg-white/10 text-[#e5e5e5] rounded px-2.5 py-1">
                1080p
              </span>
              <a
                href={poll.job.finalUrl}
                download
                className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a.5.5 0 0 1 .5.5v7.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 .708-.708L7.5 9.293V1.5A.5.5 0 0 1 8 1zm-5 11a.5.5 0 0 0 0 1h10a.5.5 0 0 0 0-1H3z"/>
                </svg>
                Download edit
              </a>
            </div>
          </div>
        </>
      )}

      <p className="text-[#a3a3a3] text-sm">Saved for 30 days.</p>
    </div>
  );
}
