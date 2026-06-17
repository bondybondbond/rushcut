import type { Clip } from "@/types/project";

interface MediaPantryProps {
  clips: Clip[];
  selectedId: string | null;
  onSelect: (clip: Clip) => void;
  inFilmPaths: Set<string>;
}

export function MediaPantry({ clips, selectedId, onSelect, inFilmPaths }: MediaPantryProps) {
  return (
    <div className="h-full overflow-y-auto p-3">
      <p className="text-xs text-[#e5e5e5]/50 uppercase tracking-wide mb-3 font-semibold">
        All Files
      </p>
      <div className="grid grid-cols-2 gap-2">
        {clips.map((clip) => {
          const isSelected = clip.id === selectedId;
          const inFilm = inFilmPaths.has(clip.local_path);
          return (
            <button
              key={clip.id}
              data-testid="pantry-tile"
              draggable
              onDragStart={(e) => e.dataTransfer.setData("clipId", clip.id)}
              onClick={() => onSelect(clip)}
              className={`relative rounded-md overflow-hidden border-2 transition-all duration-150 text-left ${
                isSelected
                  ? "border-[#FF8A65]"
                  : "border-white/10 hover:border-white/30"
              }`}
              style={{ aspectRatio: "16/9" }}
            >
              {/* Thumbnail */}
              {clip.thumbnail_data ? (
                <img
                  src={clip.thumbnail_data}
                  alt={clip.filename}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="w-full h-full bg-white/5 flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-[#e5e5e5]/30"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path d="M15 10l4.553-2.069A1 1 0 0121 8.94V15.06a1 1 0 01-1.447.908L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                  </svg>
                </div>
              )}

              {/* In-film green badge */}
              {inFilm && (
                <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-[#22c55e] flex items-center justify-center shadow">
                  <svg
                    className="w-2.5 h-2.5 text-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}

              {/* Filename tooltip on hover */}
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5 opacity-0 hover:opacity-100 transition-opacity pointer-events-none">
                <p className="text-[10px] text-white truncate">{clip.filename}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
