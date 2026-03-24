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

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function VideoIcon() {
  return (
    <div className="w-full h-full bg-[#1a1a1a] flex items-center justify-center">
      <svg className="w-8 h-8 text-[#555555]" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4h-4z" />
      </svg>
    </div>
  );
}

// Text card shown at start/end of timeline
function CardBlock({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div className="flex-shrink-0 w-20 h-28 rounded-lg border border-white/20 flex flex-col items-center justify-center p-2 text-center bg-white/5">
      <p className="text-[10px] text-[#a3a3a3] font-medium">{label}</p>
      <p className="text-[9px] text-[#e5e5e5] mt-1 line-clamp-3 break-all">{text}</p>
    </div>
  );
}

// Separator between clips
function TransitionDot() {
  return (
    <div className="flex-shrink-0 flex items-center justify-center px-1 self-center">
      <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
    </div>
  );
}

interface SortableClipTileProps {
  clip: Clip;
  index: number;
  onDelete?: (clipId: string) => void;
}

function SortableClipTile({ clip, index, onDelete }: SortableClipTileProps) {
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
      <div className="relative w-20 h-28 overflow-hidden">
        {clip.thumbnail_data ? (
          <img src={clip.thumbnail_data} alt={clip.filename} className="w-full h-full object-cover" />
        ) : (
          <VideoIcon />
        )}
        <div className="absolute top-1 left-1 bg-black/70 rounded px-1 py-0.5 text-[10px] text-[#e5e5e5] font-mono">
          {index + 1}
        </div>
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
  clips: Clip[];
  config: JobConfig;
  onReorder: (clips: Clip[]) => void;
  onDelete?: (clipId: string) => void;
}

export function TimelineStrip({ clips, config, onReorder, onDelete }: TimelineStripProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = clips.findIndex((c) => c.id === active.id);
    const newIndex = clips.findIndex((c) => c.id === over.id);
    onReorder(arrayMove(clips, oldIndex, newIndex));
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
            {config.intro_text && (
              <>
                <CardBlock label="Intro" text={config.intro_text} />
                <TransitionDot />
              </>
            )}

            {clips.map((clip, idx) => (
              <div key={clip.id} className="flex items-center">
                <SortableClipTile clip={clip} index={idx} onDelete={onDelete} />
                {idx < clips.length - 1 && <TransitionDot />}
              </div>
            ))}

            {config.outro_text && (
              <>
                <TransitionDot />
                <CardBlock label="Outro" text={config.outro_text} />
              </>
            )}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
