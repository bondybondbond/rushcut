import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ClipMeta, Clip, ProjectSummary } from "@/types/project";
import { UploadZone } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";

// Convert ClipMeta (from scan) to Clip (for UI display)
function metaToClip(meta: ClipMeta, idx: number, existingCount = 0): Clip {
  return {
    ...meta,
    id: `scan-${existingCount + idx}`,
    project_id: "",
    sort_order: existingCount + idx,
    thumbnail_data: meta.thumbnail_data ?? null,
    created_at: new Date().toISOString(),
  };
}

export default function Upload() {
  const navigate = useNavigate();
  const [view, setView] = useState<"home" | "clips">("home");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [showNameModal, setShowNameModal] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);
  const [loadingRecents, setLoadingRecents] = useState(true);

  useEffect(() => {
    invoke<ProjectSummary[]>("list_projects_cmd")
      .then((projects) => setRecentProjects(projects.slice(0, 3)))
      .catch(() => setRecentProjects([]))
      .finally(() => setLoadingRecents(false));
  }, []);

  async function handlePickFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || typeof selected !== "string") return;
      await scanFolder(selected);
    } catch (e) {
      setError(`Failed to open folder picker: ${e}`);
    }
  }

  async function handlePickFiles() {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "avi", "mts", "MP4", "MOV", "MKV"] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      setError(null);
      setScanning(true);
      try {
        const metas = await invoke<ClipMeta[]>("probe_files", { paths });
        if (metas.length === 0) {
          setError("No valid video files found in selection.");
        } else {
          setClips((prev) => {
            const newClips = metas.map((m, i) => metaToClip(m, i, prev.length));
            return [...prev, ...newClips];
          });
          setView("clips");
        }
      } catch (e) {
        setError(`Probe failed: ${e}`);
      } finally {
        setScanning(false);
      }
    } catch (e) {
      setError(`Failed to open file picker: ${e}`);
    }
  }

  async function scanFolder(path: string) {
    setError(null);
    setScanning(true);
    setFolderPath(path);
    setClips([]);

    try {
      const metas = await invoke<ClipMeta[]>("scan_folder", { folderPath: path });
      if (metas.length === 0) {
        setError("No video files found in that folder (MP4, MOV, MKV).");
        setFolderPath(null);
      } else {
        setClips(metas.map((m, i) => metaToClip(m, i)));
        setView("clips");
      }
    } catch (e) {
      setError(`Scan failed: ${e}`);
      setFolderPath(null);
    } finally {
      setScanning(false);
    }
  }

  function deriveProjectName(): string {
    if (folderPath) {
      return folderPath.split(/[/\\]/).filter(Boolean).pop() ?? "My Project";
    }
    if (clips.length > 0) {
      const parts = clips[0].local_path.split(/[/\\]/).filter(Boolean);
      if (parts.length >= 2) return parts[parts.length - 2];
    }
    return "My Project";
  }

  // Intercept point for ClipList's onContinue — show name modal
  function handleContinueClick() {
    setPendingName("");
    setShowNameModal(true);
  }

  async function handleContinue(name: string) {
    if (clips.length === 0) return;
    setShowNameModal(false);
    setCreating(true);
    setError(null);

    try {
      const orderedMetas: ClipMeta[] = clips.map((c) => ({
        filename: c.filename,
        local_path: c.local_path,
        size_bytes: c.size_bytes,
        duration_ms: c.duration_ms,
        width: c.width,
        height: c.height,
        has_audio: c.has_audio,
        thumbnail_data: c.thumbnail_data ?? null,
      }));

      const projectId = await invoke<string>("create_project", {
        name,
        clips: orderedMetas,
      });

      navigate(`/editor/${projectId}`);
    } catch (e) {
      setError(`Failed to create project: ${e}`);
      setCreating(false);
    }
  }

  function handleDelete(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  function handleReorder(reordered: Clip[]) {
    setClips(reordered);
  }

  // ----- Scanning overlay (shown in any view while scan is in progress) -----
  if (scanning) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex items-center justify-center">
        <div data-testid="scan-spinner" className="flex flex-col items-center gap-4">
          <span className="inline-block w-8 h-8 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
          <span className="text-[#a3a3a3] text-sm">Scanning your clips...</span>
        </div>
      </div>
    );
  }

  // ----- Home view -----
  if (view === "home") {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
        <div className="max-w-4xl mx-auto space-y-10 pt-8">
          {/* Wordmark */}
          <div className="text-center">
            <h1 className="text-4xl font-bold text-[#e5e5e5] tracking-tight">RushCut</h1>
            <p className="text-[#a3a3a3] text-sm mt-2">Turn raw clips into a film in minutes.</p>
          </div>

          {/* Two-card layout */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {/* Left: Start New Project */}
            <div className="border border-[#FF8A65]/40 rounded-xl p-6 space-y-5 bg-[#FF8A65]/5">
              <div className="space-y-1">
                <p className="text-lg font-semibold text-[#e5e5e5]">Start New Project</p>
                <p className="text-sm text-[#a3a3a3]">Create a film in minutes.</p>
              </div>
              <div className="space-y-3">
                <button
                  data-testid="btn-choose-folder"
                  onClick={handlePickFolder}
                  className="w-full px-4 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors text-sm"
                >
                  Choose Folder
                </button>
                <button
                  data-testid="btn-add-files"
                  onClick={handlePickFiles}
                  className="w-full px-4 py-2.5 border border-white/30 text-[#e5e5e5] font-semibold rounded-md hover:bg-white/10 transition-colors text-sm"
                >
                  Add Files
                </button>
              </div>
              <UploadZone onFolderPath={scanFolder} disabled={false} />
              <p className="text-xs text-[#a3a3a3]">
                Output: 1080p &middot; <span className="text-[#C9A96E]">4K coming soon</span>
              </p>
            </div>

            {/* Right: Resume a Project */}
            <div className="border border-[#C9A96E]/40 rounded-xl p-6 space-y-4 bg-[#C9A96E]/5">
              <div className="space-y-1">
                <p className="text-lg font-semibold text-[#e5e5e5]">Resume a Project</p>
                <p className="text-sm text-[#a3a3a3]">Pick up where you left off.</p>
              </div>
              {loadingRecents ? (
                <p className="text-[#a3a3a3] text-sm">Loading...</p>
              ) : recentProjects.length === 0 ? (
                <p className="text-[#a3a3a3] text-sm">No projects yet.</p>
              ) : (
                <div className="space-y-2">
                  {recentProjects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/editor/${p.id}`)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left"
                    >
                      <div className="w-10 h-8 rounded bg-[#1a1a1a] border border-white/10 flex-shrink-0 flex items-center justify-center">
                        <svg className="w-4 h-4 text-[#a3a3a3]" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[#e5e5e5] text-sm font-medium truncate">{p.name}</p>
                        <p className="text-[#a3a3a3] text-xs">{p.clip_count} clip{p.clip_count !== 1 ? "s" : ""}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => navigate("/library")}
                className="text-xs text-[#a3a3a3] hover:text-[#C9A96E] transition-colors"
              >
                View all projects -&gt;
              </button>
            </div>
          </div>

          {error && <p data-testid="upload-error" className="text-red-400 text-sm">{error}</p>}
        </div>
      </div>
    );
  }

  // ----- Clips view -----
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[#e5e5e5]">New Project</h1>
            <p className="text-[#a3a3a3] text-sm mt-1">
              {folderPath
                ? folderPath.split(/[/\\]/).filter(Boolean).pop()
                : `${clips.length} file${clips.length !== 1 ? "s" : ""} selected`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              data-testid="btn-add-files"
              onClick={handlePickFiles}
              disabled={creating}
              className="px-4 py-2 border border-white/30 text-[#e5e5e5] text-sm font-medium rounded-md hover:bg-white/10 transition-colors disabled:opacity-40"
            >
              + Add Files
            </button>
            <button
              onClick={() => { setView("home"); setClips([]); setFolderPath(null); setError(null); }}
              className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
            >
              &lt;- Back
            </button>
          </div>
        </div>

        {error && <p data-testid="upload-error" className="text-red-400 text-sm">{error}</p>}

        <ClipList
          clips={clips}
          onDelete={handleDelete}
          onReorder={handleReorder}
          onContinue={handleContinueClick}
        />

        {creating && (
          <p className="text-[#a3a3a3] text-sm text-center">Creating project...</p>
        )}

        {/* Name modal */}
        {showNameModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-[#111111] border border-white/15 rounded-xl p-6 w-full max-w-sm space-y-4 shadow-2xl">
              <h2 className="text-lg font-semibold text-[#e5e5e5]">Name your project</h2>
              <input
                data-testid="input-project-name-modal"
                type="text"
                autoFocus
                placeholder="e.g. Dolomites Trip, Summer 2026"
                value={pendingName}
                onChange={(e) => setPendingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pendingName.trim().length >= 2) {
                    handleContinue(pendingName.trim());
                  }
                  if (e.key === "Escape") setShowNameModal(false);
                }}
                className="w-full bg-white/5 border border-white/20 rounded-md px-3 py-2.5 text-[#e5e5e5] placeholder:text-[#555555] focus:outline-none focus:border-[#C9A96E]/60"
              />
              <button
                data-testid="btn-create-project"
                onClick={() => handleContinue(pendingName.trim())}
                disabled={pendingName.trim().length < 2}
                className="w-full px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Create Project
              </button>
              <button
                data-testid="btn-skip-name"
                onClick={() => handleContinue(deriveProjectName())}
                className="w-full text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
              >
                Skip (use folder name)
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
