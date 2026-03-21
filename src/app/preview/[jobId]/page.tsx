"use client";

import { useParams, useRouter } from "next/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { VideoPlayer } from "@/components/preview/VideoPlayer";
import { useJobPoll, PROGRESS_LABELS } from "@/hooks/useJobPoll";

export default function PreviewPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const poll = useJobPoll(jobId);

  async function handleExport() {
    const resp = await fetch(`/api/jobs/${jobId}/finalise`, { method: "POST" });
    if (!resp.ok) return;
    const { jobId: finalJobId } = await resp.json();
    router.push(`/download/${finalJobId}`);
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="preview" />
      </div>

      <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">
        Does this feel right?
      </h2>

      {poll.phase === "polling" && (
        <>
          <p className="text-[#e5e5e5] text-base mb-8">
            {PROGRESS_LABELS[poll.status]} — this usually takes 2–4 minutes.
          </p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4 w-full max-w-xs px-6">
              <div className="w-6 h-6 border-2 border-white/20 border-t-[#FF8A65] rounded-full animate-spin" />
              <p className="text-[#a3a3a3] text-base">{PROGRESS_LABELS[poll.status]}</p>
              {/* Progress bar — shown when Lambda reports progress_pct */}
              {poll.progressPct != null && (
                <div className="w-full">
                  <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#FF8A65] rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${poll.progressPct}%` }}
                    />
                  </div>
                  <p className="text-[#a3a3a3] text-xs mt-1.5 text-center">{poll.progressPct}%</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {poll.phase === "timeout" && (
        <>
          <p className="text-[#e5e5e5] text-base mb-8">
            Still rendering — longer clips can take a few minutes.
          </p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-[#a3a3a3] text-base text-center max-w-xs">
                Your render is still in progress. Give it a moment and check again.
              </p>
              <button
                onClick={poll.retry}
                className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
              >
                Check again
              </button>
            </div>
          </div>
        </>
      )}

      {poll.phase === "failed" && (
        <>
          <p className="text-red-400 mb-8 text-base">{poll.error}</p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-[#a3a3a3] text-base">Something went wrong with your render.</p>
              <a
                href="/upload"
                className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
              >
                Start over
              </a>
            </div>
          </div>
        </>
      )}

      {poll.phase === "ready" && poll.job.draftUrl && (
        <>
          <p className="text-[#e5e5e5] text-base mb-6">Your first cut is ready.</p>
          <VideoPlayer src={poll.job.draftUrl} />

          <div className="mt-6 flex gap-3 justify-end items-center">
            <p className="text-[#a3a3a3] text-sm mr-auto">
              Not happy with it? Adjust settings and re-render.
            </p>
            <button
              onClick={() => router.push(`/configure/${poll.job.project_id}`)}
              className="inline-flex items-center px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base font-medium rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
            >
              Adjust settings
            </button>
            <button
              onClick={handleExport}
              className="inline-flex items-center px-6 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base"
            >
              Export final edit
            </button>
          </div>
        </>
      )}
    </div>
  );
}
