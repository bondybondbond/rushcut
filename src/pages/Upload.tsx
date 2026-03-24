import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ClipMeta, Clip } from "@/types/project";
import { UploadZone } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";

// Convert ClipMeta (from scan) to Clip (for UI display)
function metaToClip(meta: ClipMeta, idx: number): Clip {
  return {
    ...meta,
    id: `scan-${idx}`,
    project_id: "",
    sort_order: idx,
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
        setClips(metas.map(metaToClip));
      }
    } catch (e) {
      setError(`Scan failed: ${e}`);
      setFolderPath(null);
    } finally {
      setScanning(false);
    }
  }

  async function handleContinue() {
    if (clips.length === 0 || !folderPath) return;
    setCreating(true);
    setError(null);

    try {
      // Build ordered ClipMeta list from current clips state (user may have reordered/deleted)
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

      const projectName = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? "Project";
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

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[#e5e5e5]">RushCut</h1>
            <p className="text-[#a3a3a3] text-sm mt-1">Select a folder of clips to get started.</p>
          </div>
          <button
            onClick={() => navigate("/library")}
            className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
          >
            My Projects
          </button>
        </div>

        {/* Folder picker button */}
        <div className="flex items-center gap-3">
          <button
            onClick={handlePickFolder}
            disabled={scanning || creating}
            className="px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {scanning ? "Scanning..." : "Choose Folder"}
          </button>
          {folderPath && (
            <span className="text-[#a3a3a3] text-sm truncate max-w-xs" title={folderPath}>
              {folderPath}
            </span>
          )}
        </div>

        {/* Drop zone + manual path fallback */}
        <UploadZone onFolderPath={scanFolder} disabled={scanning || creating} />

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
