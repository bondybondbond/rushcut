import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, Play, Pause } from "lucide-react";
import type { Clip, ProjectWithClips } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";
import { fmtMs } from "@/utils/fmtMs";

type TransitionValue = "none" | "crossfade" | "dip_to_black";
type ArrangeTab = "zoom" | "transitions" | "cards" | "sound";

const TRANSITIONS: { value: TransitionValue; label: string; description: string }[] = [
  { value: "none",        label: "None",        description: "Hard cut between clips — clean and fast." },
  { value: "crossfade",   label: "Crossfade",   description: "Smooth 1.5s dissolve between clips." },
  { value: "dip_to_black", label: "Dip to black", description: "Fades to black then back in — cinematic pacing." },
];

// Zoom chips — labels per PRD, mapped to zoom_mode values used by the pipeline.
const ZOOM_PRESETS: { label: string; value: string | null }[] = [
  { label: "Off",  value: null },
  { label: "1.3×", value: "gentle" },
  { label: "1.5×", value: "medium" },
  { label: "2×",   value: "tight" },
];

const ARRANGE_TABS: { id: ArrangeTab; label: string }[] = [
  { id: "zoom",         label: "Zoom" },
  { id: "transitions",  label: "Transitions" },
  { id: "cards",        label: "Cards" },
  { id: "sound",        label: "Sound" },
];

const VOLUME_PRESETS = [0, 50, 100] as const;

const ZOOM_SCALE: Record<string, number> = { gentle: 1.3, medium: 1.5, tight: 2.0 };

