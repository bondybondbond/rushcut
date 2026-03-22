"use client";

import { useState, useRef } from "react";
import { StepIndicator } from "@/components/StepIndicator";
import { UploadZone, PendingUpload } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";
import type { Clip } from "@/types/project";

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean; probe_error?: string };

export default function UploadPage() {
  const [clips, setClips] = useState<ClipWithProbeFlag[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [brief, setBrief] = useState("");

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

      <h2 className="text-3xl font-semibold text-[#FF8A65] mb-2">
        Select your clips
      </h2>
      <p className="text-[#e5e5e5] text-base mb-8">
        Up to 20 clips. MP4, MOV or MKV, up to 1 GB each.
      </p>

      <UploadZone
        onFilesQueued={handleFilesQueued}
        onFileProgress={handleFileProgress}
        onFileComplete={handleFileComplete}
        onFileError={handleFileError}
        currentCount={totalCount}
      />

      {/* Upload counter — shown while any uploads are in progress */}
      {isUploading && (
        <p className="text-[#a3a3a3] text-sm mt-4">
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
          brief={brief}
        />
      </div>

      {(clips.length > 0 || pendingUploads.length > 0) && (
        <div className="mt-6">
          <p className="text-[#e5e5e5] text-sm mb-2">Optional — describe your edit</p>
          <input
            type="text"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. fast cuts, upbeat, travel feel"
            className="w-full bg-transparent border border-white/20 rounded-md px-4 py-3 text-[#e5e5e5] placeholder-[#555555] text-base focus:outline-none focus:border-white/40"
          />
          <p className="text-[#a3a3a3] text-sm mt-2">
            We will use this as a starting point. You can always adjust.
          </p>
        </div>
      )}
    </div>
  );
}
