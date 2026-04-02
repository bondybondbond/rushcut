import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Clip, ProjectWithClips } from "@/types/project";

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const isSaving = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
        // Resume from sessionStorage if the user is returning to this review
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
  }, [currentIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAndAdvance = useCallback(
    async (include: number) => {
      if (!clip || !projectId || isSaving.current) return;
      isSaving.current = true;
      try {
        await invoke("update_clip_review_cmd", {
          clipId: clip.id,
          // Only send non-trivial trim values — null signals "no user trim preference"
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

  // Keyboard shortcuts: Enter = include, Space = skip
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept when focus is in a form control
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Enter") {
        e.preventDefault();
        saveAndAdvance(1);
      } else if (e.key === " ") {
        e.preventDefault();
        saveAndAdvance(0);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [saveAndAdvance]);

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    const el = overlayRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFocalX((e.clientX - rect.left) / rect.width);
    setFocalY((e.clientY - rect.top) / rect.height);
  }

  function handleInChange(val: number) {
    const clamped = Math.min(val, outMs - 500); // keep at least 0.5s gap
    setInMs(Math.max(0, clamped));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  function handleOutChange(val: number) {
    if (!clip) return;
    const clamped = Math.max(val, inMs + 500);
    setOutMs(Math.min(clip.duration_ms, clamped));
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
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
  const remaining = total - currentIndex - 1;
  const videoSrc = convertFileSrc(clip.proxy_path ?? clip.local_path);
  const usingProxy = !!clip.proxy_path;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/editor/${projectId}`)}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[#C5FFF9]/40 text-[#C5FFF9] text-sm font-medium rounded-md hover:bg-[#C5FFF9]/10 transition-colors"
          >
            &#8592; Back
          </button>
          <span className="text-[#a3a3a3] text-sm hidden sm:inline">{projectName}</span>
        </div>
        <div className="text-center">
          <span className="text-[#FF8A65] font-semibold text-sm">
            Clip {currentIndex + 1} of {total}
          </span>
          {remaining > 0 && (
            <span className="text-[#a3a3a3] text-sm ml-2">
              &mdash; {remaining} remaining
            </span>
          )}
        </div>
        <button
          onClick={() => navigate(`/editor/${projectId}`)}
          className="px-4 py-1.5 border border-white/25 text-[#e5e5e5] text-sm rounded-md hover:bg-white/5 transition-colors"
        >
          Skip Review &#8594;
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-white/10">
        <div
          className="h-full bg-[#22c55e] transition-all duration-300"
          style={{ width: `${((currentIndex) / total) * 100}%` }}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-4 py-6 gap-6 max-w-4xl mx-auto w-full">

        {/* Video player with focal point overlay */}
        <div className="w-full rounded-xl overflow-hidden bg-black relative" style={{ aspectRatio: "16/9" }}>
          <video
            ref={videoRef}
            key={clip.id}
            src={videoSrc}
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-full object-contain"
          />
          {/* Transparent overlay for focal point picking */}
          <div
            ref={overlayRef}
            onClick={handleOverlayClick}
            className="absolute inset-0 cursor-crosshair"
            title="Click to set focal point"
          />
          {/* Focal point dot */}
          {focalX !== null && focalY !== null && (
            <div
              className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{ left: `${focalX * 100}%`, top: `${focalY * 100}%` }}
            >
              <div className="w-full h-full rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 shadow-lg" />
            </div>
          )}
          {/* Proxy badge */}
          {!usingProxy && (
            <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/60 rounded text-[#a3a3a3] text-xs">
              proxy pending
            </div>
          )}
        </div>

        {/* Clip info */}
        <div className="flex items-center justify-between w-full">
          <div>
            <p className="text-[#e5e5e5] text-sm font-medium truncate max-w-xs" title={clip.filename}>
              {clip.filename}
            </p>
            <p className="text-[#a3a3a3] text-xs mt-0.5">
              {fmtMs(clip.duration_ms)} &middot; {clip.width}x{clip.height}
            </p>
          </div>
          {/* Focal point reset */}
          <button
            onClick={() => { setFocalX(null); setFocalY(null); }}
            className="text-xs text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors px-2 py-1 rounded border border-white/10 hover:border-white/25"
          >
            Centre focal point
          </button>
        </div>

        {/* Quick controls: Include / Skip */}
        <div className="flex items-center gap-4 w-full justify-center">
          <button
            onClick={() => saveAndAdvance(0)}
            className="flex-1 max-w-[180px] px-5 py-3 border border-white/25 text-[#e5e5e5] font-semibold rounded-md hover:bg-white/5 transition-colors text-base"
          >
            Skip
            <span className="ml-2 text-xs text-[#555555] font-normal">Space</span>
          </button>
          <button
            onClick={() => saveAndAdvance(1)}
            className="flex-1 max-w-[180px] px-5 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors text-base"
          >
            Include
            <span className="ml-2 text-xs text-[#0a0a0a]/60 font-normal">Enter</span>
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
                {/* IN point */}
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
                {/* OUT point */}
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

        {/* "Continue to Editor" shortcut once all clips reviewed */}
        {currentIndex === total - 1 && (
          <button
            onClick={() => saveAndAdvance(1)}
            className="px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors"
          >
            Include &amp; Continue to Editor &#8594;
          </button>
        )}
      </div>
    </div>
  );
}
