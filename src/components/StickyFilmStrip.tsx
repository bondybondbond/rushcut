import { useState, useEffect, useRef } from "react";
import { VolumeX, Volume1, Trash2 } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Clip } from "@/types/project";
import { fmtMs } from "@/utils/fmtMs";
import { zoomLabel } from "@/utils/zoom";
import { CARD_DUR_MS, trimmedMs } from "@/utils/filmDuration";

/** Resolved card data for a strip card tile (#74). */
export interface StripCard {
  /** Background hex (#FF8A65 / #0a0a0a / #ffffff) — already resolved by readCardsConfig. */
  color: string;
  /** Card title — used only for the tile tooltip; the tile shows the Intro/Outro badge. */
  text: string;
}

/**
 * Badge/stamp text colour for a card tile: dark on light fills (white/peach), light on
 * dark. Mirrors Pillow's _luminance gate (DESIGN.md "CSS preview card"). Co-located —
 * small enough that a shared util would be premature.
 */
export function cardTextColor(hex: string): string {
  if (hex.startsWith("#") && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum > 0.179 ? "#0a0a0a" : "#e5e5e5";
  }
  return "#e5e5e5";
}

interface StickyFilmStripProps {
  clips: Clip[];
  projectId: string;
  activeId?: string | null;
  /** If provided, shows a hover bin icon on each clip tile. Only Trimmer passes this. */
  onDeleteClip?: (clipId: string) => void;
  /** If provided, clicking a clip tile selects it. Only Arrange (Clips tab) passes this. */
  onSelectClip?: (clipId: string) => void;
  /**
   * If provided, enables press-drag-to-reorder on the film tiles. The arg is the full ordered
   * list of in-film clip ids after the move. Trimmer + Arrange pass this; Sound does not.
   */
  onReorder?: (orderedInFilmIds: string[]) => void;
  /** Film playback position in film-time ms — renders a playhead cursor when set. */
  playheadMs?: number;
  /** Called when user clicks a position in the timeline; arg is film-time ms. */
  onSeek?: (filmMs: number) => void;
  /**
   * Per-cut crossfade overlap in ms (#71). When > 0 the ruler/playhead/seek geometry is
   * telescoped so the timeline reads true render time instead of the naive sum of clip
   * durations. The caller computes this once via clampedXfadeMs(inFilm, tc) and passes the
   * final number — this component does no transition reasoning. Default 0 (no overlap).
   * NOTE: this makes the strip time-correct, NOT overlap-visual-correct: tiles narrow to
   * their telescoped contribution but do not draw the overlap shape (that is #74).
   */
  xfadeOverlapMs?: number;
  /**
   * Open text card (#74). When set (enabled + titled), a 3s card tile is prepended at film
   * time 0 and the ruler/playhead/seek geometry becomes card-inclusive so the strip length
   * matches the card-inclusive top-bar runtime (effectiveFilmMs). Null/undefined = no card.
   */
  openCard?: StripCard | null;
  /** Close text card (#74). Same as openCard but appended after the last clip. */
  closeCard?: StripCard | null;
}

// Zoom range: ~8px/s minimum, 2000px/s maximum
const MIN_PX_PER_MS = 0.008;
const MAX_PX_PER_MS = 2.0;
const DEFAULT_PX_PER_MS = 0.05;
const MIN_CLIP_WIDTH = 40;  // px — short clips still identifiable
const RULER_HEIGHT = 20;    // px
const CLIP_HEIGHT = 56;     // px
const GAP_PX = 2;           // px between clips
const TRAIL_PAD_MS = 5000;  // 5 s of blank scroll space after the last clip

interface SortableFilmTileProps {
  clip: Clip;
  index: number;
  width: number;
  isActive: boolean;
  reorderable: boolean;
  onSelectClip?: (clipId: string) => void;
  onDeleteClip?: (clipId: string) => void;
}

