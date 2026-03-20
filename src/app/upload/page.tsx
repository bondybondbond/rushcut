"use client";

import { useState } from "react";
import { StepIndicator } from "@/components/StepIndicator";
import { UploadZone } from "@/components/upload/UploadZone";
import { ClipList } from "@/components/upload/ClipList";
import type { Clip } from "@/types/project";

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean };

export default function UploadPage() {
  const [clips, setClips] = useState<ClipWithProbeFlag[]>([]);

  function handleClipsAdded(newClips: ClipWithProbeFlag[]) {
    setClips((prev) => [...prev, ...newClips]);
  }

  function handleDelete(clipId: string) {
    setClips((prev) => prev.filter((c) => c.id !== clipId));
  }

  function handleReorder(reordered: ClipWithProbeFlag[]) {
    setClips(reordered);
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="mb-8">
        <StepIndicator currentStep="upload" />
      </div>
      <h2 className="text-2xl font-semibold text-[#e5e5e5] mb-2">
        Select your clips
      </h2>
      <p className="text-[#a3a3a3] mb-8">
        Up to 10 clips. MP4, MOV or MKV, up to 1 GB each.
      </p>
      <UploadZone onClipsAdded={handleClipsAdded} currentCount={clips.length} />
      <div className="mt-6">
        <ClipList
          clips={clips}
          onDelete={handleDelete}
          onReorder={handleReorder}
        />
      </div>
      <div className="mt-6">
        <p className="text-[#a3a3a3] text-sm mb-2">Optional — describe your edit</p>
        <input
          type="text"
          placeholder="e.g. fast cuts, upbeat, travel feel"
          className="w-full bg-transparent border border-white/20 rounded-md px-4 py-2.5 text-[#e5e5e5] placeholder-[#555555] text-sm focus:outline-none focus:border-white/40"
        />
        <p className="text-[#555555] text-xs mt-2">
          We will use this as a starting point. You can always adjust.
        </p>
      </div>
    </div>
  );
}
