import { useState, useEffect, useRef } from "react";
import type { Clip } from "@/types/project";
import { fmtMs } from "@/utils/fmtMs";

interface StickyFilmStripProps {
  clips: Clip[];
  projectId: string;
  activeId?: string | null;
  /** If provided, shows a hover bin icon on each clip tile. Only Trimmer passes this. */
  onDeleteClip?: (clipId: string) => void;
}

// Zoom range: ~8px/s minimum, 2000px/s maximum
const MIN_PX_PER_MS = 0.008;
const MAX_PX_PER_MS = 2.0;
const DEFAULT_PX_PER_MS = 0.05;
const MIN_CLIP_WIDTH = 40;  // px — short clips still identifiable
const RULER_HEIGHT = 20;    // px
const CLIP_HEIGHT = 56;     // px
const GAP_PX = 2;           // px between clips

export function StickyFilmStrip({
  clips,
  projectId: _projectId,
  activeId,
  onDeleteClip,
}: StickyFilmStripProps) {
  const [pxPerMs, setPxPerMs] = useState<number>(DEFAULT_PX_PER_MS);
  const trackRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
  const prevFilmLengthRef = useRef(0);
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const scrollStartRef = useRef(0);

  const inFilm = clips
    .filter((c) => c.include === 1)
    .sort((a, b) => a.sort_order - b.sort_order);

  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  // Per-clip widths: proportional to trimmed duration, min-clamped
  const clipWidths = inFilm.map((c) => {
    const trimmedMs = Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0));
    return Math.max(MIN_CLIP_WIDTH, Math.round(trimmedMs * pxPerMs));
  });

  const totalTrackPx = clipWidths.reduce((s, w) => s + w + GAP_PX, 0);

  // Cumulative pixel offsets per clip (for ruler alignment)
  const clipOffsets: number[] = [];
  {
    let cur = 0;
    for (const w of clipWidths) {
      clipOffsets.push(cur);
      cur += w + GAP_PX;
    }
  }

  // Map film time (ms) -> pixel position using actual clip widths
  function filmTimeToPx(ms: number): number {
    let filmMs = 0;
    for (let i = 0; i < inFilm.length; i++) {
      const clipMs = Math.max(
        0,
        (inFilm[i].out_ms ?? inFilm[i].duration_ms) - (inFilm[i].in_ms ?? 0)
      );
      if (ms <= filmMs + clipMs) {
        const t = clipMs > 0 ? (ms - filmMs) / clipMs : 0;
        return clipOffsets[i] + t * clipWidths[i];
      }
      filmMs += clipMs;
    }
    return totalTrackPx;
  }

  // Minor ticks: densest interval where spacing >= 20px (no labels)
  const MINOR_TICK_CANDIDATES = [500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000];
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

  // Auto-scroll to end when a clip is added to the film
  useEffect(() => {
    const cur = inFilm.length;
    if (cur > prevFilmLengthRef.current && hasInitialized.current && trackRef.current) {
      const el = trackRef.current;
      requestAnimationFrame(() => { if (el) el.scrollLeft = el.scrollWidth; });
    }
    prevFilmLengthRef.current = cur;
  }, [inFilm.length]);

  // Non-passive Ctrl+scroll zoom (passive wheel blocks preventDefault)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
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
    const isMiddle = e.button === 1;
    const isLeftOnBackground = e.button === 0 && e.target === e.currentTarget;
    if (!isMiddle && !isLeftOnBackground) return;
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    scrollStartRef.current = trackRef.current?.scrollLeft ?? 0;
    if (trackRef.current) trackRef.current.style.cursor = "grabbing";
  }

  return (
    <div
      data-testid="sticky-filmstrip"
      className="flex-shrink-0 bg-[#0a0a0a]"
      style={{ height: 100 }}
    >
      {/* Scrollable proportional track — full width */}
      <div
        ref={trackRef}
        className="h-full overflow-x-auto overflow-y-hidden select-none [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
        onMouseDown={handleMouseDown}
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
                className="text-[10px] font-mono text-white/70 whitespace-nowrap leading-none"
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
              inFilm.map((clip, idx) => {
                const w = clipWidths[idx];
                const isActive = clip.id === activeId;
                const trimmedMs = Math.max(
                  0,
                  (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0)
                );
                return (
                  <div
                    key={clip.id}
                    className={`group relative flex-shrink-0 overflow-hidden border-2 transition-colors ${
                      isActive ? "border-[#FF8A65]" : "border-[#99B3FF]/25"
                    }`}
                    style={{ width: w, height: CLIP_HEIGHT }}
                    draggable={false}
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
                      <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                    </div>
                    {/* Duration label */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                      <span className="text-[10px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                    </div>
                    {/* Bin icon — hover-reveal, only when delete callback is provided */}
                    {onDeleteClip && (
                      <button
                        className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded bg-black/60 text-red-400 opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity z-10 group-hover:opacity-100"
                        onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
                        title="Remove from film"
                        tabIndex={-1}
                      >
                        <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
