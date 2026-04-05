import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip, ProjectWithClips } from "@/types/project";
import { ClipNavStrip } from "@/components/review/ClipNavStrip";

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const secs = s % 60;
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

const ZOOM_PRESETS: { label: string; value: string | null }[] = [
  { label: "None", value: null },
  { label: "Gentle", value: "gentle" },
  { label: "Medium", value: "medium" },
  { label: "Tight", value: "tight" },
];

function zoomScale(mode: string | null): number {
  if (mode === "tight") return 1.5;
  if (mode === "medium") return 1.3;
  return 1.2; // gentle or null defaults to gentle preview
}

export default function Review() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [expandedPrecise, setExpandedPrecise] = useState(false);
  const [projectName, setProjectName] = useState("");

  // Per-clip review state — reset when clip changes
  const [focalX, setFocalX] = useState<number | null>(null);
  const [focalY, setFocalY] = useState<number | null>(null);
  const [inMs, setInMs] = useState<number>(0);
  const [outMs, setOutMs] = useState<number>(0);
  const [zoomMode, setZoomMode] = useState<string | null>(null);

  // Focal point animation
  const [showZoomPreview, setShowZoomPreview] = useState(false);
  const zoomPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const isSaving = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
        const stored = sessionStorage.getItem(`review_index_${projectId}`);
        const idx = stored
          ? Math.min(parseInt(stored, 10), data.clips.length - 1)
          : 0;
        setCurrentIndex(idx);
        const clip = data.clips[idx];
        if (clip) {
          setInMs(clip.in_ms ?? 0);
          setOutMs(clip.out_ms ?? clip.duration_ms);
          setFocalX(clip.focal_x);
          setFocalY(clip.focal_y);
          setZoomMode(clip.zoom_mode);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const clip = clips[currentIndex] ?? null;

  // Reset per-clip state when the current clip changes
  useEffect(() => {
    if (!clip) return;
    setInMs(clip.in_ms ?? 0);
    setOutMs(clip.out_ms ?? clip.duration_ms);
    setFocalX(clip.focal_x);
    setFocalY(clip.focal_y);
    setZoomMode(clip.zoom_mode);
    setExpandedPrecise(false);
    setShowZoomPreview(false);
  }, [currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear zoom preview timeout on unmount
  useEffect(() => {
    return () => {
      if (zoomPreviewTimer.current) clearTimeout(zoomPreviewTimer.current);
    };
  }, []);

  // Dismiss zoom preview after 1.5s
  useEffect(() => {
    if (!showZoomPreview) return;
    if (zoomPreviewTimer.current) clearTimeout(zoomPreviewTimer.current);
    zoomPreviewTimer.current = setTimeout(() => setShowZoomPreview(false), 1500);
  }, [showZoomPreview]);

  /** Save current clip's review data without advancing. */
  const saveCurrentClip = useCallback(async () => {
    if (!clip || !projectId || isSaving.current) return;
    isSaving.current = true;
    try {
      console.log("[review] save clip", clip.id, { include: clip.include, inMs, outMs, focalX, focalY, zoomMode });
      await invoke("update_clip_review_cmd", {
        clipId: clip.id,
        inMs: inMs > 0 ? inMs : null,
        outMs: outMs < clip.duration_ms ? outMs : null,
        focalX,
        focalY,
        zoomMode,
        include: clip.include,
      });
    } finally {
      isSaving.current = false;
    }
  }, [clip, projectId, inMs, outMs, focalX, focalY, zoomMode]);

  /** Save current clip with the given include value and advance to next clip or editor. */
  const saveAndAdvance = useCallback(
    async (include: number) => {
      if (!clip || !projectId || isSaving.current) return;
      isSaving.current = true;
      try {
        console.log("[review] save clip", clip.id, { include, inMs, outMs, focalX, focalY, zoomMode });
        await invoke("update_clip_review_cmd", {
          clipId: clip.id,
          inMs: inMs > 0 ? inMs : null,
          outMs: outMs < clip.duration_ms ? outMs : null,
          focalX,
          focalY,
          zoomMode,
          include,
        });
        const nextIndex = currentIndex + 1;
        if (nextIndex >= clips.length) {
          sessionStorage.removeItem(`review_index_${projectId}`);
          navigate(`/editor/${projectId}`);
        } else {
          sessionStorage.setItem(`review_index_${projectId}`, String(nextIndex));
          setCurrentIndex(nextIndex);
        }
      } finally {
        isSaving.current = false;
      }
    },
    [clip, projectId, inMs, outMs, focalX, focalY, zoomMode, currentIndex, clips.length, navigate]
  );

  // Keyboard shortcuts: Enter = save & next (neutral), Space = skip (include=0)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter") {
        e.preventDefault();
        console.log("[review] keyboard next (include=current)");
        saveAndAdvance(clip?.include ?? 1);
      } else if (e.key === " ") {
        e.preventDefault();
        console.log("[review] keyboard skip (include=0)");
        saveAndAdvance(0);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saveAndAdvance, clip]);

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setFocalX(x);
    setFocalY(y);
    setShowZoomPreview(true);
    console.log("[review] focal set", { focalX: x, focalY: y, zoomMode });
  }

  function handleInChange(val: number) {
    const clamped = Math.min(val, outMs - 500);
    setInMs(Math.max(0, clamped));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  function handleOutChange(val: number) {
    if (!clip) return;
    const clamped = Math.max(val, inMs + 500);
    setOutMs(Math.min(clip.duration_ms, clamped));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  async function handleStripSelect(idx: number) {
    if (idx === currentIndex) return;
    if (isSaving.current) return;
    console.log("[review] save-before-jump idx=" + idx);
    await saveCurrentClip();
    sessionStorage.setItem(`review_index_${projectId}`, String(idx));
    setCurrentIndex(idx);
  }

  async function handleStripReorder(reordered: Clip[]) {
    const previous = clips;
    setClips(reordered); // optimistic
    try {
      await invoke("reorder_clips_cmd", { clipIds: reordered.map((c) => c.id) });
      console.log("[review] reorder saved", reordered.map((c) => c.id));
    } catch (err) {
      console.error("[review] reorder failed, rolling back", err);
      setClips(previous); // rollback
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <span className="inline-block w-8 h-8 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!clip) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-[#a3a3a3]">No clips to review.</p>
          <button
            onClick={() => navigate(`/editor/${projectId}`)}
            className="px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors"
          >
            Go to Editor
          </button>
        </div>
      </div>
    );
  }

  const total = clips.length;
  const videoSrc = convertFileSrc(clip.proxy_path ?? clip.local_path);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3 ml-10">
          <button
            onClick={() => navigate(`/editor/${projectId}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[#C5FFF9]/40 text-[#C5FFF9] text-sm font-medium rounded-md hover:bg-[#C5FFF9]/10 transition-colors"
          >
            &#8592; Back
          </button>
          <span className="text-[#a3a3a3] text-sm hidden sm:inline">{projectName}</span>
        </div>
        <div className="text-center">
          <h1 className="text-[#FF8A65] font-semibold text-base leading-tight">Build Your Film</h1>
          <p className="text-[#a3a3a3] text-sm">Clip {currentIndex + 1} of {total}</p>
        </div>
        {/* Spacer to balance the back button */}
        <div className="w-[80px]" />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-4 py-6 gap-4 max-w-4xl mx-auto w-full">

        {/* Clip nav thumbnail strip */}
        <ClipNavStrip
          clips={clips}
          currentIndex={currentIndex}
          onSelect={handleStripSelect}
          onReorder={handleStripReorder}
        />

        {/* Video player with focal point overlay */}
        <div className="w-full rounded-xl overflow-hidden bg-black relative" style={{ aspectRatio: "16/9" }}>
          <video
            ref={videoRef}
            key={clip.id}
            src={videoSrc}
            loop
            muted
            playsInline
            className="w-full h-full object-contain"
          />
          {/* Zoom preview overlay — brief CSS animation on focal click */}
          {focalX !== null && focalY !== null && (
            <div
              className="absolute inset-0 pointer-events-none bg-black/10 rounded-xl"
              style={
                {
                  transformOrigin: `${focalX * 100}% ${focalY * 100}%`,
                  animation: showZoomPreview
                    ? "rc-zoom-preview 1.5s ease-out forwards"
                    : "none",
                  "--zoom-scale": zoomScale(zoomMode),
                } as React.CSSProperties
              }
            />
          )}
          {/* Transparent overlay for focal point picking */}
          <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            className="absolute inset-0 cursor-crosshair"
          />
          {/* Focal point dot — pulses when set */}
          {focalX !== null && focalY !== null && (
            <div
              className="absolute w-6 h-6 pointer-events-none"
              style={{
                left: `${focalX * 100}%`,
                top: `${focalY * 100}%`,
                animation: "rc-focal-pulse 2s ease-in-out infinite",
              }}
            >
              <div className="w-full h-full rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 shadow-lg" />
            </div>
          )}
        </div>

        {/* Clip info */}
        <div className="w-full">
          <p className="text-[#e5e5e5] text-sm font-medium truncate max-w-xs" title={clip.filename}>
            {clip.filename}
          </p>
          <p className="text-[#a3a3a3] text-xs mt-0.5">
            {fmtMs(clip.duration_ms)} &middot; {clip.width}x{clip.height}
          </p>
        </div>

        {/* Primary action: Next / Finish */}
        <div className="flex flex-col items-center gap-2 w-full">
          <button
            onClick={() => saveAndAdvance(clip.include ?? 1)}
            className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
            <span className="text-xs text-[#0a0a0a]/60 font-normal">Enter</span>
            <span className="ml-1">&#8594;</span>
          </button>
          {/* Skip is a secondary / destructive action */}
          <button
            onClick={() => saveAndAdvance(0)}
            className="text-sm text-[#a3a3a3] underline underline-offset-2 hover:text-red-400 transition-colors"
          >
            Skip this clip
            <span className="ml-1.5 text-xs no-underline text-[#555555]">Space</span>
          </button>
        </div>

        {/* "More options" toggle */}
        <button
          onClick={() => setExpandedPrecise((v) => !v)}
          className="flex items-center gap-1.5 text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
        >
          <span>{expandedPrecise ? "Hide options" : "More options"}</span>
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${expandedPrecise ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {/* Precise mode panel */}
        {expandedPrecise && (
          <div className="w-full bg-white/[0.03] border border-white/10 rounded-xl p-5 space-y-6">

            {/* IN/OUT trim */}
            <div className="space-y-4">
              <p className="text-sm font-medium text-[#e5e5e5]">Trim</p>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-[#a3a3a3]">
                    <span>IN point</span>
                    <span className="font-mono text-[#e5e5e5]">{fmtMs(inMs)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={clip.duration_ms}
                    step={100}
                    value={inMs}
                    onChange={(e) => handleInChange(Number(e.target.value))}
                    className="w-full accent-[#FF8A65]"
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-[#a3a3a3]">
                    <span>OUT point</span>
                    <span className="font-mono text-[#e5e5e5]">{fmtMs(outMs)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={clip.duration_ms}
                    step={100}
                    value={outMs}
                    onChange={(e) => handleOutChange(Number(e.target.value))}
                    className="w-full accent-[#FF8A65]"
                  />
                </div>
                <p className="text-xs text-[#a3a3a3]">
                  Selected: {fmtMs(inMs)} &rarr; {fmtMs(outMs)}
                  &nbsp;&middot;&nbsp;{fmtMs(Math.max(0, outMs - inMs))} used
                </p>
              </div>
            </div>

            {/* Zoom preset */}
            <div className="space-y-3">
              <p className="text-sm font-medium text-[#e5e5e5]">Zoom</p>
              <div className="flex gap-2 flex-wrap">
                {ZOOM_PRESETS.map((preset) => {
                  const active = zoomMode === preset.value;
                  return (
                    <button
                      key={String(preset.value)}
                      onClick={() => setZoomMode(preset.value)}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border ${
                        active
                          ? "bg-[#99B3FF]/20 border-[#99B3FF] text-[#99B3FF]"
                          : "border-white/20 text-[#a3a3a3] hover:border-white/40 hover:text-[#e5e5e5]"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
