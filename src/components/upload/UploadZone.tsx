"use client";

import { useRef, useState, DragEvent, ChangeEvent } from "react";
import type { Clip } from "@/types/project";

const MAX_FILE_SIZE = 1073741824; // 1 GB

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean };

interface UploadZoneProps {
  onClipsAdded: (clips: ClipWithProbeFlag[]) => void;
}

interface PerClipProgress {
  filename: string;
  progress: number; // 0–100
  error?: string;
}

export function UploadZone({ onClipsAdded }: UploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [perClipProgress, setPerClipProgress] = useState<Record<string, PerClipProgress>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  function updateProgress(tempId: string, update: Partial<PerClipProgress>) {
    setPerClipProgress((prev) => ({
      ...prev,
      [tempId]: { ...prev[tempId], ...update },
    }));
  }

  function removeProgress(tempId: string) {
    setPerClipProgress((prev) => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });
  }

  async function handleFiles(files: FileList | File[]) {
    setGlobalError(null);
    const fileArray = Array.from(files);

    // Client-side size guard
    const oversized = fileArray.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      setGlobalError(
        `These files exceed the 1 GB limit: ${oversized.map((f) => f.name).join(", ")}`
      );
      return;
    }

    const completedClips: ClipWithProbeFlag[] = [];

    // Sequential uploads — await each before starting next
    for (const file of fileArray) {
      const tempId = `${file.name}-${Date.now()}`;
      updateProgress(tempId, { filename: file.name, progress: 0 });

      try {
        // Step 1: Presign
        const storedProjectId = localStorage.getItem("rushcut_project_id");
        const presignRes = await fetch("/api/upload/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            contentType: file.type || "video/mp4",
            projectId: storedProjectId ?? undefined,
          }),
        });

        if (!presignRes.ok) {
          const err = await presignRes.json();
          updateProgress(tempId, { error: err.error ?? "Presign failed" });
          continue;
        }

        const { uploadUrl, clipId, projectId } = await presignRes.json();

        // Store projectId after first presign
        localStorage.setItem("rushcut_project_id", projectId);

        // Step 2: XHR PUT to R2 with progress tracking
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", uploadUrl);
          xhr.setRequestHeader("Content-Type", file.type || "video/mp4");

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              updateProgress(tempId, { progress: pct });
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              updateProgress(tempId, { progress: 100 });
              resolve();
            } else {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          };

          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.send(file);
        });

        // Step 3: Probe
        let probeSkipped = false;
        let duration_ms: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let fps: number | null = null;

        try {
          const probeRes = await fetch("/api/clips/probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId }),
          });

          if (probeRes.ok) {
            const probeData = await probeRes.json();
            if (probeData.skipped) {
              probeSkipped = true;
            } else {
              duration_ms = probeData.duration_ms ?? null;
              width = probeData.width ?? null;
              height = probeData.height ?? null;
              fps = probeData.fps ?? null;
            }
          }
        } catch {
          // Non-fatal — probe failure doesn't block the upload flow
          probeSkipped = true;
        }

        const clip: ClipWithProbeFlag = {
          id: clipId,
          project_id: projectId,
          filename: file.name,
          r2_key: `projects/${projectId}/clips/${clipId}/${file.name}`,
          order: 0, // will be set by server; placeholder
          duration_ms,
          size_bytes: file.size,
          width,
          height,
          fps,
          created_at: new Date().toISOString(),
          probe_skipped: probeSkipped,
        };

        completedClips.push(clip);
        removeProgress(tempId);
      } catch (err: unknown) {
        const error = err as Error;
        updateProgress(tempId, { error: error.message });
      }
    }

    if (completedClips.length > 0) {
      onClipsAdded(completedClips);
    }
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      // Reset so the same file can be re-selected
      e.target.value = "";
    }
  }

  const uploading = Object.values(perClipProgress);

  return (
    <div>
      <div
        className="border-2 border-dashed border-white/20 rounded-lg p-12 text-center hover:border-white/30 transition-all duration-200 cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <p className="text-[#a3a3a3] text-sm">
          Drag clips here, or click to browse
        </p>
        <p className="text-[#555555] text-xs mt-2">
          MP4 &middot; MOV &middot; MKV &middot; up to 1 GB per file &middot; max 20 clips
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={onInputChange}
      />

      {globalError && (
        <p className="text-red-400 text-sm mt-3">{globalError}</p>
      )}

      {uploading.length > 0 && (
        <div className="mt-4 space-y-3">
          {uploading.map((item) => (
            <div key={item.filename} className="space-y-1">
              <div className="flex justify-between text-xs text-[#a3a3a3]">
                <span className="truncate max-w-[70%]">{item.filename}</span>
                {item.error ? (
                  <span className="text-red-400">{item.error}</span>
                ) : (
                  <span>{item.progress}%</span>
                )}
              </div>
              {!item.error && (
                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#e5e5e5] transition-all duration-200"
                    style={{ width: `${item.progress}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
