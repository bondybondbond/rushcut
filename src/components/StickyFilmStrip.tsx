import { useState, useEffect, useLayoutEffect, useRef, Fragment } from "react";
import { VolumeX, Volume1 } from "lucide-react";
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
import { orderedCardRuns, type PlacedCard } from "@/utils/buildJobConfig";
import { fmtMs } from "@/utils/fmtMs";
import { zoomLabel } from "@/utils/zoom";
import { CARD_DUR_MS, trimmedMs } from "@/utils/filmDuration";
import { buildSequenceCore } from "@/utils/sequenceClock";

/** Resolved card data for a strip card tile (#74, generalized to any position in #149). */
export interface StripCard {
  id: string;
  /** Background hex — already resolved by the caller. */
  color: string;
  /** Card title — shown on the tile itself (generalized from the old fixed Intro/Outro badge). */
  text: string;
}

/** A card placed at a specific gap (#149). `beforeClipId: null` = end of film. */
export interface PositionedCard {
  card: StripCard;
  beforeClipId: string | null;
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
  /** If provided, DEL/Backspace on a focused tile removes it. Only Trimmer passes this. */
  onDeleteClip?: (clipId: string) => void;
  /** If provided, clicking a clip tile selects it. Trimmer (both modes) and Arrange pass this. */
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
   * All positioned text cards (#74, generalized to any position in #149). Each 3s card
   * tile is spliced into the strip at its resolved gap and the ruler/playhead/seek
   * geometry becomes card-inclusive so the strip length matches the card-inclusive
   * top-bar runtime (effectiveFilmMs). At most one card per gap — the caller enforces
   * this at placement time (rejects a drop onto an already-occupied gap), so this
   * component never needs to resolve a same-anchor collision.
   */
  cards?: PositionedCard[];
  /** Currently selected card tile (Arrange's Cards tab), for the active-border highlight. */
  activeCardId?: string | null;
  /** If provided, clicking a card tile selects it (mirrors onSelectClip). */
  onSelectCard?: (cardId: string) => void;
  /**
   * #9: called on drop when a TrimBar cut is dragged in (native HTML5 DnD, separate
   * from the dnd-kit reorder above). Arg is the insertion index into the in-film clip
   * list (0 = before the first clip, inFilm.length = append at the end). Presence
   * enables the drop target and insertion-line indicator; absence leaves drag-in disabled.
   */
  onDropCut?: (insertIndex: number) => void;
  /**
   * #149: called on drop when a composed card is dragged in from Arrange's Cards tab
   * (native HTML5 DnD, `application/x-rushcut-card`, same mechanism as onDropCut but a
   * distinct mime type so both drag sources can coexist). Arg is the clip id the new
   * card should sit immediately before, or null for the end of the film. A drop onto a
   * gap that already has a card is rejected before this fires (see the occupied-gap
   * check in onDragOverClipRow) — the caller never has to dedupe.
   */
  onDropCard?: (beforeClipId: string | null) => void;
  /**
   * #151: called on drop when an already-placed card tile is dragged to a different gap.
   * An `application/x-rushcut-card-id` entry on the dataTransfer distinguishes this
   * "move an existing card" case from onDropCard's "place a new card". First arg is the
   * card id being moved; second is the clip id it should now sit immediately before, or
   * null for the end of the film. A drop onto a gap already holding a *different* card,
   * or back onto the card's own current gap, is rejected/no-oped before this fires.
   */
  onRepositionCard?: (cardId: string, beforeClipId: string | null) => void;
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
 * One card tile (#74, generalized to any position + made clickable/selectable in #149).
 * Drawn as a 3s block in the card's own colour, showing its own title. Not a dnd-kit
 * sortable — it flanks the sortable SortableContext as a direct flex child (its width
 * participates in the same gap layout) rather than living inside it. It IS selectable,
 * and (#151) when `draggable` is passed it can be dragged via native HTML5 DnD to a
 * different gap: dragstart tags the dataTransfer with `application/x-rushcut-card` +
 * `application/x-rushcut-card-id`, and the strip's own drop handlers route the move
 * (see onDropClipRow / onRepositionCard). Native DnD and dnd-kit are separate event
 * channels, so this never competes with the clip tiles' PointerSensor reorder.
 */
function CardStripTile({
  card,
  width,
  isActive,
  onSelectCard,
  draggable,
  isDragging,
  onCardDragStart,
  onCardDragEnd,
}: {
  card: StripCard;
  width: number;
  isActive: boolean;
  onSelectCard?: (cardId: string) => void;
  /** #151: enable native drag-to-reposition this placed card (Arrange Cards tab only). */
  draggable?: boolean;
  /** #151: true while THIS card is the one being dragged — dims the origin tile. */
  isDragging?: boolean;
  onCardDragStart?: (cardId: string, e: React.DragEvent<HTMLDivElement>) => void;
  onCardDragEnd?: () => void;
}) {
  const fg = cardTextColor(card.color);
  // #151: a native dragstart on this tile suppresses the browser-synthesised click that
  // would otherwise follow mouseup — guard onSelectCard so a move never also selects.
  const justDraggedRef = useRef(false);
  return (
    <div
      data-testid={`filmstrip-card-${card.id}`}
      draggable={draggable ?? false}
      className={`relative flex-shrink-0 overflow-hidden border-2 transition-colors ${
        isActive ? "border-[#FF8A65]" : "border-[#99B3FF]/40"
      } ${draggable ? "cursor-grab active:cursor-grabbing" : onSelectCard ? "cursor-pointer" : ""}`}
      style={{ width, height: CLIP_HEIGHT, background: card.color, opacity: isDragging ? 0.45 : undefined }}
      title={card.text}
      onDragStart={
        draggable
          ? (e) => { justDraggedRef.current = true; onCardDragStart?.(card.id, e); }
          : undefined
      }
      onDragEnd={
        draggable
          ? () => { onCardDragEnd?.(); setTimeout(() => { justDraggedRef.current = false; }, 0); }
          : undefined
      }
      onClick={
        onSelectCard
          ? (e) => {
              e.stopPropagation();
              if (justDraggedRef.current) { justDraggedRef.current = false; return; }
              onSelectCard(card.id);
            }
          : undefined
      }
    >
      {/* Card title — centred, truncated to fit narrow tiles at zoomed-out scale */}
      <div className="absolute inset-0 flex items-center justify-center px-1.5 pointer-events-none">
        <span className="text-[10px] font-bold leading-tight text-center line-clamp-2 select-none" style={{ color: fg }}>
          {card.text}
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
  cards = [],
  activeCardId = null,
  onSelectCard,
  onDropCut,
  onDropCard,
  onRepositionCard,
}: StickyFilmStripProps) {
  const [pxPerMs, setPxPerMs] = useState<number>(DEFAULT_PX_PER_MS);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // #149: true when the currently-hovered gap (during a card drag) already has a card —
  // the drop is rejected and the insertion-line indicator switches to a "blocked" colour.
  const [dragOverBlocked, setDragOverBlocked] = useState(false);
  // #151: the already-placed card currently being dragged to a new gap (null when no
  // card-move drag is in flight). The ref is read synchronously inside the native DnD
  // handlers; the state drives the origin tile's dimmed styling.
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const draggingCardIdRef = useRef<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
  const prevFilmLengthRef = useRef(0);
  // #159 — react to a card add/remove while the clip count holds steady.
  const prevCardCountRef = useRef(0);
  const prevCardIdsRef = useRef<Set<string>>(new Set()); // to diff which card was just added
  const prevCardsKeyRef = useRef("");                    // real card mutation vs bare pxPerMs change
  // Film-time (telescoped ms) under the LEFT viewport edge at the last USER-driven scroll.
  // Captured by onScroll only while auto-fit is OFF (manual zoom). null until first user scroll.
  const lastAnchorMsRef = useRef<number | null>(null);
  // True only for the instant between us writing scrollLeft imperatively and the resulting
  // scroll event firing — so that event isn't mistaken for a user scroll (Gate 3 #159).
  const programmaticScrollRef = useRef(false);
  // Segment index whose card tile the layout effect must scroll into view after a
  // card-triggered re-fit (auto-fit ON, ADD only). Consumed + nulled by that effect.
  const pendingRevealSegRef = useRef<number | null>(null);
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

  // Card tiles join the film as first-class 3s elements (#74, generalized to any position
  // in #149). Each card is anchored by clip id (`beforeClipId`); #184 lifted the old
  // "<=1 card per gap" assumption — multiple cards can share an anchor and render as a
  // run of adjacent tiles. `orderedCardRuns` is the ONE resolver for card order/count,
  // shared with buildSequenceCore / Trimmer / Sound so ruler and needle can't disagree.
  const cardsActive = inFilm.length > 0 ? cards : [];
  const cardRuns = orderedCardRuns(
    cardsActive,
    inFilm.map((c) => c.id),
  );
  const cardsBeforeClip = (clipId: string): PositionedCard[] => cardRuns.before.get(clipId) ?? [];
  const endCards: PositionedCard[] = cardRuns.end;

  // #174 Phase D: adapt the strip's PositionedCard[] to the shape buildSequenceCore
  // wants. Only `id` + `beforeClipId` drive geometry; `color`/`text` are carried
  // through, `subtitle`/`animation` are filled with inert defaults (never read for
  // ruler/px math).
  const cardsForSeq: PlacedCard[] = cardsActive.map((p) => ({
    id: p.card.id,
    text: p.card.text,
    subtitle: "",
    color: p.card.color,
    animation: "none",
    beforeClipId: p.beforeClipId,
  }));

  // #159: targeted change signal for card add / remove / reposition ONLY. Container resize
  // stays owned by the ResizeObserver effects; card duration is the fixed CARD_DUR_MS
  // constant; tile widths carry no font/text-content dependence — so this key never needs
  // to observe pixel geometry. A deliberate model-level approximation (Gate 3 F12).
  const cardCount = cardsActive.length;
  const cardsKey = cardsActive
    .map((p) => `${p.card.id}:${p.beforeClipId ?? "END"}`)
    .join("|");

  type Seg =
    | { kind: "card"; nativeMs: number; card: StripCard }
    | { kind: "clip"; nativeMs: number; clip: Clip };

  const segments: Seg[] = [];
  // Segment index of each clip (generalizes the old constant clipSegBase — a card can now
  // precede ANY clip, not just clip 0, so this is a running index, not a fixed offset).
  const clipSegIndex: number[] = [];
  for (const c of inFilm) {
    for (const p of cardsBeforeClip(c.id)) {
      segments.push({ kind: "card", nativeMs: CARD_DUR_MS, card: p.card });
    }
    clipSegIndex.push(segments.length);
    segments.push({ kind: "clip", nativeMs: trimmedMs(c), clip: c });
  }
  for (const p of endCards) {
    segments.push({ kind: "card", nativeMs: CARD_DUR_MS, card: p.card });
  }

  // #174 Phase D: the telescoped (render-time) geometry is NO LONGER computed here.
  // `buildSequenceCore` is the ONE resolver -- it produces the identical flat
  // clip+card item list (same interleave order this component builds `segments`
  // in) with each item's half-open telescoped `[filmStartMs, filmEndMs)` span, so
  // the strip ruler and the film-mode playback needle can never geometrically
  // disagree (they now literally share the resolver). This component keeps only
  // the px mapping on top of those spans.
  const filmSeq = buildSequenceCore(inFilm, xfadeOverlapMs, cardsForSeq);
  const seqItems = filmSeq.items; // 1:1 with `segments` by construction (same order)

  // Per-SEGMENT telescoped width in ms, straight off the resolver's spans.
  const renderMsArr = seqItems.map((it) => it.filmEndMs - it.filmStartMs);

  // Total film time in render (telescoped, card-inclusive) ms — drives the ruler + auto-fit.
  const totalMs = filmSeq.totalMs;

  // Per-segment widths: proportional to telescoped (render-time) duration, min-clamped.
  const segWidths = renderMsArr.map((m) => Math.max(MIN_CLIP_WIDTH, Math.round(m * pxPerMs)));

  // Per-clip widths (the clip subset of segWidths) for the clip-tile render loop.
  const clipWidths = inFilm.map((_, i) => segWidths[clipSegIndex[i]]);

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

  // Map render-time (ms) -> pixel position, reading the resolver's telescoped
  // per-item spans directly (no local prefix-sum walk).
  function filmTimeToPx(ms: number): number {
    for (let i = 0; i < seqItems.length; i++) {
      const it = seqItems[i];
      const segMs = it.filmEndMs - it.filmStartMs;
      if (ms <= it.filmEndMs) {
        const t = segMs > 0 ? (ms - it.filmStartMs) / segMs : 0;
        return segOffsets[i] + t * segWidths[i];
      }
    }
    return totalTrackPx;
  }

  // Inverse: pixel offset in the track → render-time ms. The SAME resolver spans back
  // both the ruler paint and the click-seek hitbox (handleClick), so visuals and seek
  // cannot drift.
  function pxToFilmMs(px: number): number {
    let cur = 0;
    for (let i = 0; i < seqItems.length; i++) {
      const w = segWidths[i];
      const it = seqItems[i];
      const segMs = it.filmEndMs - it.filmStartMs;
      if (px <= cur + w) {
        const t = w > 0 ? (px - cur) / w : 0;
        return Math.round(it.filmStartMs + t * segMs);
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
      } else if (
        cur === prevFilmLengthRef.current &&
        cardCount !== prevCardCountRef.current &&
        isAutoFitRef.current &&
        totalMs > 0
      ) {
        // #159: a card was added/removed with the clip count unchanged. Re-fit the
        // horizontal zoom to the new card-inclusive totalMs; the layout effect below then
        // scrolls the new card into view (an ADD). MIN_PX_PER_MS / MIN_CLIP_WIDTH clamping
        // means the whole film often can't fit, so "bring the card into view" is the goal.
        // This branch can't self-retrigger: pxPerMs is not in this effect's dep array.
        const containerWidth = el.getBoundingClientRect().width;
        if (containerWidth > 0) {
          const next = Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, containerWidth / totalMs));
          setPxPerMs((prev) => (Math.abs(prev - next) < 1e-6 ? prev : next)); // no-op guard
        }
        if (cardCount > prevCardCountRef.current) {
          // ADD: find the newly-placed card and mark its segment for reveal.
          const prevIds = prevCardIdsRef.current;
          const addedId = cardsActive.map((p) => p.card.id).find((id) => !prevIds.has(id)) ?? null;
          let seg = segments.length - 1; // default / end run / fallback
          if (addedId && !endCards.some((p) => p.card.id === addedId)) {
            // #184: card runs can hold >1 — reveal the exact tile that was added.
            const ci = inFilm.findIndex((c) => cardsBeforeClip(c.id).some((p) => p.card.id === addedId));
            if (ci >= 0) {
              const run = cardsBeforeClip(inFilm[ci].id);
              const k = run.findIndex((p) => p.card.id === addedId);
              seg = clipSegIndex[ci] - run.length + Math.max(0, k);
            }
          }
          pendingRevealSegRef.current = seg;
        } else if (el.scrollLeft !== 0) {
          // REMOVE: mirror clip-delete — re-fit to the start.
          programmaticScrollRef.current = true;
          el.scrollLeft = 0;
          requestAnimationFrame(() => { programmaticScrollRef.current = false; });
        }
        lastAnchorMsRef.current = null; // stale once we re-fit
      }
    }
    prevFilmLengthRef.current = cur;
    prevCardCountRef.current = cardCount;
    prevCardIdsRef.current = new Set(cardsActive.map((p) => p.card.id));
  }, [inFilm.length, totalMs, cardCount]);

  // #159: after a card add/remove/reposition changed strip geometry, either scroll the new
  // card into view (auto-fit path — pendingRevealSegRef set by the effect above) or, when the
  // user has manually zoomed (auto-fit OFF), keep the film-time that was under the left
  // viewport edge pinned so the downstream ripple doesn't snap the view. The scroll write
  // itself is synchronous post-layout (useLayoutEffect, not gated behind rAF — WebView2
  // throttles rAF on focus loss); rAF is used ONLY as a non-critical fallback to clear
  // programmaticScrollRef. Re-runs on pxPerMs so it reads the re-fitted geometry the effect
  // above committed (render -> commit -> this effect -> measure). Chromium `overflow-anchor` is left at its
  // default: it's vertical-biased and auto-suppressed by the width mutations the re-fit makes,
  // so manual restore is the reliable path here (revisit with `overflow-anchor: none` only if
  // eval shows the two fighting).
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const cardsChanged = prevCardsKeyRef.current !== cardsKey;
    prevCardsKeyRef.current = cardsKey;

    // (1) Reveal a just-added card. Wins over the anchor branch via early return; the two are
    // also mutually exclusive by auto-fit state (reveal = auto-fit ON, anchor = auto-fit OFF).
    const reveal = pendingRevealSegRef.current;
    if (reveal != null) {
      pendingRevealSegRef.current = null;
      const segLeft = segOffsets[reveal] ?? 0;
      const segRight = segLeft + (segWidths[reveal] ?? 0);
      const viewLeft = el.scrollLeft;
      const viewRight = viewLeft + el.clientWidth;
      // Clamp the target to the real scrollable range BEFORE comparing — otherwise an
      // overshoot (segRight+GAP past scrollWidth) makes `target !== viewLeft` true, we arm
      // programmaticScrollRef and write, but the browser clamps to an unchanged value so no
      // `scroll` event fires and the flag never clears (Round 2.5). rAF is a second safety net
      // for the sub-pixel/DPR-rounding case where the write still lands on the current value.
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      let target = viewLeft;
      if (segLeft < viewLeft) target = segLeft - GAP_PX;
      else if (segRight > viewRight) target = segRight - el.clientWidth + GAP_PX;
      target = Math.min(Math.max(0, target), maxScroll);
      if (target !== viewLeft) {
        programmaticScrollRef.current = true;
        el.scrollLeft = target;
        requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
      return;
    }

    // (2) Manual-zoom ripple: restore the film-time that was under the left viewport edge.
    if (cardsChanged && !isAutoFitRef.current && lastAnchorMsRef.current != null) {
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      const t = Math.min(Math.max(0, filmTimeToPx(lastAnchorMsRef.current)), maxScroll);
      if (Math.round(t) !== Math.round(el.scrollLeft)) {
        programmaticScrollRef.current = true;
        el.scrollLeft = t;
        requestAnimationFrame(() => { programmaticScrollRef.current = false; });
      }
    }
  }, [cardsKey, pxPerMs]);

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

