import { useEffect, useState } from "react";
import type { Clip } from "@/types/project";

interface MediaPantryProps {
  clips: Clip[];
  selectedId: string | null;
  onSelect: (clip: Clip) => void;
  inFilmPaths: Set<string>;
  onAddClips?: () => void;
  onRemoveClip?: (clip: Clip) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  clip: Clip;
}

export function MediaPantry({ clips, selectedId, onSelect, inFilmPaths, onAddClips, onRemoveClip }: MediaPantryProps) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  return (
    <div className="h-full overflow-y-auto p-3 relative">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[#e5e5e5]/50 uppercase tracking-wide font-semibold">
          All Files
        </p>
        {onAddClips && (
          <button
            type="button"
            data-testid="btn-add-clips"
            onClick={onAddClips}
            title="Add clips"
            className="text-xs px-2 py-1 rounded border border-white/30 text-[#a3a3a3] hover:text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-all duration-200"
          >
            + Add clips
          </button>
        )}
      </div>
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
              onContextMenu={(e) => {
                if (!onRemoveClip) return;
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, clip });
              }}
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

      {/* Right-click context menu (#40) — dark surface matches Toast token, destructive item red */}
      {menu && onRemoveClip && (
        <div
          data-testid="pantry-context-menu"
          className="fixed z-50 bg-[#1a1a1a] border border-white/15 rounded-md shadow-lg py-1 min-w-[180px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            data-testid="btn-remove-from-project"
            onClick={() => {
              onRemoveClip(menu.clip);
              setMenu(null);
            }}
            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-400/10 transition-colors"
          >
            Remove from project
          </button>
        </div>
      )}
    </div>
  );
}
