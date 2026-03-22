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
  onDismissFailed?: (tempId: string) => void;
  onReorder: (clips: ClipWithProbeFlag[]) => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getResolutionLabel(width: number | null, height: number | null): { label: string; is4K: boolean } | null {
  if (!width || !height) return null;
  const long = Math.max(width, height);
  if (long >= 3840) return { label: "4K", is4K: true };
  if (long >= 2560) return { label: "2.7K", is4K: true };
  if (long >= 1920) return { label: "FHD", is4K: false };
  return null;
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
function PendingClipCard({ upload, onDismiss }: { upload: PendingUpload; onDismiss?: () => void }) {
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
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="absolute top-1.5 right-1.5 bg-black/70 rounded p-1 text-[#a3a3a3] hover:text-red-400 hover:bg-black/90 transition-colors"
                aria-label={`Dismiss ${upload.filename}`}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                </svg>
              </button>
            )}
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

        {/* Delete button — always visible top-right */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
          className="absolute top-1.5 right-1.5 bg-black/70 rounded p-1 text-[#a3a3a3] hover:text-red-400 hover:bg-black/90 transition-colors"
          aria-label={`Delete ${clip.filename}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>

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
        <p className="text-[#e5e5e5] text-xs mt-0.5 flex items-center gap-1.5">
          <span>{formatDuration(clip.duration_ms)}</span>
          {(() => {
            const res = getResolutionLabel(clip.width, clip.height);
            if (!res) return null;
            return (
              <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${res.is4K ? "bg-[#C9A96E]/20 text-[#C9A96E]" : "bg-white/10 text-[#a3a3a3]"}`}>
                {res.label}
              </span>
            );
          })()}
        </p>
      </div>
    </div>
  );
}

export function ClipList({ clips, pendingUploads = [], onDelete, onDismissFailed, onReorder }: ClipListProps) {
  const router = useRouter();
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

  function handleContinue() {
    setJobError(null);
    const projectId = localStorage.getItem("rushcut_project_id");
    if (!projectId) {
      setJobError("Something went wrong — please refresh and re-upload your clips.");
      return;
    }
    router.push(`/editor/${projectId}`);
  }

  if (clips.length === 0 && pendingUploads.length === 0) return null;

  const has4K = clips.some((c) => {
    const res = getResolutionLabel(c.width, c.height);
    return res?.is4K;
  });

  return (
    <div className="space-y-4">
      {/* Order hint */}
      {totalCount >= 2 && (
        <p className="text-[#e5e5e5] text-sm">
          Clips will edit in this order. Drag to rearrange.
        </p>
      )}

      {/* 4K downscale notice */}
      {has4K && (
        <p className="text-[#C9A96E] text-sm flex items-center gap-1.5">
          Your clips will be processed at 1080p.
          <span
            title="4K and 2.7K footage is scaled to 1080p HD during render. Higher resolution output is on the roadmap."
            className="cursor-help inline-flex items-center"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="text-[#C9A96E]/60">
              <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
            </svg>
          </span>
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
              <PendingClipCard
                key={upload.tempId}
                upload={upload}
                onDismiss={upload.error && onDismissFailed ? () => onDismissFailed(upload.tempId) : undefined}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {jobError && <p className="text-red-400 text-sm">{jobError}</p>}

      <div className="flex justify-end pt-2">
        <button
          onClick={handleContinue}
          disabled={!allReady}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-base"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
