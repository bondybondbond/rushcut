"use client";

import { useRef, useState, DragEvent, ChangeEvent } from "react";
import type { Clip } from "@/types/project";

const MAX_FILE_SIZE = 1073741824; // 1 GB
const MAX_CLIPS = 20;

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean; probe_error?: string };

export interface PendingUpload {
  tempId: string;
  filename: string;
  size: number;
  progress: number; // 0–100
  thumbnail?: string; // base64 data URL — captured from local File immediately
  error?: string;
}

interface UploadZoneProps {
  onFilesQueued: (files: Pick<PendingUpload, "tempId" | "filename" | "size" | "thumbnail">[]) => void;
  onFileProgress: (tempId: string, progress: number) => void;
  onFileComplete: (tempId: string, clip: ClipWithProbeFlag) => void;
  onFileError: (tempId: string, error: string) => void;
  currentCount?: number;
}

// Capture a centered-square JPEG thumbnail from a local File without uploading it.
// Returns null if the browser cannot decode the video (e.g. HEVC without codec).
async function generateThumbnail(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;

    function finish(result: string | null) {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(result);
    }

    const timer = setTimeout(() => finish(null), 6000);

    video.addEventListener("loadedmetadata", () => {
      // Seek slightly in so we don't get a black first frame
      video.currentTime = Math.min(1.5, video.duration * 0.08 || 1.5);
    });

    video.addEventListener("seeked", () => {
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) { clearTimeout(timer); finish(null); return; }

        const canvas = document.createElement("canvas");
        const SIZE = 160;
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) { clearTimeout(timer); finish(null); return; }

        // Center-crop to square
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        ctx.drawImage(video, sx, sy, side, side, 0, 0, SIZE, SIZE);

        clearTimeout(timer);
        finish(canvas.toDataURL("image/jpeg", 0.65));
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });

    video.addEventListener("error", () => { clearTimeout(timer); finish(null); });

    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = url;
  });
}

export function UploadZone({
  onFilesQueued,
  onFileProgress,
  onFileComplete,
  onFileError,
  currentCount = 0,
}: UploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  async function handleFiles(files: FileList | File[]) {
    setGlobalError(null);
    const fileArray = Array.from(files);

    const remaining = MAX_CLIPS - currentCount;
    if (remaining <= 0) {
      setGlobalError(`Maximum ${MAX_CLIPS} clips reached.`);
      return;
    }
    const toProcess = fileArray.slice(0, remaining);
    if (toProcess.length < fileArray.length) {
      setGlobalError(
        `Only ${remaining} clip${remaining === 1 ? "" : "s"} added — maximum ${MAX_CLIPS} clips per project.`
      );
    }

    const oversized = toProcess.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      setGlobalError(`These files exceed the 1 GB limit: ${oversized.map((f) => f.name).join(", ")}`);
      return;
    }

    // Generate thumbnails from local files in parallel — no network needed
    const thumbnails = await Promise.all(toProcess.map(generateThumbnail));

    // Queue ALL files immediately — they appear in the grid right now
    const queuedFiles = toProcess.map((file, i) => ({
      tempId: `${file.name}-${Date.now()}-${i}`,
      filename: file.name,
      size: file.size,
      thumbnail: thumbnails[i] ?? undefined,
    }));
    onFilesQueued(queuedFiles);

    // Step 1: Presign all files sequentially (establishes projectId on first call)
    type PresignResult =
      | { ok: true; uploadUrl: string; clipId: string; projectId: string }
      | { ok: false; error: string };

    const presignResults: PresignResult[] = [];
    for (let i = 0; i < toProcess.length; i++) {
      const file = toProcess[i];
      const { tempId } = queuedFiles[i];
      try {
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
          presignResults.push({ ok: false, error: err.error ?? "Upload setup failed" });
          onFileError(tempId, err.error ?? "Upload setup failed");
          continue;
        }
        const data = await presignRes.json();
        localStorage.setItem("rushcut_project_id", data.projectId);
        presignResults.push({ ok: true, ...data });
      } catch (err: unknown) {
        const msg = (err as Error).message;
        presignResults.push({ ok: false, error: msg });
        onFileError(tempId, msg);
      }
    }

    // Step 2: Upload all files in parallel
    async function uploadOne(
      file: File,
      tempId: string,
      presign: PresignResult
    ): Promise<void> {
      if (!presign.ok) return; // already reported error above

      const { uploadUrl, clipId, projectId } = presign;

      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", uploadUrl);
          xhr.setRequestHeader("Content-Type", file.type || "video/mp4");

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 95);
              onFileProgress(tempId, pct);
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              onFileProgress(tempId, 97);
              resolve();
            } else {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          };

          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.send(file);
        });

        // Step 3: Probe — with 12s timeout so we never hang locally
        let probeSkipped = false;
        let probeError: string | undefined;
        let duration_ms: number | null = null;
        let width: number | null = null;
        let height: number | null = null;
        let fps: number | null = null;

        try {
          const controller = new AbortController();
          const probeTimer = setTimeout(() => controller.abort(), 12000);

          const probeRes = await fetch("/api/clips/probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId }),
            signal: controller.signal,
          });
          clearTimeout(probeTimer);

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
          } else {
            probeError = "This clip couldn't be read — try re-exporting from your camera app";
          }
        } catch {
          probeSkipped = true;
        }

        onFileProgress(tempId, 100);

        const clip: ClipWithProbeFlag = {
          id: clipId,
          project_id: projectId,
          filename: file.name,
          r2_key: `projects/${projectId}/clips/${clipId}/${file.name}`,
          order: 0,
          duration_ms,
          size_bytes: file.size,
          width,
          height,
          fps,
          created_at: new Date().toISOString(),
          probe_skipped: probeSkipped,
          probe_error: probeError,
        };

        onFileComplete(tempId, clip);
      } catch (err: unknown) {
        onFileError(tempId, (err as Error).message);
      }
    }

    // Fire all uploads simultaneously
    await Promise.all(
      toProcess.map((file, i) => uploadOne(file, queuedFiles[i].tempId, presignResults[i]))
    );
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }
  function onDragLeave() { setIsDragOver(false); }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  }
  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  }

  return (
    <div>
      <div
        className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-all duration-200 ${
          isDragOver ? "border-[#FF8A65]/60 bg-[#FF8A65]/5" : "border-white/25 hover:border-white/40"
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <p className="text-[#e5e5e5] text-base">Drag clips here, or click to browse</p>
        <p className="text-[#a3a3a3] text-sm mt-2">
          MP4 · MOV · MKV · up to 1 GB per file · max {MAX_CLIPS} clips
        </p>
      </div>

      <input ref={fileInputRef} type="file" accept="video/*" multiple className="hidden" onChange={onInputChange} />
      {globalError && <p className="text-red-400 text-sm mt-3">{globalError}</p>}
    </div>
  );
}