  // #159: capture the anchor for the manual-zoom card-ripple restore. Ignores scrolls we
  // triggered ourselves (reveal / anchor-restore / clip-delete reset — flagged via
  // programmaticScrollRef, which is only set when the write actually moves scrollLeft, so it
  // can't get stuck). Pan (handleMouseDown/onMove) and Ctrl+wheel zoom deliberately do NOT
  // set the flag, so they correctly re-capture the anchor as genuine user scrolls.
  function handleTrackScroll() {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    if (!isAutoFitRef.current && trackRef.current) {
      lastAnchorMsRef.current = pxToFilmMs(trackRef.current.scrollLeft);
    }
  }

  // #9: pixel position of an insertion boundary (0..inFilm.length) among clip tiles only,
  // for the drag-in insertion-line indicator. Mirrors filmTimeToPx's segment-offset lookup
  // but indexes into clip tiles specifically (clipSegIndex maps clip index -> segment index,
  // accounting for however many cards precede it — generalized from the old constant
  // clipSegBase, which only ever had to skip a single leading open card).
  function insertIndexToPx(idx: number): number {
    if (inFilm.length === 0) return segOffsets[0] ?? 0;
    if (idx < inFilm.length) return segOffsets[clipSegIndex[idx]];
    const lastSeg = clipSegIndex[inFilm.length - 1];
    return segOffsets[lastSeg] + segWidths[lastSeg];
  }