export default function Arrange() {
  const { projectId } = useParams<{ projectId: string }>();

  const _cached = projectCache.get(projectId ?? "");
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [tab, setTab] = useState<ArrangeTab>("zoom");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Clip playback state
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  const focalImgRef = useRef<HTMLDivElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const isDraggingFocalRef = useRef(false);
  const selectedClipRef = useRef<Clip | null>(null);
  const loadedSrcRef = useRef<string>("");

  // Sound tab — independent video instance + playback state
  const soundVideoRef = useRef<HTMLVideoElement>(null);
  const soundLoadedSrcRef = useRef<string>("");
  const [soundIsPlaying, setSoundIsPlaying] = useState(false);
  const [soundCurrentMs, setSoundCurrentMs] = useState(0);
  const [soundDurationMs, setSoundDurationMs] = useState(0);

  // Sound tab — per-clip volume custom input + explicit Custom-chip visibility flag
  const [customVolInput, setCustomVolInput] = useState<number>(100);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const volumeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageKey = `rc_transition_${projectId}`;
  const [transition, setTransition] = useState<TransitionValue>(
    () => (sessionStorage.getItem(storageKey) as TransitionValue | null) ?? "none"
  );

  const configured = useConfiguredTabs(projectId ?? "");

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  const selectedClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) ?? null : null;
  selectedClipRef.current = selectedClip;

  const soundMoodVal = (() => {
    try {
      const raw = sessionStorage.getItem(`rc_sound_${projectId}`);
      return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null;
    } catch { return null; }
  })();

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        projectCache.set(projectId, { name: data.project.name, clips: data.clips });
        setProjectName(data.project.name);
        setClips(data.clips);
      })
      .catch(() => {});
  }, [projectId]);

  // Pause the outgoing tab's video immediately on tab switch.
  useEffect(() => {
    if (tab !== "zoom") {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
    if (tab !== "sound") {
      soundVideoRef.current?.pause();
      setSoundIsPlaying(false);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected clip changes OR tab returns to "zoom", reload video source.
  // Skip reload if the same src is already loaded (e.g. returning from another tab).
  useEffect(() => {
    if (tab !== "zoom") return;
    const video = videoRef.current;
    if (!video) return;

    if (!selectedClip) {
      loadedSrcRef.current = "";
      video.src = "";
      setIsPlaying(false);
      setCurrentMs(0);
      setDurationMs(0);
      return;
    }

    const src = selectedClip.proxy_path
      ? convertFileSrc(selectedClip.proxy_path)
      : convertFileSrc(selectedClip.local_path);

    if (src === loadedSrcRef.current) return; // same clip — keep playback position

    loadedSrcRef.current = src;
    setIsPlaying(false);
    setCurrentMs(0);
    setDurationMs(0);
    video.src = src;
    video.load();
  }, [selectedClipId, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sound tab — independent video reload (mirrors zoom tab pattern, separate state)
  useEffect(() => {
    if (tab !== "sound") return;
    const video = soundVideoRef.current;
    if (!video) return;

    if (!selectedClip) {
      soundLoadedSrcRef.current = "";
      video.src = "";
      setSoundIsPlaying(false);
      setSoundCurrentMs(0);
      setSoundDurationMs(0);
      return;
    }

    const src = selectedClip.proxy_path
      ? convertFileSrc(selectedClip.proxy_path)
      : convertFileSrc(selectedClip.local_path);

    if (src === soundLoadedSrcRef.current) return;

    soundLoadedSrcRef.current = src;
    setSoundIsPlaying(false);
    setSoundCurrentMs(0);
    setSoundDurationMs(0);
    video.src = src;
    video.load();
  }, [selectedClipId, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelectTransition(val: TransitionValue) {
    setTransition(val);
    sessionStorage.setItem(storageKey, val);
  }

  // Optimistic local patch — keeps the right panel in sync without a refetch.
  function patchClip(clipId: string, patch: Partial<Clip>) {
    setClips((prev) => {
      const next = prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
      if (projectId) projectCache.set(projectId, { name: projectName, clips: next });
      return next;
    });
  }

  async function saveReview(clip: Clip, patch: Partial<Pick<Clip, "focal_x" | "focal_y" | "zoom_mode">>) {
    const merged = { ...clip, ...patch };
    patchClip(clip.id, patch);
    try {
      await invoke("update_clip_review_cmd", {
        clipId: clip.id,
        inMs: merged.in_ms,
        outMs: merged.out_ms,
        focalX: merged.focal_x,
        focalY: merged.focal_y,
        zoomMode: merged.zoom_mode,
        include: merged.include,
      });
    } catch (err) {
      console.error("[arrange] update_clip_review_cmd failed", err);
    }
  }

  // Save per-clip volume (percent 0–200 → float 0–2.0).
  // Note: video.volume is clamped to 1.0 by the browser; 150/200% preview sounds
  // same as 100% but the value is saved and FFmpeg applies the real boost on render.
  function saveVolume(clip: Clip, percent: number) {
    const volume = Math.max(0, Math.min(200, Math.round(percent))) / 100;
    patchClip(clip.id, { clip_volume: volume });
    if (soundVideoRef.current) soundVideoRef.current.volume = Math.min(1.0, volume);
    if (volumeDebounceRef.current !== null) clearTimeout(volumeDebounceRef.current);
    volumeDebounceRef.current = setTimeout(async () => {
      try {
        await invoke("update_clip_volume_cmd", { clipId: clip.id, clipVolume: volume });
      } catch (err) {
        console.error("[arrange] update_clip_volume_cmd failed", err);
      }
      volumeDebounceRef.current = null;
    }, 300);
  }

  function handleFocalClick(clip: Clip, e: React.MouseEvent<HTMLDivElement>) {
    const el = focalImgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    saveReview(clip, { focal_x: x, focal_y: y });
  }

  function getFocalFromMouse(e: MouseEvent): { x: number; y: number } | null {
    const el = videoBoxRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function handleVideoMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const clip = selectedClipRef.current;
    if (!clip || !clip.zoom_mode) return;
    e.preventDefault();
    isDraggingFocalRef.current = true;
    const pos = getFocalFromMouse(e.nativeEvent);
    if (pos) patchClip(clip.id, { focal_x: pos.x, focal_y: pos.y });
  }

  // Window-level drag tracking for focal point — runs once, reads from refs
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!isDraggingFocalRef.current) return;
      const clip = selectedClipRef.current;
      const pos = getFocalFromMouse(e);
      if (!clip || !pos) return;
      patchClip(clip.id, { focal_x: pos.x, focal_y: pos.y });
    }
    function onUp(e: MouseEvent) {
      if (!isDraggingFocalRef.current) return;
      isDraggingFocalRef.current = false;
      const clip = selectedClipRef.current;
      const pos = getFocalFromMouse(e);
      if (clip && pos) saveReview(clip, { focal_x: pos.x, focal_y: pos.y });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Prev/Next clip navigation helpers.
  const selectedIndex = selectedClipId ? inFilm.findIndex((c) => c.id === selectedClipId) : -1;

  // Film-time position of the current clip playback — drives the StickyFilmStrip playhead.
  const filmPlayheadMs = selectedIndex >= 0 && selectedClip
    ? inFilm.slice(0, selectedIndex).reduce(
        (sum, c) => sum + Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0)),
        0
      ) + Math.max(0, currentMs - (selectedClip.in_ms ?? 0))
    : undefined;

  const prevClip = useCallback(() => {
    if (selectedIndex > 0) setSelectedClipId(inFilm[selectedIndex - 1].id);
  }, [selectedIndex, inFilm]);

  const nextClip = useCallback(() => {
    if (selectedIndex < inFilm.length - 1) setSelectedClipId(inFilm[selectedIndex + 1].id);
  }, [selectedIndex, inFilm]);

  // Playback controls
  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const inMs = selectedClipRef.current?.in_ms ?? 0;
      const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
      if (video.currentTime * 1000 >= outMs) {
        video.currentTime = inMs / 1000;
        setCurrentMs(inMs);
      }
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const ms = video.currentTime * 1000;
    const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
    if (ms >= outMs) {
      video.pause();
      video.currentTime = outMs / 1000;
      setIsPlaying(false);
      setCurrentMs(outMs);
      return;
    }
    setCurrentMs(ms);
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setDurationMs(video.duration * 1000);
    const inMs = selectedClipRef.current?.in_ms ?? 0;
    video.currentTime = inMs / 1000;
    setCurrentMs(inMs);
  }

  function handleVideoEnded() {
    setIsPlaying(false);
  }

  function handleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = parseFloat(e.target.value);
    setCurrentMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  }

  // Sound tab playback handlers (parallel to zoom tab handlers above)
  function soundTogglePlay() {
    const video = soundVideoRef.current;
    if (!video) return;
    if (video.paused) {
      const inMs = selectedClipRef.current?.in_ms ?? 0;
      const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
      if (video.currentTime * 1000 >= outMs) {
        video.currentTime = inMs / 1000;
        setSoundCurrentMs(inMs);
      }
      video.play().catch(() => {});
      setSoundIsPlaying(true);
    } else {
      video.pause();
      setSoundIsPlaying(false);
    }
  }

  function soundHandleTimeUpdate() {
    const video = soundVideoRef.current;
    if (!video) return;
    const ms = video.currentTime * 1000;
    const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
    if (ms >= outMs) {
      video.pause();
      video.currentTime = outMs / 1000;
      setSoundIsPlaying(false);
      setSoundCurrentMs(outMs);
      return;
    }
    setSoundCurrentMs(ms);
  }

  function soundHandleLoadedMetadata() {
    const video = soundVideoRef.current;
    if (!video) return;
    setSoundDurationMs(video.duration * 1000);
    const inMs = selectedClipRef.current?.in_ms ?? 0;
    video.currentTime = inMs / 1000;
    setSoundCurrentMs(inMs);
    video.volume = Math.min(1.0, selectedClipRef.current?.clip_volume ?? 1.0);
  }

  function soundHandleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = parseFloat(e.target.value);
    setSoundCurrentMs(ms);
    if (soundVideoRef.current) soundVideoRef.current.currentTime = ms / 1000;
  }

  function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={totalMs}
      activeTab="arrange"
      configured={configured}
      transitionValue={transition}
      soundMood={soundMoodVal}
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
          activeId={tab === "zoom" || tab === "sound" ? selectedClipId : null}
          onSelectClip={tab === "zoom" || tab === "sound" ? setSelectedClipId : undefined}
          playheadMs={tab === "zoom" ? filmPlayheadMs : undefined}
        />
      }
    >
      <div className="flex flex-col flex-1 min-w-0">
        {/* In-screen tab bar — centred */}
        <div className="flex items-center justify-center gap-2 px-6 pt-3 pb-3 border-b border-white/10 flex-shrink-0">
          {ARRANGE_TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              data-testid={`arrange-tab-${id}`}
              onClick={() => setTab(id)}
              className={`text-sm rounded-md px-4 py-1.5 border transition-all duration-200 font-medium ${
                tab === id
                  ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                  : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Zoom tab — kept mounted (hidden not unmounted) so video never reloads on tab switch */}
        <div className={tab === "zoom" ? "flex flex-1 min-h-0" : "hidden"}>

            {/* Left clip rail */}
            <div className="w-40 flex-shrink-0 border-r border-white/10 overflow-y-auto bg-[#0a0a0a] p-2">
              <p className="text-xs text-[#a3a3a3] px-1 pb-2">clips</p>
              <div className="flex flex-col gap-1.5">
                {inFilm.map((clip, idx) => {
                  const isActive = clip.id === selectedClipId;
                  const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      data-testid={`arrange-rail-clip-${clip.id}`}
                      onClick={() => setSelectedClipId(clip.id)}
                      className={`relative rounded-md overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                        isActive
                          ? "border-[#FF8A65]"
                          : "border-[#99B3FF]/25 hover:border-[#99B3FF]/50"
                      }`}
                      style={{ aspectRatio: "16/9", background: "#111" }}
                    >
                      {clip.thumbnail_data ? (
                        <img
                          src={clip.thumbnail_data}
                          alt={clip.filename}
                          className="w-full h-full object-cover pointer-events-none"
                        />
                      ) : (
                        <div className="w-full h-full bg-white/5" />
                      )}
                      {/* Clip number badge — top-left */}
                      <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center pointer-events-none">
                        <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                      </div>
                      {/* Duration + zoom badge row — bottom */}
                      <div className="absolute bottom-0 inset-x-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                        <span className="text-[9px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                        {clip.zoom_mode != null && (
                          <div className="w-3.5 h-3.5 rounded-sm bg-[#22c55e] flex items-center justify-center">
                            <span className="text-[8px] font-bold text-[#0a0a0a] leading-none select-none">Z</span>
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
                {inFilm.length === 0 && (
                  <p className="text-xs text-[#a3a3a3] italic px-1">No clips in film</p>
                )}
              </div>
            </div>

            {/* Centre — preview + playback */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0 px-4 py-4 gap-3">
              {/* Prev | video | Next row — fills available height */}
              <div className="flex gap-4 flex-1 min-h-0">
                {/* Prev */}
                <button
                  type="button"
                  data-testid="arrange-prev"
                  onClick={prevClip}
                  disabled={selectedIndex <= 0}
                  className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={14} />
                  Prev
                </button>

                {/* Video wrapper — stretches to row height, then 16:9 box centered inside */}
                <div className="flex-1 min-w-0 self-stretch flex items-center justify-center overflow-hidden">
                  {(() => {
                    const zoomScale = ZOOM_SCALE[selectedClip?.zoom_mode ?? ""] ?? 1;
                    const focalX = (selectedClip?.focal_x ?? 0.5) * 100;
                    const focalY = (selectedClip?.focal_y ?? 0.5) * 100;
                    return (
                      <div
                        ref={videoBoxRef}
                        className="relative bg-black border border-white/10 rounded-lg overflow-hidden"
                        style={{
                          height: "100%",
                          aspectRatio: "16/9",
                          maxWidth: "100%",
                          cursor: selectedClip?.zoom_mode ? "crosshair" : "default",
                        }}
                        onMouseDown={handleVideoMouseDown}
                      >
                        <video
                          ref={videoRef}
                          className="absolute inset-0 w-full h-full object-cover"
                          style={{
                            transform: zoomScale > 1 ? `scale(${zoomScale})` : undefined,
                            transformOrigin: `${focalX}% ${focalY}%`,
                            transition: "transform 0.3s ease",
                          }}
                          onTimeUpdate={handleTimeUpdate}
                          onLoadedMetadata={handleLoadedMetadata}
                          onEnded={handleVideoEnded}
                          onError={() => {
                            const video = videoRef.current;
                            if (!video || !selectedClip) return;
                            if (selectedClip.proxy_path) {
                              video.src = convertFileSrc(selectedClip.local_path);
                              video.load();
                            }
                          }}
                        />
                        {/* Focal point crosshair indicator — only when zoom active */}
                        {selectedClip?.zoom_mode && (
                          <div
                            className="absolute w-5 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/20 pointer-events-none z-10"
                            style={{
                              left: `${focalX}%`,
                              top: `${focalY}%`,
                              transition: isDraggingFocalRef.current ? "none" : "left 0.1s ease, top 0.1s ease",
                            }}
                          />
                        )}
                        {!selectedClip && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Next */}
                <button
                  type="button"
                  data-testid="arrange-next"
                  onClick={nextClip}
                  disabled={selectedIndex < 0 || selectedIndex >= inFilm.length - 1}
                  className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>

              {/* Filename + resolution */}
              {selectedClip && (
                <p
                  className="text-sm text-[#a3a3a3] truncate"
                  data-testid="arrange-selected-filename"
                >
                  {selectedClip.filename}
                  {selectedClip.width && selectedClip.height
                    ? ` · ${selectedClip.width}x${selectedClip.height}`
                    : ""}
                </p>
              )}

              {/* Play + scrubber */}
              {selectedClip && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    data-testid="arrange-play-btn"
                    onClick={togglePlay}
                    className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-all duration-200"
                  >
                    {isPlaying
                      ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                      : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
                  </button>
                  {(() => {
                    const clipInMs = selectedClip.in_ms ?? 0;
                    const clipOutMs = selectedClip.out_ms ?? durationMs;
                    const trimmedMs = Math.max(0, clipOutMs - clipInMs);
                    return (
                      <>
                        <input
                          type="range"
                          min={clipInMs}
                          max={clipOutMs || clipInMs + 1}
                          step={100}
                          value={currentMs}
                          onChange={handleScrubberChange}
                          className="flex-1 accent-[#FF8A65] h-1 cursor-pointer"
                          data-testid="arrange-scrubber"
                        />
                        <span className="text-xs text-[#a3a3a3] flex-shrink-0 tabular-nums w-20 text-right">
                          {formatTime(Math.max(0, currentMs - clipInMs))} / {formatTime(trimmedMs)}
                        </span>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Right panel — zoom + focal */}
            <aside className="w-56 flex-shrink-0 border-l border-white/10 overflow-y-auto p-4 bg-[#0a0a0a]">
              {!selectedClip ? (
                <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
              ) : (
                <div className="space-y-5">
                  {/* Zoom */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-[#e5e5e5]">Zoom</p>
                    <div className="flex flex-wrap gap-2">
                      {ZOOM_PRESETS.map(({ label, value }) => {
                        const active = (selectedClip.zoom_mode ?? null) === value;
                        return (
                          <button
                            key={label}
                            type="button"
                            data-testid={`chip-zoom-${label}`}
                            onClick={() => saveReview(selectedClip, { zoom_mode: value })}
                            className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                              active
                                ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                                : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Focal point — only when zoom is on */}
                  {selectedClip.zoom_mode && (
                    <div className="space-y-2 pt-4 border-t border-white/10">
                      <p className="text-sm font-medium text-[#e5e5e5]">Focal point</p>
                      <div
                        ref={focalImgRef}
                        onClick={(e) => handleFocalClick(selectedClip, e)}
                        className="relative rounded-md overflow-hidden bg-black border border-white/15 cursor-crosshair"
                        style={{ aspectRatio: "16/9" }}
                      >
                        {selectedClip.thumbnail_data ? (
                          <img
                            src={selectedClip.thumbnail_data}
                            alt="focal target"
                            className="w-full h-full object-cover pointer-events-none"
                          />
                        ) : (
                          <div className="w-full h-full bg-white/5" />
                        )}
                        {selectedClip.focal_x !== null && selectedClip.focal_y !== null && (
                          <div
                            className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 pointer-events-none"
                            style={{
                              left: `${selectedClip.focal_x * 100}%`,
                              top: `${selectedClip.focal_y * 100}%`,
                            }}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => saveReview(selectedClip, { focal_x: null, focal_y: null })}
                        className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
                      >
                        Reset to centre
                      </button>
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>

        {/* ── Transitions tab ─────────────────────────────────────── */}
        {tab === "transitions" && (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
              <div>
                <h1 className="text-3xl font-semibold text-[#FF8A65]">Transitions</h1>
                <p className="text-base text-[#a3a3a3] mt-1">
                  How should RushCut cut between each clip in your film?
                </p>
              </div>

              <div className="border border-white/15 rounded-lg p-6 space-y-4">
                <p className="text-xl font-medium text-[#e5e5e5]">Between clips</p>

                <div className="flex flex-wrap gap-3">
                  {TRANSITIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-transition-${value}`}
                      onClick={() => handleSelectTransition(value)}
                      className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                        transition === value
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <p className="text-sm text-[#a3a3a3]">
                  {TRANSITIONS.find((t) => t.value === transition)?.description}
                </p>
              </div>

              <p className="text-sm text-[#a3a3a3]">
                Your choice is saved automatically. Continue to Sound to choose music for your film.
              </p>
            </div>
          </div>
        )}

        {/* ── Cards tab ───────────────────────────────────────────── */}
        {tab === "cards" && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-[#a3a3a3] italic">Coming soon</p>
          </div>
        )}

        {/* ── Sound tab — per-clip volume (kept mounted, hidden not unmounted) ── */}
        <div className={tab === "sound" ? "flex flex-1 min-h-0" : "hidden"}>
          {/* Left clip rail — copy of zoom tab rail, intentionally not extracted */}
          <div className="w-40 flex-shrink-0 border-r border-white/10 overflow-y-auto bg-[#0a0a0a] p-2">
            <p className="text-xs text-[#a3a3a3] px-1 pb-2">clips</p>
            <div className="flex flex-col gap-1.5">
              {inFilm.map((clip, idx) => {
                const isActive = clip.id === selectedClipId;
                const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
                const vol = clip.clip_volume ?? 1.0;
                const volPct = Math.round(vol * 100);
                return (
                  <button
                    key={clip.id}
                    type="button"
                    data-testid={`sound-rail-clip-${clip.id}`}
                    onClick={() => setSelectedClipId(clip.id)}
                    className={`relative rounded-md overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                      isActive
                        ? "border-[#FF8A65]"
                        : "border-[#99B3FF]/25 hover:border-[#99B3FF]/50"
                    }`}
                    style={{ aspectRatio: "16/9", background: "#111" }}
                  >
                    {clip.thumbnail_data ? (
                      <img
                        src={clip.thumbnail_data}
                        alt={clip.filename}
                        className="w-full h-full object-cover pointer-events-none"
                      />
                    ) : (
                      <div className="w-full h-full bg-white/5" />
                    )}
                    {/* Clip number badge */}
                    <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center pointer-events-none">
                      <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                    </div>
                    {/* Duration + volume label */}
                    <div className="absolute bottom-0 inset-x-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                      <span className="text-[9px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                      {vol !== 1.0 && (
                        <span className="text-[10px] font-bold font-mono drop-shadow-sm" style={{ color: vol === 0 ? "#f87171" : "#B794F4" }}>
                          {volPct}%
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              {inFilm.length === 0 && (
                <p className="text-xs text-[#a3a3a3] italic px-1">No clips in film</p>
              )}
            </div>
          </div>

          {/* Centre — preview + playback */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0 px-4 py-4 gap-3">
            <div className="flex gap-4 flex-1 min-h-0">
              {/* Prev */}
              <button
                type="button"
                data-testid="sound-prev"
                onClick={prevClip}
                disabled={selectedIndex <= 0}
                className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} />
                Prev
              </button>

              {/* Video wrapper */}
              <div className="flex-1 min-w-0 self-stretch flex items-center justify-center overflow-hidden">
                <div
                  className="relative bg-black border border-white/10 rounded-lg overflow-hidden"
                  style={{ height: "100%", aspectRatio: "16/9", maxWidth: "100%" }}
                >
                  <video
                    ref={soundVideoRef}
                    className="absolute inset-0 w-full h-full object-cover"
                    onTimeUpdate={soundHandleTimeUpdate}
                    onLoadedMetadata={soundHandleLoadedMetadata}
                    onEnded={() => setSoundIsPlaying(false)}
                    onError={() => {
                      const video = soundVideoRef.current;
                      if (!video || !selectedClip) return;
                      if (selectedClip.proxy_path) {
                        video.src = convertFileSrc(selectedClip.local_path);
                        video.load();
                      }
                    }}
                  />
                  {!selectedClip && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Next */}
              <button
                type="button"
                data-testid="sound-next"
                onClick={nextClip}
                disabled={selectedIndex < 0 || selectedIndex >= inFilm.length - 1}
                className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>

            {/* Filename */}
            {selectedClip && (
              <p className="text-sm text-[#a3a3a3] truncate" data-testid="sound-selected-filename">
                {selectedClip.filename}
                {selectedClip.width && selectedClip.height ? ` · ${selectedClip.width}x${selectedClip.height}` : ""}
              </p>
            )}

            {/* Play + scrubber */}
            {selectedClip && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="sound-play-btn"
                  onClick={soundTogglePlay}
                  className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-all duration-200"
                >
                  {soundIsPlaying
                    ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                    : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
                </button>
                {(() => {
                  const clipInMs = selectedClip.in_ms ?? 0;
                  const clipOutMs = selectedClip.out_ms ?? soundDurationMs;
                  const trimmedMs = Math.max(0, clipOutMs - clipInMs);
                  return (
                    <>
                      <input
                        type="range"
                        min={clipInMs}
                        max={clipOutMs || clipInMs + 1}
                        step={100}
                        value={soundCurrentMs}
                        onChange={soundHandleScrubberChange}
                        className="flex-1 accent-[#FF8A65] h-1 cursor-pointer"
                        data-testid="sound-scrubber"
                      />
                      <span className="text-xs text-[#a3a3a3] flex-shrink-0 tabular-nums w-20 text-right">
                        {formatTime(Math.max(0, soundCurrentMs - clipInMs))} / {formatTime(trimmedMs)}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Right panel — volume chips */}
          <aside className="w-56 flex-shrink-0 border-l border-white/10 overflow-y-auto p-4 bg-[#0a0a0a]">
            {!selectedClip ? (
              <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
            ) : (() => {
              const vol = selectedClip.clip_volume ?? 1.0;
              const volPct = Math.round(vol * 100);
              const isPreset = VOLUME_PRESETS.includes(volPct as typeof VOLUME_PRESETS[number]);
              const isCustomActive = !isPreset || showCustomInput;
              return (
                <div className="space-y-4">
                  <p className="text-sm font-medium text-[#e5e5e5]">Volume</p>
                  <div className="flex flex-wrap gap-2">
                    {VOLUME_PRESETS.map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        data-testid={`chip-vol-${pct}`}
                        onClick={() => {
                          saveVolume(selectedClip, pct);
                          setCustomVolInput(pct);
                          setShowCustomInput(false);
                        }}
                        className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                          !isCustomActive && volPct === pct
                            ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                            : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                        }`}
                      >
                        {pct === 0 ? "Mute" : `${pct}%`}
                      </button>
                    ))}
                    <button
                      type="button"
                      data-testid="chip-vol-custom"
                      onClick={() => {
                        setCustomVolInput(volPct);
                        setShowCustomInput(true);
                      }}
                      className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                        isCustomActive
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      Custom
                    </button>
                  </div>

                  {/* Custom numeric input — shown when no preset matches */}
                  {isCustomActive && (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={customVolInput}
                        data-testid="input-vol-custom"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v)) setCustomVolInput(v);
                        }}
                        onBlur={() => {
                          const clamped = Math.max(0, Math.min(200, customVolInput));
                          setCustomVolInput(clamped);
                          saveVolume(selectedClip, clamped);
                        }}
                        className="bg-transparent border border-white/35 rounded px-2 py-1 w-16 text-sm text-[#e5e5e5] focus:border-[#99B3FF] focus:outline-none tabular-nums"
                      />
                      <span className="text-sm text-[#a3a3a3]">%</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </aside>
        </div>
      </div>
    </EditorShell>
  );
}
