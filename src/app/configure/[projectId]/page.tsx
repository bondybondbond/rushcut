"use client";

import { use, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { ConfigurePanel } from "@/components/configure/ConfigurePanel";
import { JobConfig } from "@/types/project";

const DEFAULT_CONFIG: JobConfig = {
  transition: "crossfade",
  music_mood: "none",
  silence_removal: true,
  zoom: false,
  intro_card: null,
  end_card: null,
};

export default function ConfigurePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether the user has actually changed anything
  const initialConfigRef = useRef(JSON.stringify(DEFAULT_CONFIG));
  const isDirty = JSON.stringify(config) !== initialConfigRef.current;

  function handleConfigChange(newConfig: JobConfig) {
    setConfig(newConfig);
  }

  async function handleRerender() {
    if (!isDirty) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, config }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error ?? `Server error ${resp.status}`);
      }
      const { jobId } = await resp.json();
      router.push(`/preview/${jobId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">
        Your edit settings
      </h2>
      <p className="text-[#e5e5e5] text-base mb-8">
        Adjust anything below. Only re-renders if you actually change something.
      </p>
      <ConfigurePanel projectId={projectId} onConfigChange={handleConfigChange} />
      {error && (
        <p className="mt-4 text-red-400 text-base">{error}</p>
      )}
      <div className="mt-8 flex items-center justify-end gap-4">
        {!isDirty && !loading && (
          <p className="text-[#555555] text-sm">No changes made yet</p>
        )}
        <button
          onClick={handleRerender}
          disabled={!isDirty || loading}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-base"
        >
          {loading && (
            <span className="w-4 h-4 border-2 border-[#0a0a0a]/30 border-t-[#0a0a0a] rounded-full animate-spin" />
          )}
          {loading ? "Creating render…" : "Re-render with changes"}
        </button>
      </div>
    </div>
  );
}
