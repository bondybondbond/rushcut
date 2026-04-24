import type { Clip } from "@/types/project";

interface FilmStripProps {
  clips: Clip[];
  activeId: string | null;
  onSelect: (clip: Clip) => void;
  onRemove: (clip: Clip) => void;
  /** Called when a clip is dropped onto the strip from the media pantry */
  onAdd: (clip: Clip) => void;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const secs = s % 60;
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

export function FilmStrip({ clips, activeId, onSelect, onRemove, onAdd }: FilmStripProps) {
  const inFilm = clips
    .filter((c) => c.include === 1)
    .sort((a, b) => a.sort_order - b.sort_order);

  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const clipId = e.dataTransfer.getData("clipId");
    if (!clipId) return;
    const clip = clips.find((c) => c.id === clipId);
    if (clip && clip.include !== 1) {
      onAdd(clip);
    }
  }

  if (inFilm.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-1 px-4"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <svg className="w-6 h-6 text-[#e5e5e5]/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M7 4v16M17 4v16M3 8h4m10 0h4M3 16h4m10 0h4M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
        </svg>
        <p className="text-[#e5e5e5]/30 text-xs text-center">Drag clips here or use Add to Film</p>
      </div>
    );
  }

  return (
    <div
      className="flex items-center h-full px-2"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Duration indicator */}
      <div className="flex-shrink-0 flex flex-col items-center justify-center px-3 border-r border-white/8 h-full gap-1">
        <span className="text-[10px] text-[#e5e5e5]/40 uppercase tracking-wide">Total</span>
        <span className="text-sm font-mono text-[#e5e5e5] font-semibold">{fmtMs(totalMs)}</span>
        <span className="text-[10px] text-[#e5e5e5]/40">{inFilm.length} clip{inFilm.length !== 1 ? "s" : ""}</span>
      </div>

      {/* Scrollable clip strip */}
      <div className="flex gap-2 overflow-x-auto flex-1 px-3 py-1 h-full items-center">
        {inFilm.map((clip, orderIdx) => {
          const isActive = clip.id === activeId;
          const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
          return (
            <div
              key={clip.id}
              className={`relative flex-shrink-0 rounded-md overflow-hidden border-2 transition-all duration-150 group ${
                isActive ? "border-[#FF8A65]" : "border-white/15 hover:border-white/40"
              }`}
              style={{ width: 120, height: 68 }}
            >
              {/* Sequence number */}
              <div className="absolute top-1 left-1 w-4 h-4 rounded bg-black/60 flex items-center justify-center z-10 pointer-events-none">
                <span className="text-[9px] text-white font-bold">{orderIdx + 1}</span>
              </div>

              {/* Thumbnail button */}
              <button
                onClick={() => onSelect(clip)}
                className="w-full h-full"
              >
                {clip.thumbnail_data ? (
                  <img
                    src={clip.thumbnail_data}
                    alt={clip.filename}
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <div className="w-full h-full bg-white/5 flex items-center justify-center">
                    <svg className="w-5 h-5 text-[#e5e5e5]/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                      <path d="M15 10l4.553-2.069A1 1 0 0121 8.94V15.06a1 1 0 01-1.447.908L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                    </svg>
                  </div>
                )}
              </button>

              {/* Duration overlay at bottom */}
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5 pointer-events-none">
                <span className="text-[9px] text-white/80 font-mono">{fmtMs(trimmedMs)}</span>
              </div>

              {/* Remove bin — shown on hover */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(clip);
                }}
                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-red-600 hover:bg-red-500 text-white flex items-center justify-center text-[10px] font-bold transition-all opacity-0 group-hover:opacity-100 z-10"
                title="Remove from film"
              >
                X
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
