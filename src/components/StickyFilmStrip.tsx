import { useNavigate } from "react-router-dom";
import type { Clip } from "@/types/project";

interface StickyFilmStripProps {
  clips: Clip[];
  projectId: string;
  activeId?: string | null;
  transitionValue?: string | null;
  soundMood?: string | null;
}

const MAX_VISIBLE = 7;

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

// Single quarter note — stem + filled notehead (Material Design music_note path)
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

  const inFilm = clips
    .filter((c) => c.include === 1)
    .sort((a, b) => a.sort_order - b.sort_order);

  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  const visibleClips = inFilm.slice(0, MAX_VISIBLE);
  const overflowCount = inFilm.length - MAX_VISIBLE;

  const showTransitionChip = transitionValue && transitionValue !== "none";
  const showMusicChip = soundMood && soundMood !== "none";

  return (
    <div
      data-testid="sticky-filmstrip"
      className="flex-shrink-0 border-t border-white/10 bg-[#0a0a0a] flex items-center px-3 gap-3"
      style={{ height: 100 }}
    >
      {/* Thumbnail row — overflow: hidden truncates past MAX_VISIBLE */}
      <div className="flex items-center gap-1.5 overflow-hidden flex-1 min-w-0 h-full py-2">
        {inFilm.length === 0 ? (
          <div className="flex items-center gap-1.5 px-2">
            <svg className="w-5 h-5 text-[#e5e5e5]/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M7 4v16M17 4v16M3 8h4m10 0h4M3 16h4m10 0h4M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" />
            </svg>
            <span className="text-[#e5e5e5]/30 text-sm whitespace-nowrap">No clips yet</span>
          </div>
        ) : (
          <>
            {visibleClips.map((clip, idx) => {
              const isActive = clip.id === activeId;
              const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
              return (
                <div
                  key={clip.id}
                  className={`relative flex-shrink-0 rounded overflow-hidden border-2 transition-colors ${
                    isActive ? "border-[#FF8A65]" : "border-white/15"
                  }`}
                  style={{ width: 90, height: 56 }}
                  draggable={false}
                >
                  {/* Sequence number */}
                  <div className="absolute top-0.5 left-0.5 w-4 h-4 rounded bg-black/60 flex items-center justify-center z-10 pointer-events-none">
                    <span className="text-[9px] text-white font-bold">{idx + 1}</span>
                  </div>

                  {clip.thumbnail_data ? (
                    <img
                      src={clip.thumbnail_data}
                      alt={clip.filename}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-full h-full bg-white/5 flex items-center justify-center">
                      <svg className="w-4 h-4 text-[#e5e5e5]/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                        <path d="M15 10l4.553-2.069A1 1 0 0121 8.94V15.06a1 1 0 01-1.447.908L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                      </svg>
                    </div>
                  )}

                  {/* Duration overlay */}
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5 pointer-events-none">
                    <span className="text-[8px] text-white/80 font-mono">{fmtMs(trimmedMs)}</span>
                  </div>
                </div>
              );
            })}

            {/* Overflow badge */}
            {overflowCount > 0 && (
              <div className="flex-shrink-0 flex items-center justify-center w-10 h-12 rounded bg-white/10">
                <span className="text-[10px] text-[#e5e5e5]/60 font-medium">+{overflowCount}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Duration summary */}
      <div className="flex-shrink-0 flex flex-col items-center justify-center gap-0.5 border-l border-white/10 pl-3">
        <span className="text-[10px] text-[#e5e5e5]/40 uppercase tracking-wide">Total</span>
        <span className="text-sm font-mono text-[#e5e5e5] font-semibold">{fmtMs(totalMs)}</span>
        <span className="text-[10px] text-[#e5e5e5]/40">
          {inFilm.length} clip{inFilm.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Navigation chips — absent when unset */}
      {(showTransitionChip || showMusicChip) && (
        <div className="flex-shrink-0 flex items-center gap-2 border-l border-white/10 pl-3">
          {showTransitionChip && (
            <button
              onClick={() => navigate(`/transitions/${projectId}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 hover:bg-white/5 transition-all duration-200 whitespace-nowrap"
              title="Change transition"
            >
              <ScissorsIcon />
              {capitalize(transitionValue!)}
            </button>
          )}
          {showMusicChip && (
            <button
              onClick={() => navigate(`/sound/${projectId}`)}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-white/20 text-[#e5e5e5] text-sm rounded-md hover:border-white/40 hover:bg-white/5 transition-all duration-200 whitespace-nowrap"
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