/**
 * One reorderable film tile. Extracted so `useSortable` can be called per tile.
 * Drag is enabled only when `reorderable` (i.e. the parent passed `onReorder`).
 */
function SortableFilmTile({
  clip,
  index,
  width,
  isActive,
  reorderable,
  onSelectClip,
  onDeleteClip,
}: SortableFilmTileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: clip.id,
    disabled: !reorderable,
  });

  const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));

  // Use Translate (not Transform) — Transform adds a scale component that would stretch our
  // variable-width tiles during drag.
  const style: React.CSSProperties = {
    width,
    height: CLIP_HEIGHT,
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!onDeleteClip) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDeleteClip(clip.id);
    }
  }

  return (
    <div
      ref={setNodeRef}
      data-testid="filmstrip-clip"
      className={`group relative flex-shrink-0 overflow-hidden border-2 transition-colors outline-none ${
        isActive ? "border-[#FF8A65]" : "border-[#99B3FF]/25"
      } ${onSelectClip ? "cursor-pointer" : ""} ${reorderable ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={style}
      {...attributes}
      {...listeners}
      tabIndex={onDeleteClip ? 0 : -1}
      onKeyDown={onDeleteClip ? handleKeyDown : undefined}
      onClick={
        onSelectClip
          ? (e) => { e.stopPropagation(); onSelectClip(clip.id); }
          : undefined
      }
    >
      {/* Thumbnail: CSS background tiling */}
      {clip.thumbnail_data ? (
        <div
          className="w-full h-full"
          style={{
            backgroundImage: `url('${clip.thumbnail_data}')`,
            backgroundSize: "auto 100%",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "left center",
          }}
        />
      ) : (
        <div className="w-full h-full bg-white/5 flex items-center justify-center">
          <svg
            className="w-4 h-4 text-[#e5e5e5]/20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path d="M15 10l4.553-2.069A1 1 0 0121 8.94V15.06a1 1 0 01-1.447.908L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
        </div>
      )}
      {/* Sequence number badge */}
      <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center z-10 pointer-events-none">
        <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{index + 1}</span>
      </div>
      {/* Hover-reveal delete bin — only when onDeleteClip provided (Trimmer) */}
      {onDeleteClip && (
        <button
          className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded bg-black/60 text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-20"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
          title="Remove from film"
          tabIndex={-1}
        >
          <Trash2 size={12} strokeWidth={2.5} />
        </button>
      )}
      {/* Duration label */}
      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
        <span className="text-[10px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
      </div>
      {/* State badge icons — bottom-right */}
      <div className="absolute bottom-1 right-1 flex gap-0.5 z-10 pointer-events-none">
        {clip.zoom_mode != null && (
          <div className="w-3.5 h-3.5 rounded-sm bg-[#22c55e] flex items-center justify-center" title={zoomLabel(clip.zoom_mode)}>
            <span className="text-[8px] font-bold text-[#0a0a0a] leading-none select-none">Z</span>
          </div>
        )}
        {clip.clip_volume === 0 && (
          <div className="w-3.5 h-3.5 rounded-sm bg-red-500 flex items-center justify-center" title="Muted">
            <VolumeX size={9} strokeWidth={2.5} className="text-[#0a0a0a]" />
          </div>
        )}
        {clip.clip_volume !== undefined && clip.clip_volume > 0 && clip.clip_volume < 1.0 && (
          <div className="w-3.5 h-3.5 rounded-sm bg-[#B794F4] flex items-center justify-center" title="Volume reduced">
            <Volume1 size={9} strokeWidth={2.5} className="text-[#0a0a0a]" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One card tile (#74) — open or close text card, drawn as a 3s block in the film colour.
 * Non-sortable, non-deletable: cards are structural film elements, not footage. Flanks the
 * SortableContext as a direct flex child so its width participates in the same gap layout.
 */
function CardStripTile({
  kind,
  color,
  text,
  width,
}: {
  kind: "open" | "close";
  color: string;
  text: string;
  width: number;
}) {
  const fg = cardTextColor(color);
  const label = kind === "open" ? "Intro" : "Outro";
  return (
    <div
      data-testid={`filmstrip-card-${kind}`}
      className="relative flex-shrink-0 overflow-hidden border-2 border-[#99B3FF]/40"
      style={{ width, height: CLIP_HEIGHT, background: color }}
      title={text}
    >
      {/* Intro/Outro badge — top-left, full word */}
      <div
        className="absolute top-0.5 left-0.5 px-1 h-4 rounded flex items-center justify-center z-10 pointer-events-none"
        style={{ background: fg === "#0a0a0a" ? "rgba(10,10,10,0.12)" : "rgba(229,229,229,0.15)" }}
      >
        <span className="text-[10px] font-bold leading-none select-none" style={{ color: fg }}>
          {label}
        </span>
      </div>
      {/* Duration stamp — bottom, mirrors the clip-tile treatment */}
      <div className="absolute bottom-0 inset-x-0 pt-3 px-1 pb-0.5 pointer-events-none">
        <span className="text-[10px] font-mono select-none" style={{ color: fg }}>
          {fmtMs(CARD_DUR_MS)}
        </span>
      </div>
    </div>
  );
}

export function StickyFilmStrip({
  clips,
  projectId: _projectId,
  activeId,
  onDeleteClip,
  onSelectClip,
  onReorder,
  playheadMs,
  onSeek,
  xfadeOverlapMs = 0,
  openCard = null,
  closeCard = null,
}: StickyFilmStripProps) {
  const [pxPerMs, setPxPerMs] = useState<number>(DEFAULT_PX_PER_MS);
  const trackRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
  const prevFilmLengthRef = useRef(0);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const scrollStartRef = useRef(0);
  const didDragRef = useRef(false); // distinguishes pan from click
  const isAutoFitRef = useRef(true);              // imperative: breaks on manual zoom
  const [isAutoFit, setIsAutoFit] = useState(true); // reactive: drives button visibility

  // Reorder drag: distance:5 matches the proven activation in ClipNavStrip + ClipList.
  // A no-move click never crosses 5px, so click-to-select still works.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const inFilm = clips
    .filter((c) => c.include === 1)
    .sort((a, b) => a.sort_order - b.sort_order);

  // Card tiles join the film as first-class 3s elements (#74) — only when there is footage to
  // bracket. The open card leads at film time 0; the close card trails the last clip. Both
  // count as elements in the xfade chain exactly like effectiveFilmMs, so the ruler length
  // matches the card-inclusive top-bar runtime.
  const showOpen = !!openCard && inFilm.length > 0;
  const showClose = !!closeCard && inFilm.length > 0;

  type Seg =
    | { kind: "card-open" | "card-close"; nativeMs: number; card: StripCard }
    | { kind: "clip"; nativeMs: number; clip: Clip };

  const segments: Seg[] = [
    ...(showOpen ? [{ kind: "card-open" as const, nativeMs: CARD_DUR_MS, card: openCard! }] : []),
    ...inFilm.map((c) => ({ kind: "clip" as const, nativeMs: trimmedMs(c), clip: c })),
    ...(showClose ? [{ kind: "card-close" as const, nativeMs: CARD_DUR_MS, card: closeCard! }] : []),
  ];

  // Segment index of the first clip (0, or 1 when an open card leads). Lets the clip-tile
  // render loop map clip index -> segment index for its width.
  const clipSegBase = showOpen ? 1 : 0;

  // Render-time (telescoped) width per SEGMENT in ms (#71/#74). Every element but the last has
  // its tail consumed by the crossfade into the next element, so it contributes one xfade less.
  // This makes totalMs == the telescoped + card-inclusive runtime shown in the top bar.
  // xfadeOverlapMs is 0 when no crossfade is active -> identical to the pre-card behaviour.
  const renderMsArr = segments.map((s, i) =>
    Math.max(0, s.nativeMs - (i < segments.length - 1 ? xfadeOverlapMs : 0)),
  );

  // Total film time in render (telescoped, card-inclusive) ms — drives the ruler + auto-fit.
  const totalMs = renderMsArr.reduce((sum, m) => sum + m, 0);

  // Per-segment widths: proportional to telescoped (render-time) duration, min-clamped.
  const segWidths = renderMsArr.map((m) => Math.max(MIN_CLIP_WIDTH, Math.round(m * pxPerMs)));

  // Per-clip widths (the clip subset of segWidths) for the clip-tile render loop.
  const clipWidths = inFilm.map((_, i) => segWidths[clipSegBase + i]);

  const totalTrackPx = segWidths.reduce((s, w) => s + w + GAP_PX, 0)
    + Math.round(TRAIL_PAD_MS * pxPerMs);

  // Cumulative pixel offsets per segment (for ruler/playhead alignment)
  const segOffsets: number[] = [];
  {
    let cur = 0;
    for (const w of segWidths) {
      segOffsets.push(cur);
      cur += w + GAP_PX;
    }
  }

  // Map render-time (ms) -> pixel position using telescoped per-segment widths
  function filmTimeToPx(ms: number): number {
    let filmMs = 0;
    for (let i = 0; i < segments.length; i++) {
      const segMs = renderMsArr[i];
      if (ms <= filmMs + segMs) {
        const t = segMs > 0 ? (ms - filmMs) / segMs : 0;
        return segOffsets[i] + t * segWidths[i];
      }
      filmMs += segMs;
    }
    return totalTrackPx;
  }

  // Inverse: pixel offset in the track → render-time ms. The SAME mapping backs both the
  // ruler paint and the click-seek hitbox (handleClick), so visuals and seek cannot drift.
  function pxToFilmMs(px: number): number {
    let cur = 0;
    for (let i = 0; i < segments.length; i++) {
      const w = segWidths[i];
      const segMs = renderMsArr[i];
      if (px <= cur + w) {
        const t = w > 0 ? (px - cur) / w : 0;
        let filmMs = 0;
        for (let j = 0; j < i; j++) filmMs += renderMsArr[j];
        return Math.round(filmMs + t * segMs);
      }
      cur += w + GAP_PX;
    }
    return totalMs;
  }

  // Minor ticks: 1s is the finest granularity; threshold 20px keeps ticks dense but readable
  const MINOR_TICK_CANDIDATES = [1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000];
  const minorTickMs = MINOR_TICK_CANDIDATES.find((ms) => ms * pxPerMs >= 20) ?? 300000;

  // Labels: only every 5s (or larger adaptive step) where spacing >= 50px
  const LABEL_CANDIDATES = [5000, 10000, 30000, 60000, 120000, 300000];
  const labelIntervalMs = LABEL_CANDIDATES.find((ms) => ms * pxPerMs >= 50) ?? 300000;

  // Build separate arrays for minor ticks and label positions
  const minorTicks: { ms: number; x: number }[] = [];
  const labelTicks: { ms: number; x: number }[] = [];
  if (totalMs > 0) {
    for (let ms = 0; ms <= totalMs + minorTickMs; ms += minorTickMs) {
      minorTicks.push({ ms, x: filmTimeToPx(ms) });
    }
    for (let ms = 0; ms <= totalMs + labelIntervalMs; ms += labelIntervalMs) {
      labelTicks.push({ ms, x: filmTimeToPx(ms) });
    }
  }

  // Auto-fit scale on first render using ResizeObserver
  useEffect(() => {
    if (!trackRef.current || hasInitialized.current || totalMs === 0) return;
    const ro = new ResizeObserver(([entry]) => {
      if (hasInitialized.current) return;
      const w = entry.contentRect.width;
      if (w <= 0) return;
      const fit = w / totalMs;
      setPxPerMs(Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, fit)));
      hasInitialized.current = true;
    });
    ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [totalMs]);

  // Auto-fit or scroll-to-end when the film clip count changes
  useEffect(() => {
    const cur = inFilm.length;
    if (hasInitialized.current && trackRef.current) {
      const el = trackRef.current;
      if (cur > prevFilmLengthRef.current) {
        // Clip added — auto-fit or scroll to end
        if (isAutoFitRef.current && totalMs > 0) {
          const containerWidth = el.getBoundingClientRect().width;
          if (containerWidth > 0) {
            setPxPerMs(Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, containerWidth / totalMs)));
            el.scrollLeft = 0;
          }
        } else {
          requestAnimationFrame(() => { if (el) el.scrollLeft = el.scrollWidth; });
        }
      } else if (cur < prevFilmLengthRef.current && isAutoFitRef.current && totalMs > 0) {
        // Clip deleted — re-fit remaining tiles to fill the container
        const containerWidth = el.getBoundingClientRect().width;
        if (containerWidth > 0) {
          setPxPerMs(Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, containerWidth / totalMs)));
          el.scrollLeft = 0;
        }
      }
    }
    prevFilmLengthRef.current = cur;
  }, [inFilm.length, totalMs]);

  // Non-passive Ctrl+scroll zoom (passive wheel blocks preventDefault)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      isAutoFitRef.current = false;
      setIsAutoFit(false);
      const ratio = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = el!.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el!.scrollLeft;
      setPxPerMs((prev) => {
        const next = Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, prev * ratio));
        requestAnimationFrame(() => {
          if (el) el.scrollLeft = cursorX * (next / prev) - (e.clientX - rect.left);
        });
        return next;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Global mousemove/mouseup for pan (captures moves outside the HUD)
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!isDraggingRef.current || !trackRef.current) return;
      if (Math.abs(e.clientX - dragStartXRef.current) > 4) didDragRef.current = true;
      trackRef.current.scrollLeft =
        scrollStartRef.current - (e.clientX - dragStartXRef.current);
    }
    function onUp() {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        if (trackRef.current) trackRef.current.style.cursor = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    // Always reset didDragRef so a previous pan never blocks the next click
    didDragRef.current = false;
    const isMiddle = e.button === 1;
    const isLeftOnBackground = e.button === 0 && e.target === e.currentTarget;
    if (!isMiddle && !isLeftOnBackground) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    scrollStartRef.current = trackRef.current?.scrollLeft ?? 0;
    if (trackRef.current) trackRef.current.style.cursor = "grabbing";
  }

  function handleFitView() {
    const el = trackRef.current;
    if (!el || totalMs <= 0) return;
    const containerWidth = el.getBoundingClientRect().width;
    if (containerWidth > 0) {
      setPxPerMs(Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, containerWidth / totalMs)));
      isAutoFitRef.current = true;
      setIsAutoFit(true);
      el.scrollLeft = 0;
    }
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onSeek || didDragRef.current) return;
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left + el.scrollLeft;
    onSeek(pxToFilmMs(px));
  }

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = inFilm.map((c) => c.id);
    const oldIndex = ids.indexOf(active.id as string);
    const newIndex = ids.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder?.(arrayMove(ids, oldIndex, newIndex));
  }

  const reorderable = !!onReorder;

  return (
    <div
      data-testid="sticky-filmstrip"
      className="relative flex-shrink-0 bg-[#0a0a0a]"
      style={{ height: 100 }}
    >
      {/* Scrollable proportional track — full width */}
      <div
        ref={trackRef}
        className="h-full overflow-x-auto overflow-y-hidden select-none [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
      >
        <div
          className="h-full flex flex-col py-2 gap-0.5"
          style={{ width: Math.max(totalTrackPx, 0), minWidth: "100%", position: "relative" }}
        >
          {/* Ruler row: labels at top, tick marks at bottom */}
          <div style={{ height: RULER_HEIGHT, position: "relative", flexShrink: 0 }}>
            {labelTicks.map((tick) => (
              <span
                key={`lbl-${tick.ms}`}
                style={{ position: "absolute", top: 8, left: tick.x, transform: "translateX(-50%)" }}
                className="text-[10px] font-mono text-white whitespace-nowrap leading-none"
              >
                {fmtMs(tick.ms)}
              </span>
            ))}
            {minorTicks.map((tick) => {
              const isLabel = labelTicks.some((l) => l.ms === tick.ms);
              return (
                <div
                  key={`tick-${tick.ms}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: tick.x,
                    transform: "translateX(-50%)",
                    width: 1,
                    height: isLabel ? 8 : 4,
                  }}
                  className={isLabel ? "bg-white" : "bg-white/60"}
                />
              );
            })}
          </div>

          {/* Playhead — absolute over both ruler and clip rows */}
          {playheadMs !== undefined && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: filmTimeToPx(playheadMs),
                zIndex: 20,
                pointerEvents: "none",
                transform: "translateX(-50%)",
              }}
            >
              {/* Downward triangle pip */}
              <div style={{
                position: "absolute",
                top: 4,
                left: "50%",
                transform: "translateX(-50%)",
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: "9px solid rgba(255,255,255,0.9)",
              }} />
              {/* 4px vertical line — starts below triangle tip with a 2px gap */}
              <div style={{
                position: "absolute",
                top: 15,
                bottom: 0,
                left: "50%",
                transform: "translateX(-50%)",
                width: 4,
                background: "rgba(255,255,255,0.85)",
                borderRadius: "1px",
              }} />
            </div>
          )}

          {/* Clip row — framed with blue border */}
          <div
            className="flex items-center border-2 border-[#99B3FF]/30 rounded-sm overflow-hidden"
            style={{ height: CLIP_HEIGHT, gap: GAP_PX, flexShrink: 0 }}
          >
            {inFilm.length === 0 ? (
              <div className="flex items-center gap-1.5 px-2">
                <svg
                  className="w-5 h-5 text-[#e5e5e5]/20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path d="M7 4v16M17 4v16M3 8h4m10 0h4M3 16h4m10 0h4M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
                </svg>
                <span className="text-[#e5e5e5]/30 text-sm whitespace-nowrap">No clips yet</span>
              </div>
            ) : (
              <>
                {showOpen && openCard && (
                  <CardStripTile
                    kind="open"
                    color={openCard.color}
                    text={openCard.text}
                    width={segWidths[0]}
                  />
                )}
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={inFilm.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                    {inFilm.map((clip, idx) => (
                      <SortableFilmTile
                        key={clip.id}
                        clip={clip}
                        index={idx}
                        width={clipWidths[idx]}
                        isActive={clip.id === activeId}
                        reorderable={reorderable}
                        onSelectClip={onSelectClip}
                        onDeleteClip={onDeleteClip}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
                {showClose && closeCard && (
                  <CardStripTile
                    kind="close"
                    color={closeCard.color}
                    text={closeCard.text}
                    width={segWidths[segWidths.length - 1]}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {!isAutoFit && (
        <button
          onClick={handleFitView}
          className="absolute flex items-center gap-1.5 z-30 select-none group"
          style={{ top: 4, right: 6 }}
          title="Reset zoom to fit all clips"
        >
          <span className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-white/30 bg-[#0a0a0a] text-[#a3a3a3] group-hover:text-[#e5e5e5] group-hover:border-white/55 transition-colors">
            <svg viewBox="0 0 20 8" width="16" height="7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M7 4H1M1 4l2.5-2M1 4l2.5 2" />
              <path d="M13 4h6M19 4l-2.5-2M19 4l-2.5 2" />
            </svg>
            <span className="text-xs">fit view</span>
          </span>
        </button>
      )}
    </div>
  );
}
