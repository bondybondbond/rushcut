import Link from "next/link";
import { StepIndicator } from "@/components/StepIndicator";
import { VideoPlayer } from "@/components/preview/VideoPlayer";

export default function PreviewPage({
  params,
}: {
  params: { jobId: string };
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="preview" />
      </div>
      <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-2">
        Does this feel right?
      </h2>
      <p className="text-[#a3a3a3] mb-8">
        Your first cut is ready.
      </p>
      <VideoPlayer jobId={params.jobId} />
      <div className="mt-6 flex gap-3 justify-end">
        <Link
          href="/configure/demo-project-id"
          className="inline-flex items-center px-5 py-2.5 border border-white/20 text-[#e5e5e5] text-sm font-medium rounded-md hover:border-white/40 transition-all duration-200"
        >
          Edit settings
        </Link>
        <button className="inline-flex items-center px-5 py-2.5 border border-white/20 text-[#e5e5e5] text-sm font-medium rounded-md hover:border-white/40 transition-all duration-200">
          Re-render preview
        </button>
      </div>
      <div className="mt-3 flex justify-end">
        <Link
          href="/download/demo-job-id"
          className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200"
        >
          Export final edit
        </Link>
      </div>
    </div>
  );
}
