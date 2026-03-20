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
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Clip } from "@/types/project";

type ClipWithProbeFlag = Clip & { probe_skipped?: boolean; probe_error?: string };

interface ClipListProps {
  clips: ClipWithProbeFlag[];
  onDelete: (clipId: string) => void;
  onReorder: (clips: ClipWithProbeFlag[]) => void;
}

function formatDuration(ms: number | null, probeSkipped?: boolean): string {
  if (ms === null) {
    return probeSkipped ? "processing…" : "—";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

interface SortableClipRowProps {
  clip: ClipWithProbeFlag;
  onDelete: (id: string) => void;
}

function SortableClipRow({ clip, onDelete }: SortableClipRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clip.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex flex-col border rounded-lg bg-white/5 ${
        clip.probe_error ? "border-red-500/40" : "border-white/10"
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Drag handle */}
        <button
          {...attributes}
          {...listeners}
          className="text-[#555555] hover:text-[#a3a3a3] cursor-grab active:cursor-grabbing shrink-0"
          aria-label="Drag to reorder"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="3" y="3" width="10" height="2" rx="1" />
            <rect x="3" y="7" width="10" height="2" rx="1" />
            <rect x="3" y="11" width="10" height="2" rx="1" />
          </svg>
        </button>

        {/* Filename */}
        <span className="text-[#e5e5e5] text-sm truncate flex-1">{clip.filename}</span>

        {/* Duration */}
        <span className="text-[#a3a3a3] text-xs shrink-0 w-14 text-right">
          {formatDuration(clip.duration_ms, clip.probe_skipped)}
        </span>

        {/* Resolution badge */}
        {clip.width && clip.height && (
          <span className="text-[#555555] text-xs shrink-0">
            {clip.width}×{clip.height}
          </span>
        )}

        {/* Delete */}
        <button
          onClick={() => onDelete(clip.id)}
          className="text-[#555555] hover:text-red-400 transition-colors shrink-0"
          aria-label={`Delete ${clip.filename}`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6 2a1 1 0 0 0-1 1v.5H3.5a.5.5 0 0 0 0 1H4v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-8h.5a.5.5 0 0 0 0-1H11V3a1 1 0 0 0-1-1H6zm0 1h4v.5H6V3zm-1 2h6v8H5V5zm2 1a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 1 0v-5A.5.5 0 0 0 7 6zm2 0a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 1 0v-5A.5.5 0 0 0 9 6z" />
          </svg>
        </button>
      </div>
      {clip.probe_error && (
        <p className="px-4 pb-3 text-red-400 text-xs">{clip.probe_error}</p>
      )}
    </div>
  );
}

export function ClipList({ clips, onDelete, onReorder }: ClipListProps) {
  const router = useRouter();
  const [isCreatingJob, setIsCreatingJob] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor));

  const allReady =
    clips.length >= 1 &&
    clips.every(
      (c) => !c.probe_error && (c.duration_ms !== null || c.probe_skipped === true)
    );

  async function handleDelete(clipId: string) {
    try {
      await fetch(`/api/clips/${clipId}`, { method: "DELETE" });
    } catch {
      // Proceed regardless — remove from UI
    }
    onDelete(clipId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = clips.findIndex((c) => c.id === active.id);
    const newIndex = clips.findIndex((c) => c.id === over.id);
    const reordered = arrayMove(clips, oldIndex, newIndex);

    onReorder(reordered);

    // Persist reorder
    fetch("/api/clips/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clips: reordered.map((c, idx) => ({ id: c.id, order: idx + 1 })),
      }),
    }).catch((err) => console.error("[ClipList] reorder persist failed:", err));
  }

  async function handleContinue() {
    setJobError(null);
    setIsCreatingJob(true);
    try {
      const projectId = localStorage.getItem("rushcut_project_id");
      if (!projectId) {
        setJobError("No project found — please upload clips first.");
        return;
      }

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });

      if (!res.ok) {
        const err = await res.json();
        setJobError(err.error ?? "Failed to create job");
        return;
      }

      const { jobId } = await res.json();
      router.push(`/preview/${jobId}`);
    } catch (err: unknown) {
      const error = err as Error;
      setJobError(error.message);
    } finally {
      setIsCreatingJob(false);
    }
  }

  if (clips.length === 0) {
    return (
      <div className="border border-white/10 rounded-lg p-6 text-center">
        <p className="text-[#555555] text-sm">Your clips will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={clips.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2">
            {clips.map((clip) => (
              <SortableClipRow key={clip.id} clip={clip} onDelete={handleDelete} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {jobError && (
        <p className="text-red-400 text-sm">{jobError}</p>
      )}

      <div className="flex justify-end pt-2">
        <button
          onClick={handleContinue}
          disabled={!allReady || isCreatingJob}
          className="inline-flex items-center px-5 py-2.5 bg-[#e5e5e5] text-[#0a0a0a] font-medium rounded-md hover:bg-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCreatingJob ? "Creating edit…" : "Make my edit"}
        </button>
      </div>
    </div>
  );
}
