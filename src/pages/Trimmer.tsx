import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Clip, ProjectWithClips } from "@/types/project";
import { StepNav } from "@/components/StepNav";
import { MediaPantry } from "@/components/trimmer/MediaPantry";
import { TrimBar } from "@/components/trimmer/TrimBar";
import { FilmStrip } from "@/components/trimmer/FilmStrip";

export default function Trimmer() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [inMs, setInMs] = useState(0);
  const [outMs, setOutMs] = useState(0);
  const [currentMs, setCurrentMs] = useState(0); // A8: playback position for TrimBar playhead
  const [filmActiveId, setFilmActiveId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  // True once the video element fires onCanPlay (browser confirmed it can play the current src).
  // Resets on clip change. Used to enable/disable the play button and hide the proxy badge.
  // No videoWidth guard here -- onCanPlay is sufficient; the videoWidth > 0 guard was too strict
  // and prevented enabling play even when HEVC decoded successfully with the HEVC extension.
  const [videoCanPlay, setVideoCanPlay] = useState(false);
  // True when the video element fires onError (e.g. HEVC not decodable without Video Extension,
  // or corrupt partial proxy). Hides the video element and shows the thumbnail img fallback.
  // Resets to false on clip change so a freshly-generated proxy can load cleanly.
  const [sourceFailed, setSourceFailed] = useState(false);
  // Tracks the proxy_path that was loaded last time paintFrame ran, to detect new proxy arrivals.
  const lastPaintedProxy = useRef<string | null>(null);
  // Toast for duplicate-cut guard
  const [toast, setToast] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  // C6: user-resizable video preview height (min 200px, max 70vh)
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  // isSaving guard — early-return if already saving to prevent double-save
  const isSaving = useRef(false);
  // Tracks clip IDs for which lazy proxy gen has already been triggered.
  // Prevents re-triggering onError if proxy encode fails silently and proxy_path is never set.
  const generatingProxyRef = useRef<Set<string>>(new Set());

  // Load project and kick off upfront media batch (thumbnail + waveform for all clips).
  // Proxy gen is now lazy — triggered per-clip by onError when WebView2 can't decode the source.
  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
        // Select the first source row (include=0) as the initial clip
        const firstSource = data.clips.find(c => c.include === 0);
        if (firstSource) {
          setSelectedClip(firstSource);
          setInMs(firstSource.in_ms ?? 0);
          setOutMs(firstSource.out_ms ?? firstSource.duration_ms);
          setCurrentMs(firstSource.in_ms ?? 0); // A8: init playhead to IN point
        }
        // Kick off thumbnail + waveform generation for clips that need it.
        // Thumbnail/waveform events are picked up by their listeners below.
        const anyWork = data.clips.some((c) => !c.thumbnail_data || !c.waveform_data);
        if (anyWork) {
          invoke("generate_proxies_cmd", { projectId }).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  // Listen for thumbnail-progress events — update clip thumbnail_data in state incrementally
  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; thumbnailData: string }>(
      "thumbnail-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        setClips((prev) =>
          prev.map((c) =>
            c.id === ev.payload.clipId
              ? { ...c, thumbnail_data: ev.payload.thumbnailData }
              : c
          )
        );
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  // Listen for waveform-progress events — update clip waveform_data in state incrementally
  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; waveformData: string }>(
      "waveform-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        setClips((prev) =>
          prev.map((c) =>
            c.id === ev.payload.clipId
              ? { ...c, waveform_data: ev.payload.waveformData }
              : c
          )
        );
        // Also update selectedClip so TrimBar sees the waveform immediately
        setSelectedClip((prev) =>
          prev && prev.id === ev.payload.clipId
            ? { ...prev, waveform_data: ev.payload.waveformData }
            : prev
        );
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  // Listen for proxy-progress events — update clip proxy_path in state and clear sourceFailed
  // so the video element picks up the newly available proxy src.
  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; winPath: string }>(
      "proxy-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        const { clipId, winPath } = ev.payload;
        setClips((prev) =>
          prev.map((c) => c.id === clipId ? { ...c, proxy_path: winPath } : c)
        );
        setSelectedClip((prev) => {
          if (!prev || prev.id !== clipId) return prev;
          // Proxy is ready — unhide the video element so it can load the proxy src.
          setSourceFailed(false);
          return { ...prev, proxy_path: winPath };
        });
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  // Sync volume to video element
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // Paint the first frame on clip change or when a proxy arrives.
  // Fires for both native source (proxy_path null) and proxy-fallback playback.
  // Auto-plays when a new proxy arrives (user was waiting) vs stay-paused on clip nav.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !selectedClip) return;

    // Track whether the video source is new (drives auto-play vs paint-and-pause decision)
    const currentSrc = selectedClip.proxy_path ?? selectedClip.local_path;
    const isNewSrc = lastPaintedProxy.current !== currentSrc;
    lastPaintedProxy.current = currentSrc;

    function paintAndPlay() {
      if (!v) return;
      const target = inMs / 1000;
      v.currentTime = target > 0 ? target : 0.05; // avoid exact 0 -- some proxies paint black at PTS 0
      if (isNewSrc) {
        // New source (proxy just arrived, or first clip load) — auto-play.
        v.play()
          .then(() => setIsPlaying(true))
          .catch(() => {
            // Autoplay blocked — at least seek to IN point so poster is replaced.
            v.currentTime = inMs / 1000;
          });
      } else {
        // Clip navigation with existing src — paint first frame, stay paused.
        v.play()
          .then(() => { v.pause(); v.currentTime = inMs / 1000; })
          .catch(() => { v.currentTime = inMs / 1000; });
      }
    }

    if (v.readyState >= 2) {
      paintAndPlay();
    } else {
      v.addEventListener("loadeddata", paintAndPlay, { once: true });
      return () => v.removeEventListener("loadeddata", paintAndPlay);
    }
  }, [selectedClip?.id, selectedClip?.proxy_path]); // eslint-disable-line react-hooks/exhaustive-deps

  const clip = selectedClip;

  /**
   * Save the current clip's trim points without advancing.
   * Guards with isSaving ref to prevent double-save on pointerup + blur/unmount.
   * NOTE: focal_x/focal_y/zoom_mode intentionally null — Trimmer does not set them.
   */
  const saveCurrentClip = useCallback(async () => {
    if (!clip || !projectId || isSaving.current) return;
    isSaving.current = true;
    try {
      console.log("[trimmer] save clip", clip.id, { inMs, outMs, include: clip.include });
      await invoke("update_clip_review_cmd", {
        clipId: clip.id,
        inMs: inMs > 0 ? inMs : null,
        outMs: outMs < clip.duration_ms ? outMs : null,
        focalX: null,
        focalY: null,
        zoomMode: null,
        include: clip.include,
      });
      setClips((prev) =>
        prev.map((c) =>
          c.id === clip.id
            ? { ...c, in_ms: inMs > 0 ? inMs : null, out_ms: outMs < clip.duration_ms ? outMs : null }
            : c
        )
      );
    } finally {
      isSaving.current = false;
    }
  }, [clip, projectId, inMs, outMs]);

  /** Select a clip from MediaPantry — save current first. */
  async function handlePantrySelect(newClip: Clip) {
    if (newClip.id === clip?.id) return;
    await saveCurrentClip();
    setSelectedClip(newClip);
    setInMs(newClip.in_ms ?? 0);
    setOutMs(newClip.out_ms ?? newClip.duration_ms);
    setCurrentMs(newClip.in_ms ?? 0); // A8: reset playhead to new clip's IN point
    setFilmActiveId(null);
    setIsPlaying(false);
    setVideoCanPlay(false); // reset: new clip's video element has not confirmed canplay yet
    setSourceFailed(false); // reset: allow source to try loading for the new clip
    // Reset proxy gen guard so the new clip can trigger lazy gen if needed
    generatingProxyRef.current.delete(newClip.id);
  }

  /** Prev/Next nav — navigates source rows (include=0) only. */
  async function handleNav(dir: -1 | 1) {
    if (!clip) return;
    const sourceClips = clips.filter(c => c.include === 0);
    // If current clip is a cut row, find the matching source row by local_path
    const effectiveId = clip.include === 0 ? clip.id
      : sourceClips.find(sc => sc.local_path === clip.local_path)?.id;
    const idx = sourceClips.findIndex((c) => c.id === effectiveId);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= sourceClips.length) return;
    await saveCurrentClip();
    const next = sourceClips[nextIdx];
    setSelectedClip(next);
    setInMs(next.in_ms ?? 0);
    setOutMs(next.out_ms ?? next.duration_ms);
    setCurrentMs(next.in_ms ?? 0); // A8: reset playhead on nav
    setFilmActiveId(null);
    setIsPlaying(false);
    setVideoCanPlay(false); // reset: new clip's video element has not confirmed canplay yet
    setSourceFailed(false); // reset: allow source to try loading for the new clip
    // Reset proxy gen guard so the new clip can trigger lazy gen if needed
    generatingProxyRef.current.delete(next.id);
  }

  /**
   * Add a cut for the given clip with the specified handles.
   * Creates a new include=1 row via add_clip_cut_cmd.
   * Duplicate guard: if identical local_path + handles already exist in filmstrip, shows a toast.
   */
  async function handleAddCutForClip(targetClip: Clip, cutInMs: number, cutOutMs: number) {
    const isDuplicate = clips.some(
      c =>
        c.include === 1 &&
        c.local_path === targetClip.local_path &&
        (c.in_ms ?? 0) === cutInMs &&
        (c.out_ms ?? c.duration_ms) === cutOutMs
    );
    if (isDuplicate) {
      setToast("Already added — adjust handles to add a different cut");
      setTimeout(() => setToast(null), 2500);
      return;
    }

    // Find the source row's id for metadata cloning (add_clip_cut_cmd reads from DB by id)
    const sourceRow = clips.find(c => c.include === 0 && c.local_path === targetClip.local_path);
    const sourceId = sourceRow?.id ?? targetClip.id;

    try {
      const newCut = await invoke<Clip>("add_clip_cut_cmd", {
        projectId,
        sourceClipId: sourceId,
        inMs: cutInMs > 0 ? cutInMs : null,
        outMs: cutOutMs < targetClip.duration_ms ? cutOutMs : null,
      });
      setClips(prev => [...prev, newCut]);
    } catch (err) {
      console.error("[trimmer] add cut failed", err);
    }
  }

  /** Remove a cut row from the filmstrip by deleting it from DB. */
  async function handleDeleteCut(cutClip: Clip) {
    // Optimistic remove
    setClips(prev => prev.filter(c => c.id !== cutClip.id));
    try {
      await invoke("delete_clip_cmd", { clipId: cutClip.id });
    } catch (err) {
      console.error("[trimmer] delete cut failed, rolling back", err);
      setClips(prev => [...prev, cutClip]);
    }
  }

  function handleInChange(ms: number) {
    setInMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  }

  function handleOutChange(ms: number) {
    setOutMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
  }

  function handleSeek(ms: number) {
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
    setCurrentMs(ms);
  }

  /** Film strip clip click — load source row in player with this cut's handles. */
  async function handleFilmSelect(filmClip: Clip) {
    // Always load the source row in the player (not the cut row itself)
    const sourceRow = clips.find(c => c.include === 0 && c.local_path === filmClip.local_path);
    const workClip = sourceRow ?? filmClip;
    if (workClip.id !== clip?.id) {
      await saveCurrentClip();
      setSelectedClip(workClip);
      setIsPlaying(false);
      setVideoCanPlay(false);
      setSourceFailed(false);
      generatingProxyRef.current.delete(workClip.id);
    }
    // Show this cut's trim handles in the player
    setInMs(filmClip.in_ms ?? 0);
    setOutMs(filmClip.out_ms ?? filmClip.duration_ms);
    setCurrentMs(filmClip.in_ms ?? 0);
    setFilmActiveId(filmClip.id);
    if (videoRef.current) {
      videoRef.current.currentTime = (filmClip.in_ms ?? 0) / 1000;
    }
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.readyState === 0) v.load();
      v.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      v.pause();
      setIsPlaying(false);
    }
  }

  // C6: drag to resize video preview height
  function onResizePointerDown(e: React.PointerEvent) {
    const el = videoContainerRef.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = { startY: e.clientY, startH: el.getBoundingClientRect().height };
  }

  function onResizePointerMove(e: React.PointerEvent) {
    if (!resizeDragRef.current) return;
    const delta = e.clientY - resizeDragRef.current.startY;
    const maxH = window.innerHeight * 0.7;
    const next = Math.max(200, Math.min(maxH, resizeDragRef.current.startH + delta));
    setVideoHeight(next);
  }

  function onResizePointerUp() {
    resizeDragRef.current = null;
  }

  // Source rows only — used for MediaPantry, Prev/Next nav, and clip counter
  const sourceClips = clips.filter(c => c.include === 0);
  const inFilmCount = clips.filter((c) => c.include === 1).length;

  // Compute pantry clips: source rows with include overridden to 1 if any cut exists for that path
  const cutPaths = new Set(clips.filter(c => c.include === 1).map(c => c.local_path));
  const pantryClips = sourceClips.map(c => ({
    ...c,
    include: cutPaths.has(c.local_path) ? 1 : 0,
  })) as Clip[];

  // Clip index within source rows (for Prev/Next counter display)
  const sourceIdx = clip
    ? (clip.include === 0
        ? sourceClips.findIndex(c => c.id === clip.id)
        : sourceClips.findIndex(c => c.local_path === clip.local_path))
    : -1;
  const canGoPrev = sourceIdx > 0;
  const canGoNext = sourceIdx < sourceClips.length - 1;

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
          <p className="text-[#e5e5e5]/60">No clips found.</p>
          <button
            onClick={() => navigate("/upload")}
            className="px-5 py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-colors"
          >
            Back to Upload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5] overflow-hidden">
      {/* Step nav — replaces header, accounts for fixed AppShell NavDrawer at top-left */}
      <StepNav
        active="trimmer"
        projectId={projectId}
        nextLabel="Next: Transitions"
        onNext={() => navigate(`/transitions/${projectId}`)}
        nextDisabled={inFilmCount === 0}
      />

      {/* Project name row */}
      <div className="flex items-center px-4 py-1.5 border-b border-white/8 bg-[#0a0a0a]">
        <span className="text-[#e5e5e5]/60 text-xs truncate max-w-[300px]">{projectName}</span>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left — Media Pantry (source rows only) */}
        <aside className="w-52 flex-shrink-0 border-r border-white/10 overflow-hidden">
          <MediaPantry
            clips={pantryClips}
            selectedId={clip.include === 0 ? clip.id : sourceClips.find(sc => sc.local_path === clip.local_path)?.id ?? null}
            onSelect={handlePantrySelect}
          />
        </aside>

        {/* Centre — Video player + controls + TrimBar */}
        <main className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-3 overflow-hidden min-w-0">

          {/* Video — always rendered.
               Proxy path = source path for H.264 clips (WebView2 native decode, instant play).
               Proxy path = transcoded 480p H.264 for HEVC clips (set when proxy.py finishes).
               poster = thumbnail so the user always sees a still frame while waiting.
               onCanPlay fires when browser can play the src -- enables the play button.
               loop removed (A2): onTimeUpdate guard handles looping within IN/OUT selection. */}
          <div
            ref={videoContainerRef}
            className="w-full rounded-xl overflow-hidden bg-black relative flex-shrink-0"
            style={videoHeight != null ? { height: videoHeight } : { aspectRatio: "16/9", maxHeight: "calc(100vh - 320px)" }}
          >
            <video
              ref={videoRef}
              key={clip.id}
              src={clip.proxy_path ? convertFileSrc(clip.proxy_path) : convertFileSrc(clip.local_path)}
              poster={clip.thumbnail_data ?? undefined}
              preload="auto"
              playsInline
              style={{ display: sourceFailed ? "none" : undefined }}
              className="w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onTimeUpdate={(e) => {
                const ms = Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000);
                setCurrentMs(ms);
                // A2: loop within IN/OUT selection — seek back to inMs when playback crosses outMs
                if (isPlaying && ms >= outMs) {
                  (e.currentTarget as HTMLVideoElement).currentTime = inMs / 1000;
                }
              }}
              onSeeked={(e) => setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000))}
              onCanPlay={() => setVideoCanPlay(true)}
              onError={() => {
                // Source decode failed (HEVC without Video Extension, or unknown codec).
                // Hide the broken video icon, show thumbnail fallback, trigger lazy proxy gen.
                setSourceFailed(true);
                setVideoCanPlay(false);
                // Guard: only trigger once per clip — prevent re-fire if proxy gen fails silently
                if (!clip.proxy_path && !generatingProxyRef.current.has(clip.id)) {
                  generatingProxyRef.current.add(clip.id);
                  invoke("generate_proxy_for_clip", { projectId, clipId: clip.id }).catch(() => {});
                }
              }}
            />
            {/* Thumbnail fallback — shown when video decode fails (HEVC without extension etc.) */}
            {sourceFailed && clip.thumbnail_data && (
              <img
                src={clip.thumbnail_data}
                alt=""
                className="absolute inset-0 w-full h-full object-contain"
              />
            )}
            {/* Generating preview badge — only when source failed decode AND no proxy yet */}
            {sourceFailed && !clip.proxy_path && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-black/70 px-2.5 py-1.5 rounded-md pointer-events-none">
                <span className="w-3 h-3 border border-[#FF8A65] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-[10px] text-[#e5e5e5]/80 leading-none">Generating video...</span>
              </div>
            )}
          </div>

          {/* C6: drag handle to resize video preview height */}
          <div
            className="w-full h-2 flex items-center justify-center cursor-ns-resize group flex-shrink-0"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
          >
            <div className="w-8 h-0.5 rounded-full bg-white/20 group-hover:bg-white/50 transition-colors" />
          </div>

          {/* Play/pause + volume row */}
          <div className="flex items-center gap-3 w-full">
            <button
              onClick={togglePlay}
              disabled={!videoCanPlay}
              title={!videoCanPlay ? "Generating video preview, please wait..." : undefined}
              className="w-8 h-8 rounded-full border border-white/20 flex items-center justify-center hover:border-white/40 transition-colors flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isPlaying ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" />
                  <rect x="14" y="4" width="4" height="16" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <input
              type="range" min={0} max={1} step={0.05} value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-20 accent-[#FF8A65]"
              title="Volume"
            />
            <span className="text-[10px] text-[#e5e5e5]/30 ml-2 truncate">
              {clip.filename} &middot; {clip.width}x{clip.height}
            </span>
          </div>

          {/* Trim bar — A8: pass currentMs for playhead; C7: pass waveformData */}
          <div className="w-full">
            <TrimBar
              durationMs={clip.duration_ms}
              inMs={inMs}
              outMs={outMs}
              currentMs={currentMs}
              waveformData={selectedClip?.waveform_data}
              onInChange={handleInChange}
              onOutChange={handleOutChange}
              onCommit={saveCurrentClip}
              onSeek={handleSeek}
            />
          </div>
        </main>

        {/* Right — Nav + Add to film CTA */}
        <aside className="w-44 flex-shrink-0 border-l border-white/10 flex flex-col items-center justify-center gap-4 px-4 py-6 overflow-y-auto">
          <p className="text-[10px] text-[#e5e5e5]/30">
            {sourceIdx + 1} / {sourceClips.length}
          </p>

          <div className="flex gap-1.5 w-full">
            <button
              onClick={() => handleNav(-1)}
              disabled={!canGoPrev}
              className="flex-1 py-2 border border-white/20 rounded-md text-xs text-[#e5e5e5]/60 hover:border-white/40 hover:text-[#e5e5e5] transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
            >
              &#8592; Prev
            </button>
            <button
              onClick={() => handleNav(1)}
              disabled={!canGoNext}
              className="flex-1 py-2 border border-white/20 rounded-md text-xs text-[#e5e5e5]/60 hover:border-white/40 hover:text-[#e5e5e5] transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
            >
              Next &#8594;
            </button>
          </div>

          <button
            data-testid="btn-add-to-film"
            onClick={() => {
              const sourceRow = clips.find(c => c.include === 0 && c.local_path === clip.local_path);
              handleAddCutForClip(sourceRow ?? clip, inMs, outMs);
            }}
            className="w-full py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md text-sm hover:bg-[#ff9e7a] transition-colors"
          >
            + Add to Film
          </button>

          <p className="text-[10px] text-[#e5e5e5]/30 text-center leading-tight">
            {inFilmCount === 0
              ? "No clips added yet"
              : `${inFilmCount} clip${inFilmCount !== 1 ? "s" : ""} in film`}
          </p>
        </aside>
      </div>

      {/* Bottom — Film So Far strip */}
      <div
        className="flex-shrink-0 border-t border-white/10 bg-[#0a0a0a]"
        style={{ height: 100 }}
      >
        <FilmStrip
          clips={clips}
          activeId={filmActiveId}
          onSelect={handleFilmSelect}
          onRemove={handleDeleteCut}
          onAdd={(c) => {
            // Drag-from-pantry: use current handles if it's the selected clip,
            // else use the source row's stored handles (null = full clip)
            const cutIn = c.id === clip?.id ? inMs : (c.in_ms ?? 0);
            const cutOut = c.id === clip?.id ? outMs : (c.out_ms ?? c.duration_ms);
            handleAddCutForClip(c, cutIn, cutOut);
          }}
        />
      </div>

      {/* Toast — duplicate cut guard */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-[#1a1a1a] border border-white/15 border-l-2 border-l-[#FF8A65] rounded-md shadow-lg pointer-events-none">
          <p className="text-sm text-[#e5e5e5] whitespace-nowrap">{toast}</p>
        </div>
      )}
    </div>
  );
}