  // #184: stacking is allowed now — a drop onto a gap that already has a card APPENDS
  // to that gap's run (consistent with "+ Add to film"); it is never rejected. No gap
  // is "blocked", so this always reports false. Kept as a function (not deleted) so the
  // drag-over / drop call sites and their `dragOverBlocked` plumbing stay intact for a
  // future real block condition.
  function gapOccupied(_idx: number): boolean {
    return false;
  }

  // #151: native-DnD drag source lives on each CardStripTile; these fire from there.
  function handleCardDragStart(cardId: string, e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData("application/x-rushcut-card", "1");
    e.dataTransfer.setData("application/x-rushcut-card-id", cardId);
    e.dataTransfer.effectAllowed = "move";
    draggingCardIdRef.current = cardId;
    // Defer the origin-tile dim: mutating the draggable node's own style *during* the
    // dragstart tick makes Chromium/WebView2 abort the drag immediately (react-dnd
    // #1085 / crbug 168544). rAF pushes the opacity change past dragstart. Guard so a
    // same-frame abort (dragend before the frame) doesn't leave a stale dim behind.
    requestAnimationFrame(() => {
      if (draggingCardIdRef.current === cardId) setDraggingCardId(cardId);
    });
  }
  function handleCardDragEnd() {
    // Fires on every end path — successful drop, Esc, or release outside any target —
    // so it's cleanup only, never where a move is decided.
    draggingCardIdRef.current = null;
    setDraggingCardId(null);
    setDragOverIndex(null);
    setDragOverBlocked(false);
  }

