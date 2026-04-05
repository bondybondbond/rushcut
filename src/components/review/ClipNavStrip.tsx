import { useEffect, useRef } from "react";
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
import type { Clip } from "@/types/project";

function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function VideoIcon() {
  return (
    <div className="w-full h-full bg-white/10 flex items-center justify-center">
      <svg className="w-4 h-4 text-[#a3a3a3]" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
      </svg>
    </div>
  );
}

interface SortableTileProps {
  clip: Clip;
  index: number;
  isCurrent: boolean;
  onSelect: () => void;
  tileRef?: React.RefObject<HTMLDivElement | null>;
}

function SortableTile({ clip, index, isCurrent, onSelect, tileRef }: SortableTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clip.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  const isSkipped = clip.include === 0;

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        if (tileRef) (tileRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      style={style}
      className={`flex-shrink-0 w-20 h-[45px] rounded overflow-hidden border cursor-pointer select-none transition-all ${
        isCurrent
          ? "ring-2 ring-[#FF8A65] border-[#FF8A65]"
          : "border-white/15 hover:border-white/35"
      } ${isSkipped ? "opacity-40 grayscale" : ""}`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
      title={`Clip ${index + 1}: ${clip.filename}`}
    >
      {clip.thumbnail_data ? (
        <img
          src={clip.thumbnail_data}
          alt={clip.filename}
          className="w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <VideoIcon />
      )}
    </div>
  );
}

interface ClipNavStripProps {
  clips: Clip[];
  currentIndex: number;
  onSelect: (idx: number) => void;
  onReorder: (clips: Clip[]) => void;
}

export function ClipNavStrip({ clips, currentIndex, onSelect, onReorder }: ClipNavStripProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll current tile into view when index changes
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIndex]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = clips.findIndex((c) => c.id === active.id);
    const newIndex = clips.findIndex((c) => c.id === over.id);
    onReorder(arrayMove(clips, oldIndex, newIndex));
  }

  // Duration counter: sum of trimmed included clips
  const includedMs = clips.reduce((sum, c) => {
    if (c.include === 0) return sum;
    return sum + (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0);
  }, 0);

  const includedCount = clips.filter((c) => c.include !== 0).length;

  return (
    <div className="w-full space-y-1.5">
      <div className="overflow-x-auto pb-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={clips.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
            <div className="flex gap-1 min-w-max">
              {clips.map((clip, idx) => (
                <SortableTile
                  key={clip.id}
                  clip={clip}
                  index={idx}
                  isCurrent={idx === currentIndex}
                  onSelect={() => onSelect(idx)}
                  tileRef={idx === currentIndex ? activeRef : undefined}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      <p className="text-sm text-[#a3a3a3]">
        ~{fmtMs(includedMs)} included
        <span className="text-[#555555] ml-1.5">({includedCount} of {clips.length} clips)</span>
      </p>
    </div>
  );
}
