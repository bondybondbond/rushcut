"use client";

import { useEffect, useState } from "react";
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
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Clip, JobConfig } from "@/types/project";
import { generateThumbnail } from "@/utils/thumbnail";

type ClipWithUrl = Clip & { presignedUrl: string | null };

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Shimmer skeleton placeholder shown while thumbnail loads
function ThumbnailSkeleton() {
  return (
    <div className="w-full h-full bg-[#1a1a1a] animate-pulse" />
  );
}

// Video icon for clips where thumbnail generation failed
function VideoIcon() {
  return (
    <div className="w-full h-full bg-[#1a1a1a] flex items-center justify-center">
      <svg className="w-8 h-8 text-[#555555]" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
      </svg>
    </div>
  );
}

// Transition icon between clips
function TransitionBadge({ style }: { style: JobConfig["transition"] }) {
  return (
    <div className="flex-shrink-0 flex flex-col items-center justify-center px-1 self-center">
      <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center" title={style === "crossfade" ? "Crossfade" : "Dip to black"}>
        {style === "crossfade" ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 6 C3 2, 9 2, 11 6 C9 10, 3 10, 1 6Z" stroke="#a3a3a3" strokeWidth="1" fill="none"/>
          </svg>
        ) : (
          <div className="w-2 h-2 rounded-full bg-[#a3a3a3]" />
        )}
      </div>
    </div>
  );
}

// Card block shown at start/end of timeline
function CardBlock({
  label,
  card,
}: {
  label: string;
  card: JobConfig["intro_card"] | JobConfig["end_card"];
}) {
  if (!card) return null;
  return (
    <div
      className="flex-shrink-0 w-20 h-28 rounded-lg border border-white/20 flex flex-col items-center justify-center p-2 text-center"
      style={{ backgroundColor: card.color + "33" }}
    >
      <div
        className="w-3 h-3 rounded-full mb-2 border border-white/30"
        style={{ backgroundColor: card.color }}
      />
      <p className="text-[10px] text-[#a3a3a3] font-medium">{label}</p>
      {card.text && (
        <p className="text-[9px] text-[#e5e5e5] mt-1 line-clamp-2 break-all">{card.text}</p>
      )}
    </div>
  );
}

// Individual sortable clip tile
interface SortableClipTileProps {
  clip: ClipWithUrl;
  index: number;
  thumbnail: string | null;
  loading: boolean;
  onDelete?: (clipId: string) => void;
}

function SortableClipTile({ clip, index, thumbnail, loading, onDelete }: SortableClipTileProps) {
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
      className="flex-shrink-0 w-20 flex flex-col rounded-lg overflow-hidden border border-white/10 bg-[#111111] cursor-grab active:cursor-grabbing select-none"
      {...attributes}
      {...listeners}
    >
      {/* Thumbnail area — prefer persisted thumbnail_data (JPEG from upload), fall back to video-seek */}
      <div className="relative w-20 h-28 overflow-hidden">
        {clip.thumbnail_data ? (
          <img src={clip.thumbnail_data} alt={clip.filename} className="w-full h-full object-cover" />
        ) : loading ? (
          <ThumbnailSkeleton />
        ) : thumbnail ? (
          <img src={thumbnail} alt={clip.filename} className="w-full h-full object-cover" />
        ) : (
          <VideoIcon />
        )}
        {/* Order badge */}
        <div className="absolute top-1 left-1 bg-black/70 rounded px-1 py-0.5 text-[10px] text-[#e5e5e5] font-mono">
          {index + 1}
        </div>
        {/* Delete button */}
        {onDelete && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(clip.id); }}
            className="absolute top-1 right-1 bg-black/70 rounded p-1 text-[#a3a3a3] hover:text-red-400 hover:bg-black/90 transition-colors"
            aria-label={`Delete ${clip.filename}`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
              <path d="M9 6V4h6v2"/>
            </svg>
          </button>
        )}
      </div>
      {/* Filename + duration */}
      <div className="px-1.5 py-1.5">
        <p className="text-[#e5e5e5] text-[9px] truncate leading-tight" title={clip.filename}>
          {clip.filename}
        </p>
        <p className="text-[#a3a3a3] text-[9px] mt-0.5 font-mono">
          {formatDuration(clip.duration_ms)}
        </p>
      </div>
    </div>
  );
}

interface TimelineStripProps {
  clips: ClipWithUrl[];
  config: JobConfig;
  onReorder: (clips: ClipWithUrl[]) => void;
  onDelete?: (clipId: string) => void;
}

export function TimelineStrip({ clips, config, onReorder, onDelete }: TimelineStripProps) {
  // Per-clip thumbnail state — each fires independently
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Trigger thumbnail generation when clip list changes.
  // Clips with thumbnail_data stored in DB skip this entirely — no video decode needed.
  // Only falls back to video seek for clips uploaded before thumbnail persistence was added.
  useEffect(() => {
    const newIds = clips
      .filter((c) => !c.thumbnail_data && c.presignedUrl && !(c.id in thumbnails) && !loadingIds.has(c.id))
      .map((c) => c.id);

    if (newIds.length === 0) return;

    setLoadingIds((prev) => {
      const next = new Set(prev);
      newIds.forEach((id) => next.add(id));
      return next;
    });

    // Fire all seeks in parallel, independent per-clip
    clips.forEach((clip) => {
      if (!newIds.includes(clip.id) || !clip.presignedUrl) return;
      generateThumbnail(clip.presignedUrl).then(({ thumbnail }) => {
        setThumbnails((prev) => ({ ...prev, [clip.id]: thumbnail }));
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(clip.id);
          return next;
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

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

  if (clips.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 border border-white/10 rounded-lg">
        <p className="text-[#555555] text-sm">No clips found for this project.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto pb-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex items-stretch gap-1 min-w-max px-1 py-2">
            {/* Intro card block */}
            {config.intro_card && (
              <>
                <CardBlock label="Intro" card={config.intro_card} />
                <TransitionBadge style={config.transition} />
              </>
            )}

            {clips.map((clip, idx) => (
              <div key={clip.id} className="flex items-center">
                <SortableClipTile
                  clip={clip}
                  index={idx}
                  thumbnail={thumbnails[clip.id] ?? null}
                  loading={loadingIds.has(clip.id)}
                  onDelete={onDelete}
                />
                {idx < clips.length - 1 && <TransitionBadge style={config.transition} />}
              </div>
            ))}

            {/* End card block */}
            {config.end_card && (
              <>
                <TransitionBadge style={config.transition} />
                <CardBlock label="End" card={config.end_card} />
              </>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