  // #9/#149: native HTML5 DnD drop target for dragging a trimmed cut in from TrimBar OR a
  // composed card in from Arrange's Cards tab — kept fully separate from the dnd-kit
  // DndContext below (different event model, same tiles, no collision: dnd-kit only
  // listens for pointerdown on tiles, this only fires on the browser's native drag events).
  function onDragOverClipRow(e: React.DragEvent<HTMLDivElement>) {
    const isCut = !!onDropCut && e.dataTransfer.types.includes("application/x-rushcut-cut");
    const isCard = !!onDropCard && e.dataTransfer.types.includes("application/x-rushcut-card");
    if (!isCut && !isCard) return;
    e.preventDefault();
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left + el.scrollLeft;
    let idx = 0;
    for (let i = 0; i < inFilm.length; i++) {
      const seg = clipSegIndex[i];
      const mid = segOffsets[seg] + segWidths[seg] / 2;
      if (px > mid) idx = i + 1;
    }
    if (isCard) {
      const occupied = gapOccupied(idx);
      const isMove = draggingCardIdRef.current !== null;
      e.dataTransfer.dropEffect = occupied ? "none" : isMove ? "move" : "copy";
      setDragOverBlocked(occupied);
    } else {
      e.dataTransfer.dropEffect = "copy";
      setDragOverBlocked(false);
    }
    setDragOverIndex(idx);
  }

