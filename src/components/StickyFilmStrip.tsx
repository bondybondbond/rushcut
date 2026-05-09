import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Clip } from "@/types/project";

interface StickyFilmStripProps {
  clips: Clip[];
  projectId: string;
  activeId?: string | null;
  transitionValue?: string | null;
  soundMood?: string | null;
}

// Zoom range: ~8px/s minimum, 2000px/s maximum
const MIN_PX_PER_MS = 0.008;
const MAX_PX_PER_MS = 2.0;
const DEFAULT_PX_PER_MS = 0.05;
const MIN_CLIP_WIDTH = 40;  // px — short clips still identifiable
const RULER_HEIGHT = 20;    // px
const CLIP_HEIGHT = 56;     // px
const GAP_PX = 2;           // px between clips

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const secs = s % 60;
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  const labels: Record<string, string> = {
    none: "None",
    crossfade: "Crossfade",
    dip_to_black: "Dip to black",
    cinematic: "Cinematic",
    upbeat: "Upbeat",
    chill: "Chill",
    electronic: "Electronic",
    custom: "Custom",
  };
  return labels[s] ?? (s.charAt(0).toUpperCase() + s.slice(1));
}

function ScissorsIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

function MusicNoteIcon() {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-4z" />
    </svg>
  );
}

export function StickyFilmStrip({
  clips,
  projectId,
  activeId,
  transitionValue,
  soundMood,
}: StickyFilmStripProps) {
  const navigate = useNavigate();
  const [pxPerMs, setPxPerMs] = useState<number>(DEFAULT_PX_PER_MS);
  const trackRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
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
  // (naive ms/totalMs*totalTrackPx is wrong when short clips are min-clamped)
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

  const showTransitionChip = transitionValue && transitionValue !== "none";
  const showMusicChip = soundMood && soundMood !== "none";

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

  // Non-passive Ctrl+scroll zoom (passive wheel blocks preventDefault)
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const ratio = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left + el.scrollLeft;
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
      className="flex-shrink-0 border-t-2 border-[#99B3FF]/30 bg-[#0a0a0a] flex items-stretch"
      style={{ height: 100 }}
    >
      {/* ── LEFT: scrollable proportional track ── */}
      <div
        ref={trackRef}
        className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden select-none [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
        onMouseDown={handleMouseDown}
      >
        <div
          className="h-full flex flex-col py-2 gap-0.5"
          style={{ width: Math.max(totalTrackPx, 0), minWidth: "100%", position: "relative" }}
        >
          {/* Ruler row: labels at top, tick marks at bottom — gives breathing room above clip tiles */}
          <div style={{ height: RULER_HEIGHT, position: "relative", flexShrink: 0 }}>

            {/* Labels: every 5s (or larger adaptive step) — anchored to top of ruler row */}
            {labelTicks.map((tick) => (
              <span
                key={`lbl-${tick.ms}`}
                style={{ position: "absolute", top: 0, left: tick.x, transform: "translateX(-50%)" }}
                className="text-[11px] font-mono text-[#a3a3a3] whitespace-nowrap leading-none"
              >
                {fmtMs(tick.ms)}
              </span>
            ))}

            {/* Minor tick marks — anchored to bottom of ruler row, pointing toward clip tiles */}
            {minorTicks.map((tick) => {
              const isLabel = labelTicks.some((l) => l.ms === tick.ms);
              return (
                <div
                  key={`tick-${tick.ms}`}
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: tick.x,
                    transform: "translateX(-50%)",
                    width: 1,
                    height: isLabel ? 6 : 3,
                  }}
                  className={isLabel ? "bg-white/50" : "bg-white/25"}
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
                    className={`relative flex-shrink-0 overflow-hidden border-2 transition-colors ${
                      isActive ? "border-[#FF8A65]" : "border-[#99B3FF]/25"
                    }`}
                    style={{ width: w, height: CLIP_HEIGHT }}
                    draggable={false}
                  >
                    {/* Thumbnail: CSS background tiling (DaVinci-style repeated frames) */}
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

                    {/* Sequence number badge — blue so it stands out over clip content */}
                    <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center z-10 pointer-events-none">
                      <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                    </div>

                    {/* Duration label — gradient footer */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                      <span className="text-[10px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* ── RIGHT: duration summary ── */}
      <div className="flex-shrink-0 flex flex-col items-center justify-center gap-0.5 border-l border-white/10 pl-3 pr-3">
        <span className="text-[10px] text-[#e5e5e5]/40 uppercase tracking-wide">Total</span>
        <span className="text-sm font-mono text-[#e5e5e5] font-semibold">{fmtMs(totalMs)}</span>
        <span className="text-[10px] text-[#e5e5e5]/40">
          {inFilm.length} clip{inFilm.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── RIGHT: chosen-effect chips — blue to show selected state ── */}
      {(showTransitionChip || showMusicChip) && (
        <div className="flex-shrink-0 flex items-center gap-2 border-l border-white/10 pl-3 pr-3">
          {showTransitionChip && (
            <button
              onClick={() => navigate(`/transitions/${projectId}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-[#99B3FF]/60 text-[#99B3FF] bg-[#99B3FF]/8 text-sm rounded-md hover:border-[#99B3FF] hover:bg-[#99B3FF]/15 transition-all duration-200 whitespace-nowrap"
              title="Change transition"
            >
              <ScissorsIcon />
              {capitalize(transitionValue!)}
            </button>
          )}
          {showMusicChip && (
            <button
              onClick={() => navigate(`/sound/${projectId}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-[#99B3FF]/60 text-[#99B3FF] bg-[#99B3FF]/8 text-sm rounded-md hover:border-[#99B3FF] hover:bg-[#99B3FF]/15 transition-all duration-200 whitespace-nowrap"
              title="Change music"
            >
              <MusicNoteIcon />
              {capitalize(soundMood!)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
