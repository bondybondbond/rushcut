import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Clip, JobConfig, ProjectWithClips } from "@/types/project";
import { TimelineStrip } from "@/components/editor/TimelineStrip";
import { SettingsPanel } from "@/components/editor/SettingsPanel";
import { NavDrawer } from "@/components/NavDrawer";

const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  intro_text: "",
  intro_color: "#000000",
  outro_text: "",
  outro_color: "#000000",
  zoom: false,
  filter_boring: false,
};

export default function Editor() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [clips, setClips] = useState<Clip[]>([]);
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Project name inline edit
  const [projectName, setProjectName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
        setNameInput(data.project.name);
      })
      .catch((e) => setError(`Failed to load project: ${e}`))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  async function commitNameEdit() {
    const trimmed = nameInput.trim();
    setEditingName(false);
    if (!trimmed || trimmed === projectName || !projectId) return;
    setProjectName(trimmed);
    try {
      await invoke("rename_project_cmd", { projectId, name: trimmed });
    } catch {
      // revert on failure
      setProjectName(projectName);
      setNameInput(projectName);
    }
  }

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
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            {/* Editable project name */}
            {editingName ? (
              <input
                ref={nameInputRef}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={commitNameEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitNameEdit();
                  if (e.key === "Escape") { setEditingName(false); setNameInput(projectName); }
                }}
                className="text-2xl font-semibold bg-transparent border-b border-[#C9A96E] text-[#e5e5e5] focus:outline-none w-72"
              />
            ) : (
              <button
                onClick={() => { setNameInput(projectName); setEditingName(true); }}
                className="group flex items-center gap-2 text-left"
              >
                <h1 className="text-2xl font-semibold text-[#e5e5e5]">{projectName || "Project"}</h1>
                <svg
                  className="w-4 h-4 text-[#a3a3a3] opacity-0 group-hover:opacity-100 transition-opacity"
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M15.232 5.232l3.536 3.536M9 13l-4 1 1-4L14.586 2.414a2 2 0 012.828 0l1.172 1.172a2 2 0 010 2.828L9 13z" />
                </svg>
              </button>
            )}
            <p className="text-[#a3a3a3] text-sm mt-1">
              {clips.length} clip{clips.length !== 1 ? "s" : ""}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <NavDrawer />
            <button
              onClick={() => navigate("/library")}
              className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
            >
              ← Back
            </button>
            <button
              onClick={handleRender}
              disabled={rendering || clips.length === 0}
              className="px-6 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {rendering ? "Starting..." : "Render"}
            </button>
          </div>
        </div>

        {/* Timeline */}
        <div className="border border-white/10 rounded-lg p-4">
          <TimelineStrip
            clips={clips}
            config={config}
            onReorder={handleReorder}
            onDelete={handleDelete}
          />
        </div>

        {/* Settings */}
        <SettingsPanel config={config} onChange={setConfig} />

        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </div>
  );
}
