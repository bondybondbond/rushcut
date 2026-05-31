import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ClipMeta, Clip, ProjectSummary } from "@/types/project";
import { UploadZone } from "@/components/upload/UploadZone";

// Convert ClipMeta (from scan) to Clip (for UI display)
function metaToClip(meta: ClipMeta, idx: number, existingCount = 0): Clip {
  return {
    ...meta,
    id: `scan-${existingCount + idx}`,
    project_id: "",
    sort_order: existingCount + idx,
    thumbnail_data: meta.thumbnail_data ?? null,
    created_at: new Date().toISOString(),
    // Review fields — defaults until Trimmer screen sets them
    in_ms: null,
    out_ms: null,
    focal_x: null,
    focal_y: null,
    zoom_mode: null,
    include: 0, // explicit-add model: clips start excluded; user adds in Trimmer
    proxy_path: null,
    waveform_data: null,
    clip_volume: 1.0,
    proxy_status: null,
  };
}

export default function Upload() {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  // knownCount: exact clip count (file picker) or null (folder scan — count unknown until done)
  const [knownCount, setKnownCount] = useState<number | null>(null);
  const [visibleSkeletons, setVisibleSkeletons] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  // Drive skeleton card count: known = show all at once; unknown = grow one per 200ms
  useEffect(() => {
    if (!scanning) {
      setVisibleSkeletons(0);
      return;
    }
    if (knownCount !== null) {
      setVisibleSkeletons(knownCount);
      return;
    }
    // Folder scan — unknown count: show 1 immediately then grow
    setVisibleSkeletons(1);
    const interval = setInterval(() => {
      setVisibleSkeletons((n) => (n < 24 ? n + 1 : n));
    }, 200);
    return () => clearInterval(interval);
  }, [scanning, knownCount]);

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
      setKnownCount(paths.length);
      setScanning(true);
      try {
        const metas = await invoke<ClipMeta[]>("probe_files", { paths });
        if (metas.length === 0) {
          setError("No valid video files found in selection.");
        } else {
          const newClips = metas.map((m, i) => metaToClip(m, i));
          setClips(newClips);
          // Derive name from the folder containing the first file
          const parts = metas[0].local_path.split(/[/\\]/).filter(Boolean);
          const suggested = parts.length >= 2 ? parts[parts.length - 2] : "My Project";
          setPendingName(suggested);
          setShowNameModal(true);
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
    setKnownCount(null);
    setScanning(true);
    setClips([]);

    try {
      const metas = await invoke<ClipMeta[]>("scan_folder", { folderPath: path });
      if (metas.length === 0) {
        setError("No video files found in that folder (MP4, MOV, MKV).");
      } else {
        setClips(metas.map((m, i) => metaToClip(m, i)));
        // Derive name from folder path
        const suggested = path.split(/[/\\]/).filter(Boolean).pop() ?? "My Project";
        setPendingName(suggested);
        setShowNameModal(true);
      }
    } catch (e) {
      setError(`Scan failed: ${e}`);
    } finally {
      setScanning(false);
    }
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

      // Batch S4: encode ALL scanned clips at low priority from scan completion — gives
      // the full session time (Upload → Trimmer → Arrange → Sound) as warm-up buffer.
      // allClips=true bypasses the include=1 filter so clips the user hasn't selected yet
      // are still pre-encoded. Wasted work on unused clips is acceptable vs gate wait.
      // Safe here: brand-new project has no concurrent render job.
      invoke("generate_proxies_cmd", { projectId, lowPriority: true, allClips: true }).catch(() => {});

      navigate(`/trimmer/${projectId}`);
    } catch (e) {
      setError(`Failed to create project: ${e}`);
      setCreating(false);
    }
  }

  // ----- Scanning overlay (shown while scan is in progress) -----
  if (scanning) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
        <div className="max-w-3xl mx-auto space-y-5">
          {/* Spinner + label */}
          <div data-testid="scan-spinner" className="flex items-center gap-3">
            <span className="inline-block w-5 h-5 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <span className="text-[#e5e5e5] text-sm">Scanning your clips...</span>
          </div>
          {/* Progressive skeleton grid */}
          {visibleSkeletons > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {Array.from({ length: visibleSkeletons }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-lg overflow-hidden border border-white/10 bg-[#111111]"
                  style={{
                    animation: "rc-fly-in 0.2s ease both",
                    animationDelay: knownCount !== null ? `${i * 50}ms` : "0ms",
                  }}
                >
                  <div className="aspect-video bg-white/10 animate-pulse" />
                  <div className="px-2 py-1.5 space-y-1">
                    <div className="h-2.5 bg-white/10 animate-pulse rounded w-3/4" />
                    <div className="h-2 bg-white/10 animate-pulse rounded w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ----- Home view -----
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-4xl mx-auto space-y-10 pt-8">
        {/* Wordmark */}
        <div className="text-center">
          <h1 className="text-4xl font-bold text-[#e5e5e5] tracking-tight">RushCut</h1>
          <p className="text-[#e5e5e5]/60 text-sm mt-2">Turn raw clips into a film in minutes.</p>
        </div>

        {/* Two-card layout */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Left: Start New Project */}
          <div className="border border-[#FF8A65]/40 rounded-xl p-6 space-y-5 bg-[#FF8A65]/5">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-[#e5e5e5]">Start New Project</p>
              <p className="text-sm text-[#e5e5e5]/60">Create a film in minutes.</p>
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
            <p className="text-xs text-[#e5e5e5]/50">
              Output: 1080p &middot; <span className="text-[#C9A96E]">4K coming soon</span>
            </p>
          </div>

          {/* Right: Resume a Project */}
          <div className="border border-[#C9A96E]/40 rounded-xl p-6 space-y-4 bg-[#C9A96E]/5">
            <div className="space-y-1">
              <p className="text-lg font-semibold text-[#e5e5e5]">Resume a Project</p>
              <p className="text-sm text-[#e5e5e5]/60">Pick up where you left off.</p>
            </div>
            {loadingRecents ? (
              <p className="text-[#e5e5e5]/60 text-sm">Loading...</p>
            ) : recentProjects.length === 0 ? (
              <p className="text-[#e5e5e5]/60 text-sm">No projects yet.</p>
            ) : (
              <div className="space-y-2">
                {recentProjects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => navigate(`/trimmer/${p.id}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left"
                  >
                    <div className="w-10 h-8 rounded bg-[#1a1a1a] border border-white/10 flex-shrink-0 overflow-hidden flex items-center justify-center">
                      {p.first_clip_thumbnail ? (
                        <img src={p.first_clip_thumbnail} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <svg className="w-4 h-4 text-[#e5e5e5]/60" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[#e5e5e5] text-sm font-medium truncate">{p.name}</p>
                      <p className="text-[#e5e5e5]/50 text-xs">
                        {new Date(p.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                        {" · "}{p.file_count} file{p.file_count !== 1 ? "s" : ""} &middot; {p.cut_count} cut{p.cut_count !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => navigate("/library")}
              className="text-xs text-[#e5e5e5]/50 hover:text-[#C9A96E] transition-colors"
            >
              View all projects -&gt;
            </button>
          </div>
        </div>

        {error && <p data-testid="upload-error" className="text-red-400 text-sm">{error}</p>}
        {creating && (
          <p className="text-[#e5e5e5]/60 text-sm text-center">Creating project...</p>
        )}
      </div>

      {/* Name modal — appears directly after scan completes */}
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
          </div>
        </div>
      )}
    </div>
  );
}
