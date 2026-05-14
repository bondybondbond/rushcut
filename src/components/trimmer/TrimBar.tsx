import { useRef } from "react";

interface TrimBarProps {
  durationMs: number;
  inMs: number;
  outMs: number;
  /** Current playback position in ms — drives the moving playhead line */
  currentMs: number;
  /** Raw base64 waveform PNG (no data URI prefix). Renders as dim overlay at z-2. */
  waveformData?: string | null;
  onInChange: (ms: number) => void;
  onOutChange: (ms: number) => void;
  /** Called on pointerup after handle drag — triggers save. Never during drag move. */
  onCommit: () => void;
  /** Called on track click (not handle drag) — seek video to that timestamp. */
  onSeek?: (ms: number) => void;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const secs = s % 60;
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

/** Clamp a percentage so floating labels don't overflow the track edges */
function clampLabelPct(pct: number): number {
  return Math.max(2, Math.min(98, pct));
}

export function TrimBar({
  durationMs,
  inMs,
  outMs,
  currentMs,
  waveformData,
  onInChange,
  onOutChange,
  onCommit,
  onSeek,
}: TrimBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<"in" | "out" | null>(null);
  // track whether a drag actually moved (suppress click after drag)
  const didDrag = useRef(false);

  function msFromClientX(clientX: number): number {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * durationMs);
  }

  // --- Track click-to-seek: move video playhead to clicked position ---
  function onTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    // Suppress if this was the end of a handle drag
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    const ms = msFromClientX(e.clientX);
    onSeek?.(ms);
  }

  // --- Handle pointer drag ---
  function onHandlePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    handle: "in" | "out"
  ) {
    e.preventDefault();
    e.stopPropagation(); // don't fire track click
    didDrag.current = false;
    dragging.current = handle;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }

  function onHandlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    didDrag.current = true;
    const ms = msFromClientX(e.clientX);
    if (dragging.current === "in") {
      onInChange(Math.max(0, Math.min(ms, outMs - 500)));
    } else {
      onOutChange(Math.min(durationMs, Math.max(ms, inMs + 500)));
    }
  }

  function onHandlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = null;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    onCommit();
  }

  const inPct = durationMs > 0 ? (inMs / durationMs) * 100 : 0;
  const outPct = durationMs > 0 ? (outMs / durationMs) * 100 : 100;
  const playheadPct = durationMs > 0 ? (currentMs / durationMs) * 100 : 0;

  // Floating label positions — clamped so they don't fall off the track edges
  const inLabelPct = clampLabelPct(inPct);
  const outLabelPct = clampLabelPct(outPct);

  return (
    <div className="w-full select-none" data-testid="trim-bar">

      {/* ---- Fixed outer time labels row ---- */}
      {/* Left = 0:00 (always), Centre = selected duration, Right = total duration */}
      <div className="flex justify-between text-xs font-mono mb-1 px-1">
        <span className="text-[#e5e5e5]">0:00</span>
        <span className="text-[#e5e5e5]">{fmtMs(outMs - inMs)} selected</span>
        <span className="text-[#e5e5e5]">{fmtMs(durationMs)}</span>
      </div>

      {/* ---- Floating labels above IN/OUT handles ---- */}
      <div className="relative h-5 mb-0.5 pointer-events-none">
        {/* IN handle floating label */}
        <span
          className="absolute text-[10px] font-mono text-[#FF8A65] -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${inLabelPct}%`, bottom: 0 }}
        >
          {fmtMs(inMs)}
        </span>
        {/* OUT handle floating label */}
        <span
          className="absolute text-[10px] font-mono text-[#FF8A65] -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${outLabelPct}%`, bottom: 0 }}
        >
          {fmtMs(outMs)}
        </span>
      </div>

      {/*
        Track z-index layer order (strict — do not reorder):
          z-0  base track surface (dark neutral bg)
          z-1  inactive region overlays (darker)
          z-3  selected region highlight (above any future waveform at z-2)
          z-10 playhead line
          z-20 drag handles (IN/OUT)
          z-2  waveform PNG overlay (dim, stretched to fill track)
          (z-3 selected region is above waveform)
      */}
      <div
        ref={trackRef}
        onClick={onTrackClick}
        className="relative h-10 rounded-lg cursor-pointer overflow-visible"
        style={{ background: "rgba(255,255,255,0.08)" }}
      >
        {/* Left inactive region — z-1 */}
        <div
          className="absolute top-0 left-0 h-full rounded-l-lg pointer-events-none"
          style={{ width: `${inPct}%`, background: "rgba(0,0,0,0.55)", zIndex: 1 }}
        />
        {/* Right inactive region — z-1 */}
        <div
          className="absolute top-0 right-0 h-full rounded-r-lg pointer-events-none"
          style={{ width: `${100 - outPct}%`, background: "rgba(0,0,0,0.55)", zIndex: 1 }}
        />

        {/* Waveform overlay — z-2 (between inactive overlays and selected region) */}
        {waveformData && (
          <img
            src={waveformData}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ objectFit: "fill", opacity: 0.9, zIndex: 2, mixBlendMode: "screen" }}
            draggable={false}
            alt=""
          />
        )}

        {/* Selected region highlight — z-3 (must be above waveform when added) */}
        <div
          className="absolute top-0 h-full pointer-events-none"
          style={{
            left: `${inPct}%`,
            width: `${outPct - inPct}%`,
            background: "rgba(255,138,101,0.22)",
            zIndex: 3,
          }}
        />

        {/* Playhead — 4px line + downward triangle pip at top — z-10 */}
        <div
          className="absolute top-0 h-full pointer-events-none"
          style={{ left: `${playheadPct}%`, zIndex: 10, transform: "translateX(-50%)" }}
        >
          {/* Downward triangle pip above track */}
          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{
              top: -8,
              width: 0,
              height: 0,
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: "7px solid rgba(255,255,255,0.8)",
            }}
          />
          {/* 4px vertical line */}
          <div className="w-1 h-full bg-white/80 rounded-full" />
        </div>

        {/* IN handle — z-20 */}
        <div
          className="absolute top-0 h-full w-3 bg-[#FF8A65] rounded-sm cursor-ew-resize flex items-center justify-center touch-none hover:bg-[#ff9e7a] transition-colors"
          style={{ left: `calc(${inPct}% - 6px)`, zIndex: 20 }}
          onPointerDown={(e) => onHandlePointerDown(e, "in")}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-px h-5 bg-[#0a0a0a]/50 rounded-full" />
        </div>

        {/* OUT handle — z-20 */}
        <div
          className="absolute top-0 h-full w-3 bg-[#FF8A65] rounded-sm cursor-ew-resize flex items-center justify-center touch-none hover:bg-[#ff9e7a] transition-colors"
          style={{ left: `calc(${outPct}% - 6px)`, zIndex: 20 }}
          onPointerDown={(e) => onHandlePointerDown(e, "out")}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-px h-5 bg-[#0a0a0a]/50 rounded-full" />
        </div>
      </div>

      <p className="text-xs text-[#e5e5e5] mt-1.5 text-center">
        Click to seek &middot; drag handles to trim &middot; saves on release
      </p>
    </div>
  );
}
