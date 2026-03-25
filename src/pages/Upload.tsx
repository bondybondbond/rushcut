import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ClipMeta, Clip } from "@/types/project";
import { UploadZone } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";
import { NavDrawer } from "@/components/NavDrawer";

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
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);

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
      }
    } catch (e) {
      setError(`Scan failed: ${e}`);
      setFolderPath(null);
    } finally {
      setScanning(false);
    }
  }

  async function handleContinue() {
    if (clips.length === 0) return;
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

      // Derive project name from folder, or first clip's parent folder
      let projectName = "My Project";
      if (folderPath) {
        projectName = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? "My Project";
      } else if (clips.length > 0) {
        const parts = clips[0].local_path.split(/[/\\]/).filter(Boolean);
        if (parts.length >= 2) projectName = parts[parts.length - 2];
      }

      const projectId = await invoke<string>("create_project", {
        name: projectName,
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

  const busy = scanning || creating;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <NavDrawer />
            <div>
              <h1 className="text-2xl font-semibold text-[#e5e5e5]">RushCut</h1>
              <p className="text-[#a3a3a3] text-sm mt-1">Select clips to get started.</p>
            </div>
          </div>
        </div>

        {/* Picker buttons */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handlePickFolder}
            disabled={busy}
            className="px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {scanning ? "Scanning..." : "Choose Folder"}
          </button>
          <button
            onClick={handlePickFiles}
            disabled={busy}
            className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] font-semibold rounded-md hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add Files
          </button>
          {folderPath && (
            <span className="text-[#a3a3a3] text-sm truncate max-w-xs" title={folderPath}>
              {folderPath}
            </span>
          )}
        </div>

        {/* Drop zone + manual path fallback */}
        <UploadZone onFolderPath={scanFolder} disabled={busy} />

        {/* Error */}
        {error && <p className="text-red-400 text-sm">{error}</p>}

        {/* Clip list */}
        {clips.length > 0 && (
          <ClipList
            clips={clips}
            onDelete={handleDelete}
            onReorder={handleReorder}
            onContinue={handleContinue}
          />
        )}

        {creating && (
          <p className="text-[#a3a3a3] text-sm text-center">Creating project...</p>
        )}
      </div>
    </div>
  );
}
