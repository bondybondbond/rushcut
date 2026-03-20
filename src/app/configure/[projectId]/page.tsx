"use client";

import { useState } from "react";
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
  params: { projectId: string };
}) {
  const router = useRouter();
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRerender() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: params.projectId, config }),
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
      <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-2">
        Your edit settings
      </h2>
      <p className="text-[#a3a3a3] mb-8">
        Adjust anything. We will re-render your cut.
      </p>
      <ConfigurePanel projectId={params.projectId} onConfigChange={setConfig} />
      {error && (
        <p className="mt-4 text-red-400 text-sm">{error}</p>
      )}
      <div className="mt-8 flex justify-end">
        <button
          onClick={handleRerender}
          disabled={loading}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
