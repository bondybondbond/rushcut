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

      <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-2">
        Does this feel right?
      </h2>

      {poll.phase === "polling" && (
        <>
          <p className="text-[#a3a3a3] mb-8">{PROGRESS_LABELS[poll.status]}</p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="w-5 h-5 border-2 border-white/20 border-t-[#e5e5e5] rounded-full animate-spin" />
              <p className="text-[#555555] text-sm">{PROGRESS_LABELS[poll.status]}</p>
            </div>
          </div>
        </>
      )}

      {poll.phase === "timeout" && (
        <>
          <p className="text-[#a3a3a3] mb-8">
            Still rendering — this can take a few minutes for longer clips.
          </p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-[#555555] text-sm text-center max-w-xs">
                Your render is still in progress. Give it a moment and try again.
              </p>
              <button
                onClick={poll.retry}
                className="px-4 py-2 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 transition-all duration-200"
              >
                Check again
              </button>
            </div>
          </div>
        </>
      )}

      {poll.phase === "failed" && (
        <>
          <p className="text-red-400 mb-8 text-sm">{poll.error}</p>
          <div className="aspect-video bg-[#111111] rounded-lg border border-white/10 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <p className="text-[#555555] text-sm">Something went wrong with your render.</p>
              <a
                href="/upload"
                className="px-4 py-2 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 transition-all duration-200"
              >
                Start over
              </a>
            </div>
          </div>
        </>
      )}

      {poll.phase === "ready" && poll.job.draftUrl && (
        <>
          <p className="text-[#a3a3a3] mb-8">Your first cut is ready.</p>
          <VideoPlayer src={poll.job.draftUrl} />

          <div className="mt-6 flex gap-3 justify-end">
            <button
              onClick={() => router.push(`/configure/${poll.job.project_id}`)}
              className="inline-flex items-center px-5 py-2.5 border border-white/20 text-[#e5e5e5] text-sm font-medium rounded-md hover:border-white/40 transition-all duration-200"
            >
              Edit settings
            </button>
            <button
              onClick={handleExport}
              className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200 text-sm"
            >
              Export full quality
            </button>
          </div>
        </>
      )}
    </div>
  );
}
