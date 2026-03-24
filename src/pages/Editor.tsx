import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Clip, JobConfig, ProjectWithClips } from "@/types/project";
import { TimelineStrip } from "@/components/editor/TimelineStrip";

const DEFAULT_CONFIG: JobConfig = {
  music_mood: "cinematic",
  intro_text: "",
  outro_text: "",
  zoom: true,
};

export default function Editor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [clips, setClips] = useState<Clip[]>([]);
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
      })
      .catch((e) => setError(`Failed to load project: ${e}`))
      .finally(() => setLoading(false));
  }, [projectId]);

  async function handleRender() {
    if (!projectId || clips.length === 0) return;
    setRendering(true);
    setError(null);

    try {
      const jobId = await invoke<string>("start_job", {
        projectId,
        settingsJson: JSON.stringify(config),
      });
      navigate(`/output/${jobId}`);
    } catch (e) {
      setError(`Failed to start render: ${e}`);
      setRendering(false);
    }
  }

  function handleDelete(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  function handleReorder(reordered: Clip[]) {
    setClips(reordered);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <p className="text-[#a3a3a3]">Loading project...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div>
          <h1 className="text-lg font-semibold text-[#e5e5e5]">{projectName || "Editor"}</h1>
          <p className="text-xs text-[#555555]">{clips.length} clip{clips.length !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={handleRender}
          disabled={rendering || clips.length === 0}
          className="px-6 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {rendering ? "Starting..." : "Render"}
        </button>
      </header>

      {/* Timeline */}
      <div className="px-6 pt-6 pb-4 border-b border-white/10">
        <TimelineStrip
          clips={clips}
          config={config}
          onReorder={handleReorder}
          onDelete={handleDelete}
        />
      </div>

      {/* Settings panel */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <h2 className="text-sm font-semibold text-[#a3a3a3] uppercase tracking-wider mb-4">Settings</h2>

        <div className="space-y-6 max-w-md">
          {/* Music mood */}
          <div>
            <label className="block text-sm text-[#e5e5e5] mb-2">Music</label>
            <div className="flex flex-wrap gap-2">
              {(["none", "cinematic", "upbeat", "chill", "electronic"] as JobConfig["music_mood"][]).map((mood) => (
                <button
                  key={mood}
                  onClick={() => setConfig((c) => ({ ...c, music_mood: mood }))}
                  className={`px-3 py-1.5 rounded-md text-sm capitalize transition-colors ${
                    config.music_mood === mood
                      ? "bg-[#C9A96E] text-[#0a0a0a] font-medium"
                      : "bg-white/10 text-[#a3a3a3] hover:bg-white/20"
                  }`}
                >
                  {mood}
                </button>
              ))}
            </div>
          </div>

          {/* Zoom toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-[#e5e5e5]">Ken Burns Zoom</p>
              <p className="text-xs text-[#555555] mt-0.5">Subtle zoom effect on clips</p>
            </div>
            <button
              onClick={() => setConfig((c) => ({ ...c, zoom: !c.zoom }))}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                config.zoom ? "bg-[#22c55e]" : "bg-white/20"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                  config.zoom ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Intro card */}
          <div>
            <label className="block text-sm text-[#e5e5e5] mb-2">Intro Card Text</label>
            <input
              type="text"
              value={config.intro_text}
              onChange={(e) => setConfig((c) => ({ ...c, intro_text: e.target.value }))}
              placeholder="Leave blank to skip"
              className="w-full bg-[#111111] border border-white/10 rounded-md px-3 py-2 text-[#e5e5e5] text-sm placeholder:text-[#555555] focus:outline-none focus:border-[#C9A96E]/50"
            />
          </div>

          {/* Outro card */}
          <div>
            <label className="block text-sm text-[#e5e5e5] mb-2">Outro Card Text</label>
            <input
              type="text"
              value={config.outro_text}
              onChange={(e) => setConfig((c) => ({ ...c, outro_text: e.target.value }))}
              placeholder="Leave blank to skip"
              className="w-full bg-[#111111] border border-white/10 rounded-md px-3 py-2 text-[#e5e5e5] text-sm placeholder:text-[#555555] focus:outline-none focus:border-[#C9A96E]/50"
            />
          </div>
        </div>

        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
      </div>
    </div>
  );
}