  function onDragLeaveClipRow(e: React.DragEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragOverIndex(null);
      setDragOverBlocked(false);
    }
  }

  function onDropClipRow(e: React.DragEvent<HTMLDivElement>) {
    // #151: read the card-move id synchronously first — dataTransfer payload is only
    // readable inside the drop handler (not dragover), and only before any await.
    const moveCardId =
      !!onRepositionCard && e.dataTransfer.types.includes("application/x-rushcut-card-id")
        ? e.dataTransfer.getData("application/x-rushcut-card-id")
        : "";
    const isCut = !!onDropCut && e.dataTransfer.types.includes("application/x-rushcut-cut");
    const isCard = !!onDropCard && e.dataTransfer.types.includes("application/x-rushcut-card");
    if (!isCut && !isCard && !moveCardId) return;
    e.preventDefault();
    const idx = dragOverIndex ?? inFilm.length;
    const blocked = dragOverBlocked;
    setDragOverIndex(null);
    setDragOverBlocked(false);
    draggingCardIdRef.current = null;
    setDraggingCardId(null);
    if (moveCardId) {
      if (blocked) return; // target gap holds a different card — silently reject
      const targetAnchor = idx < inFilm.length ? inFilm[idx].id : null;
      const current = cards.find((p) => p.card.id === moveCardId)?.beforeClipId;
      if (current !== targetAnchor) onRepositionCard!(moveCardId, targetAnchor); // else: dropped back on its own gap — no-op
      return;
    }
    if (isCut) { onDropCut!(idx); return; }
    if (blocked) return; // gap already has a card — silently reject, indicator already showed it
    onDropCard!(idx < inFilm.length ? inFilm[idx].id : null);
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
        onScroll={handleTrackScroll}
        onDragOver={onDragOverClipRow}
        onDragLeave={onDragLeaveClipRow}
        onDrop={onDropClipRow}
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
                style={{
                  position: "absolute",
                  top: 8,
                  left: tick.x,
                  // The ms=0 label sits at the track's left edge — centering it would clip
                  // its left half ("0:00" -> "00") against the scroll container's edge.
                  transform: tick.ms === 0 ? undefined : "translateX(-50%)",
                }}
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
              data-testid="filmstrip-playhead"
              data-film-ms={Math.round(playheadMs)}
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

          {/* #9/#149: drag-in insertion-line indicator — shows exactly where a dragged
              TrimBar cut or composed card will land. Blue (#99B3FF) matches the existing
              filmstrip accent/tile border color. #184: card drops onto an occupied gap
              now stack (append to that gap's run), so the red "blocked" state no longer
              triggers for cards — `gapOccupied` always returns false. Spans the clip row
              only (top: RULER_HEIGHT), unlike the playhead which spans ruler+clips. */}
          {dragOverIndex !== null && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: RULER_HEIGHT,
                height: CLIP_HEIGHT,
                left: insertIndexToPx(dragOverIndex),
                zIndex: 25,
                pointerEvents: "none",
                transform: "translateX(-50%)",
                width: 3,
                background: dragOverBlocked ? "#f87171" : "#99B3FF",
                borderRadius: "1.5px",
                boxShadow: dragOverBlocked ? "0 0 4px rgba(248,113,113,0.8)" : "0 0 4px rgba(153,179,255,0.8)",
              }}
            />
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
                {/* #149: card tiles are interleaved as plain (non-sortable) siblings among
                    the sortable clip tiles, inside the same SortableContext. dnd-kit's
                    SortableContext is a context provider, not a DOM-structure requirement —
                    each SortableFilmTile measures its own rect via useSortable, so a static
                    sibling between two sortable items doesn't affect drag-to-reorder. */}
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={inFilm.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                    {inFilm.map((clip, idx) => {
                      // #184: a run of >=0 cards renders immediately before this clip.
                      // Each card's segment index counts back from the clip's own.
                      const run = cardsBeforeClip(clip.id);
                      const runBaseSeg = clipSegIndex[idx] - run.length;
                      return (
                        <Fragment key={clip.id}>
                          {run.map((p, k) => (
                            <CardStripTile
                              key={p.card.id}
                              card={p.card}
                              width={segWidths[runBaseSeg + k]}
                              isActive={p.card.id === activeCardId}
                              onSelectCard={onSelectCard}
                              draggable={!!onRepositionCard}
                              isDragging={draggingCardId === p.card.id}
                              onCardDragStart={handleCardDragStart}
                              onCardDragEnd={handleCardDragEnd}
                            />
                          ))}
                          <SortableFilmTile
                            clip={clip}
                            index={idx}
                            width={clipWidths[idx]}
                            isActive={clip.id === activeId}
                            reorderable={reorderable}
                            onSelectClip={onSelectClip}
                            onDeleteClip={onDeleteClip}
                          />
                        </Fragment>
                      );
                    })}
                  </SortableContext>
                </DndContext>
                {endCards.map((p, k) => (
                  <CardStripTile
                    key={p.card.id}
                    card={p.card}
                    width={segWidths[segWidths.length - endCards.length + k]}
                    isActive={p.card.id === activeCardId}
                    onSelectCard={onSelectCard}
                    draggable={!!onRepositionCard}
                    isDragging={draggingCardId === p.card.id}
                    onCardDragStart={handleCardDragStart}
                    onCardDragEnd={handleCardDragEnd}
                  />
                ))}
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
