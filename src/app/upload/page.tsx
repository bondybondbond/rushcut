"use client";

import { useState, useRef, useEffect } from "react";
import { StepIndicator } from "@/components/StepIndicator";
import { UploadZone, PendingUpload } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";
import type { Clip } from "@/types/project";

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean; probe_error?: string };

export default function UploadPage() {
  const [clips, setClips] = useState<ClipWithProbeFlag[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);

  // Always start a fresh project on the upload page — no leftover state from prior sessions.
  // Auth-gated project resumption can be added in Phase 2 when user accounts land.
  useEffect(() => {
    localStorage.removeItem("rushcut_project_id");
  }, []);

  // Ref-based thumbnail store — avoids stale closure when reading thumbnail in handleFileComplete
  const thumbnailsRef = useRef<Map<string, string>>(new Map());

  // Called immediately when files are selected — they appear in the list at once
  function handleFilesQueued(files: Pick<PendingUpload, "tempId" | "filename" | "size" | "thumbnail">[]) {
    files.forEach((f) => {
      if (f.thumbnail) thumbnailsRef.current.set(f.tempId, f.thumbnail);
    });
    setPendingUploads((prev) => [
      ...prev,
      ...files.map((f) => ({ ...f, progress: 0 })),
    ]);
  }

  function handleFileProgress(tempId: string, progress: number) {
    setPendingUploads((prev) =>
      prev.map((p) => (p.tempId === tempId ? { ...p, progress } : p))
    );
  }

  function handleFileComplete(tempId: string, clip: ClipWithProbeFlag) {
    // Read thumbnail from ref — always fresh, not affected by stale closure
    const thumbnail = thumbnailsRef.current.get(tempId);
    thumbnailsRef.current.delete(tempId);
    const withThumb = { ...clip, thumbnail };
    setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId));
    setClips((prev) => [...prev, withThumb]);

    // Persist thumbnail to Supabase so the editor can display it without re-decoding the video
    // (DJI clips are HEVC — Chrome can't decode them without the H.265 extension)
    if (thumbnail && clip.id) {
      fetch(`/api/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thumbnail_data: thumbnail }),
      }).catch(() => {
        // Non-fatal — editor falls back to presigned URL video seek
      });
    }
  }

  function handleFileError(tempId: string, error: string) {
    setPendingUploads((prev) =>
      prev.map((p) => (p.tempId === tempId ? { ...p, error } : p))
    );
  }

  function handleDismissFailed(tempId: string) {
    setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId));
  }

  function handleDelete(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  function handleReorder(reordered: ClipWithProbeFlag[]) {
    setClips(reordered);
  }

  const totalCount = clips.length + pendingUploads.filter((p) => !p.error).length;
  const isUploading = pendingUploads.some((p) => !p.error);

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="upload" />
      </div>

      <h2 className="text-3xl font-semibold text-[#FF8A65] mb-6">
        Select your clips
      </h2>

      <UploadZone
        onFilesQueued={handleFilesQueued}
        onFileProgress={handleFileProgress}
        onFileComplete={handleFileComplete}
        onFileError={handleFileError}
        currentCount={totalCount}
      />

      {/* Upload counter — shown while any uploads are in progress */}
      {isUploading && (
        <p className="text-[#e5e5e5] text-sm mt-4">
          {clips.length} of {totalCount} clip{totalCount !== 1 ? "s" : ""} uploaded…
        </p>
      )}

      <div className="mt-6">
        <ClipList
          clips={clips}
          pendingUploads={pendingUploads}
          onDelete={handleDelete}
          onDismissFailed={handleDismissFailed}
          onReorder={handleReorder}
        />
      </div>
    </div>
  );
}
