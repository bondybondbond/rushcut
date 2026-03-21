"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Clip } from "@/types/project";
import type { PendingUpload } from "./UploadZone";

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean; probe_error?: string; thumbnail?: string };

interface ClipListProps {
  clips: ClipWithProbeFlag[];
  pendingUploads?: PendingUpload[];
  onDelete: (clipId: string) => void;
  onReorder: (clips: ClipWithProbeFlag[]) => void;
  brief?: string;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Generic video icon shown when no thumbnail could be generated
function VideoIcon() {
  return (
    <svg className="w-10 h-10 text-[#555555]" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
    </svg>
  );
}

// Pending clip card — shown immediately when files are selected
function PendingClipCard({ upload }: { upload: PendingUpload }) {
  const isProbing = upload.progress >= 97;

  return (
    <div className="flex flex-col rounded-lg overflow-hidden border border-white/10 bg-[#111111]">
      {/* Square thumbnail area */}
      <div className="relative aspect-square bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {upload.thumbnail ? (
          <img
            src={upload.thumbnail}
            alt={upload.filename}
            className="w-full h-full object-cover opacity-60"
          />
        ) : (
          <VideoIcon />
        )}

        {/* Progress overlay at bottom of thumbnail */}
        {!upload.error && (
          <div className="absolute bottom-0 left-0 right-0">
            <div className="h-1.5 bg-black/40">
              <div
                className="h-full bg-[#22c55e] transition-all duration-300"
                style={{ width: `${upload.progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error overlay */}
        {upload.error && (
          <div className="absolute inset-0 bg-red-900/40 flex items-center justify-center p-2">
            <p className="text-red-300 text-xs text-center">{upload.error}</p>
          </div>
        )}

        {/* % badge */}
        {!upload.error && (
          <div className="absolute top-1.5 right-1.5 bg-black/60 rounded px-1.5 py-0.5 text-xs text-[#e5e5e5]">
            {isProbing ? "✓" : `${upload.progress}%`}
          </div>
        )}
      </div>

      {/* Filename */}
      <div className="px-2 py-2">
        <p className="text-[#e5e5e5] text-sm truncate" title={upload.filename}>
          {upload.filename}
        </p>
        <p className="text-[#555555] text-xs mt-0.5">
          {upload.error ? "Failed" : isProbing ? "Reading…" : "Uploading…"}
        </p>
      </div>
    </div>
  );
}

// Completed sortable clip card
interface SortableClipCardProps {
  clip: ClipWithProbeFlag;
  index: number;
  onDelete: (id: string) => void;
}

function SortableClipCard({ clip, index, onDelete }: SortableClipCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clip.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex flex-col rounded-lg overflow-hidden border bg-[#111111] cursor-grab active:cursor-grabbing select-none ${
        clip.probe_error ? "border-red-500/40" : "border-white/10"
      }`}
      {...attributes}
      {...listeners}
    >
      {/* Square thumbnail area */}
      <div className="relative aspect-square bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {clip.thumbnail ? (
          <img
            src={clip.thumbnail}
            alt={clip.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <VideoIcon />
        )}

        {/* Order badge — top left */}
        <div className="absolute top-1.5 left-1.5 bg-black/70 rounded px-1.5 py-0.5 text-xs text-[#e5e5e5] font-mono">
          {index + 1}
        </div>

        {/* Uploaded tick — top right, shown on hover reveals delete */}
        <div className="absolute top-1.5 right-1.5 group">
          {/* Tick (default) */}
          <div className="bg-black/70 rounded p-1 text-[#22c55e] group-hover:hidden">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
            </svg>
          </div>
          {/* Delete (shown on hover) */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
            className="hidden group-hover:block bg-black/70 rounded p-1 text-[#a3a3a3] hover:text-red-400 hover:bg-black/90 transition-colors"
            aria-label={`Delete ${clip.filename}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
          </button>
        </div>

        {/* Error overlay */}
        {clip.probe_error && (
          <div className="absolute bottom-0 left-0 right-0 bg-red-900/60 px-2 py-1">
            <p className="text-red-300 text-xs truncate">{clip.probe_error}</p>
          </div>
        )}
      </div>

      {/* Filename + duration */}
      <div className="px-2 py-2">
        <p className="text-[#e5e5e5] text-sm truncate" title={clip.filename}>
          {clip.filename}
        </p>
        <p className="text-[#a3a3a3] text-xs mt-0.5">
          {clip.duration_ms !== null
            ? formatDuration(clip.duration_ms)
            : <span className="text-[#22c55e]">Ready</span>
          }
          {clip.width && clip.height && (
            <span className="ml-2 text-[#555555]">{clip.width}×{clip.height}</span>
          )}
        </p>
      </div>
    </div>
  );
}

export function ClipList({ clips, pendingUploads = [], onDelete, onReorder, brief = "" }: ClipListProps) {
  const router = useRouter();
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allReady =
    clips.length >= 1 &&
    pendingUploads.length === 0 &&
    clips.every((c) => !c.probe_error);

  const totalCount = clips.length + pendingUploads.filter((p) => !p.error).length;

  async function handleDelete(clipId: string) {
    try { await fetch(`/api/clips/${clipId}`, { method: "DELETE" }); } catch { /* ok */ }
    onDelete(clipId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = clips.findIndex((c) => c.id === active.id);
    const newIndex = clips.findIndex((c) => c.id === over.id);
    const reordered = arrayMove(clips, oldIndex, newIndex);
    onReorder(reordered);
    fetch("/api/clips/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips: reordered.map((c, idx) => ({ id: c.id, order: idx + 1 })) }),
    }).catch(console.error);
  }

  async function handleContinue() {
    setJobError(null);
    setIsCreatingJob(true);
    try {
      const projectId = localStorage.getItem("rushcut_project_id");
      if (!projectId) { setJobError("No project found — please upload clips first."); return; }

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, brief }),
      });

      if (!res.ok) {
        const err = await res.json();
        setJobError(err.error ?? "Failed to create job");
        return;
      }

      const { jobId } = await res.json();
      // Clear stored project ID so the next session starts fresh (no orphaned clips)
      localStorage.removeItem("rushcut_project_id");
      router.push(`/preview/${jobId}`);
    } catch (err: unknown) {
      setJobError((err as Error).message);
    } finally {
      setIsCreatingJob(false);
    }
  }

  if (clips.length === 0 && pendingUploads.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* Order hint */}
      {totalCount >= 2 && (
        <p className="text-[#a3a3a3] text-sm">
          Clips will edit in this order. Drag to rearrange.
        </p>
      )}

      {/* Thumbnail grid — pending + completed mixed together, pending at end */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={clips.map((c) => c.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
            {clips.map((clip, idx) => (
              <SortableClipCard key={clip.id} clip={clip} index={idx} onDelete={handleDelete} />
            ))}
            {pendingUploads.map((upload) => (
              <PendingClipCard key={upload.tempId} upload={upload} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {jobError && <p className="text-red-400 text-sm">{jobError}</p>}

      <div className="flex justify-end pt-2">
        <button
          onClick={handleContinue}
          disabled={!allReady || isCreatingJob}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-base"
        >
          {isCreatingJob && (
            <span className="w-4 h-4 border-2 border-[#0a0a0a]/30 border-t-[#0a0a0a] rounded-full animate-spin" />
          )}
          {isCreatingJob ? "Starting…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
