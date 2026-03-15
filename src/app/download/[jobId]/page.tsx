import { StepIndicator } from "@/components/StepIndicator";

export default function DownloadPage({
  params,
}: {
  params: { jobId: string };
}) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="download" />
      </div>

      {/*
        STATE A — default on page load (render in progress)
        Replace with STATE B once render completes (Batch 2 wiring)
      */}
      <div data-state="processing">
        <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-8">
          Your edit is being processed
        </h2>
        <div className="border border-white/10 rounded-lg p-6 mb-6">
          <p className="text-[#a3a3a3] text-sm mb-4">
            This usually takes a few minutes.
          </p>
          <div className="mb-2">
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-[#e5e5e5] rounded-full" style={{ width: "60%" }} />
            </div>
            <p className="text-[#555555] text-xs mt-1">Rendering...</p>
          </div>
          <p className="text-[#555555] text-xs mt-4">
            You can close this tab. We will save it to your library.
          </p>
        </div>
      </div>

      {/*
        STATE B — shown when render is complete (Batch 2 wiring)
        Hidden in Batch 1 — rendered below processing state as static reference only
      */}
      <div data-state="ready">
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
            <span className="text-xs text-[#555555] bg-white/5 rounded px-2 py-0.5">
              4K [upgrade]
            </span>
          </div>
          <button className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200 text-sm">
            Download edit
          </button>
        </div>
      </div>

      {/* Always visible — both states */}
      <p className="text-[#a3a3a3] text-xs">
        Saved to your library for 30 days.
      </p>
    </div>
  );
}
