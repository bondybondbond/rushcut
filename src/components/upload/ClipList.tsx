import { useState } from "react";
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

interface ClipListProps {
  clips: Clip[];
  onDelete: (clipId: string) => void;
  onReorder: (clips: Clip[]) => void;
  onContinue: () => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getResolutionLabel(width: number, height: number): { label: string; is4K: boolean } | null {
  const long = Math.max(width, height);
  if (long >= 3840) return { label: "4K", is4K: true };
  if (long >= 2560) return { label: "2.7K", is4K: true };
  if (long >= 1920) return { label: "FHD", is4K: false };
  return null;
}

function VideoIcon() {
  return (
    <svg className="w-10 h-10 text-[#a3a3a3]" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
    </svg>
  );
}

interface SortableClipCardProps {
  clip: Clip;
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
      data-testid="clip-item"
      style={style}
      className="flex flex-col rounded-lg overflow-hidden border border-white/10 bg-[#111111] cursor-grab active:cursor-grabbing select-none"
      {...attributes}
      {...listeners}
    >
      <div className="relative aspect-square bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {clip.thumbnail_data ? (
          <img src={clip.thumbnail_data} alt={clip.filename} className="w-full h-full object-cover" />
        ) : (
          <VideoIcon />
        )}
        <div className="absolute top-1.5 left-1.5 bg-black/70 rounded px-1.5 py-0.5 text-xs text-[#e5e5e5] font-mono">
          {index + 1}
        </div>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
          className="absolute top-1.5 right-1.5 bg-black/70 rounded p-1 text-red-400 hover:bg-black/90 transition-colors"
          aria-label={`Delete ${clip.filename}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
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

export function ClipList({ clips, onDelete, onReorder, onContinue }: ClipListProps) {
  const [, setForceRender] = useState(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allReady = clips.length >= 1;

  const has4K = clips.some((c) => {
    const res = getResolutionLabel(c.width, c.height);
    return res?.is4K;
  });

  function handleDelete(clipId: string) {
    onDelete(clipId);
    setForceRender((n) => n + 1);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = clips.findIndex((c) => c.id === active.id);
    const newIndex = clips.findIndex((c) => c.id === over.id);
    onReorder(arrayMove(clips, oldIndex, newIndex));
  }

  if (clips.length === 0) return null;

  return (
    <div className="space-y-4">
      {clips.length >= 2 && (
        <p className="text-[#e5e5e5] text-sm">
          Clips will edit in this order. Drag to rearrange. Bin to remove.
        </p>
      )}

      {has4K && (
        <p className="text-[#C9A96E] text-sm">
          Your clips will be processed at 1080p.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={clips.map((c) => c.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
            {clips.map((clip, idx) => (
              <SortableClipCard key={clip.id} clip={clip} index={idx} onDelete={handleDelete} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <div className="flex justify-end pt-2">
        <button
          onClick={onContinue}
          disabled={!allReady}
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed text-base"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
