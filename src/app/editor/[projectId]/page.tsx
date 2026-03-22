"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StepIndicator } from "@/components/StepIndicator";
import { TimelineStrip } from "@/components/editor/TimelineStrip";
import { SettingsPanel } from "@/components/editor/SettingsPanel";
import type { Clip, JobConfig } from "@/types/project";

type ClipWithUrl = Clip & { presignedUrl: string | null };

const DEFAULT_CONFIG: JobConfig = {
  transition: "crossfade",
  music_mood: "none",
  silence_removal: true,
  zoom: false,
  intro_card: null,
  end_card: null,
};

export default function EditorPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const router = useRouter();

  const [clips, setClips] = useState<ClipWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/clips`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setClips(data.clips ?? []);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleRender() {
    setRenderError(null);
    setRendering(true);
    try {
      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, config, mode: "final" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Server error ${res.status}`);
      }
      const { jobId } = await res.json();
      // Clear stored project ID — next session starts fresh
      localStorage.removeItem("rushcut_project_id");
      router.push(`/output/${jobId}`);
    } catch (err: unknown) {
      setRenderError(err instanceof Error ? err.message : "Something went wrong");
      setRendering(false);
    }
  }

  function handleReorder(reordered: ClipWithUrl[]) {
    setClips(reordered);
  }

  async function handleDelete(clipId: string) {
    try { await fetch(`/api/clips/${clipId}`, { method: "DELETE" }); } catch { /* ok */ }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="edit" />
      </div>

      <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">Your edit</h2>
      <p className="text-[#e5e5e5] text-base mb-6">
        Drag clips to reorder. Adjust settings on the right. Hit Render when ready.
      </p>

      {/* Timeline + settings layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Timeline (takes available space) */}
        <div className="flex-1 min-w-0">
          <p className="text-[#a3a3a3] text-xs uppercase tracking-wider font-medium mb-3">Timeline</p>
          {loading ? (
            <div className="flex items-center justify-center h-40 border border-white/10 rounded-lg">
              <span className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
          ) : loadError ? (
            <div className="border border-red-500/30 rounded-lg p-6">
              <p className="text-red-400 text-sm">{loadError}</p>
            </div>
          ) : (
            <>
              <div className="border border-white/10 rounded-lg p-3 bg-[#0d0d0d]">
                <TimelineStrip clips={clips} config={config} onReorder={handleReorder} onDelete={handleDelete} />
                {clips.length >= 2 && (
                  <p className="text-[#a3a3a3] text-xs mt-2 pl-1">Drag clips to reorder</p>
                )}
              </div>
              {clips.length > 0 && (
                <p className="text-[#a3a3a3] text-sm mt-3 flex items-center gap-1">
                  {clips.length} clip{clips.length !== 1 ? "s" : ""}
                  {clips.every((c) => c.duration_ms !== null) &&
                    clips.reduce((acc, c) => acc + (c.duration_ms ?? 0), 0) > 0 && (
                      <span className="ml-1">
                        &mdash; ~{Math.round(clips.reduce((acc, c) => acc + (c.duration_ms ?? 0), 0) / 1000)}s total
                      </span>
                    )}
                  <span className="ml-2 text-[#C9A96E]">· output: 1080p</span>
                  <span
                    title="Your footage is rendered at 1080p HD regardless of source resolution. 4K and 2.7K clips are scaled down during render."
                    className="cursor-help inline-flex items-center"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-[#C9A96E]/60">
                      <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
                    </svg>
                  </span>
                </p>
              )}
            </>
          )}
        </div>

        {/* Settings sidebar */}
        <div className="w-full lg:w-64 flex-shrink-0">
          <SettingsPanel config={config} onChange={setConfig} />
        </div>
      </div>

      {/* Render CTA */}
      {renderError && <p className="mt-4 text-red-400 text-sm">{renderError}</p>}
      <div className="mt-5 flex justify-end">
        <button
          onClick={handleRender}
          disabled={rendering || loading || clips.length === 0}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-base"
        >
          {rendering && (
            <span className="w-4 h-4 border-2 border-[#0a0a0a]/30 border-t-[#0a0a0a] rounded-full animate-spin" />
          )}
          {rendering ? "Starting render…" : "Render film"}
        </button>
      </div>
    </div>
  );
}
