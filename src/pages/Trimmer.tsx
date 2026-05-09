import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Clip, ProjectWithClips } from "@/types/project";
import { MediaPantry } from "@/components/trimmer/MediaPantry";
import { TrimBar } from "@/components/trimmer/TrimBar";
import { StickyFilmStrip } from "@/components/StickyFilmStrip";
import { EditorShell } from "@/components/EditorShell";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";

export default function Trimmer() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const _cached = projectCache.get(projectId ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [loading, setLoading] = useState(!_cached);
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const _firstSource = _cached?.clips.find(c => c.include === 0) ?? null;
  const [selectedClip, setSelectedClip] = useState<Clip | null>(_firstSource);
  const [inMs, setInMs] = useState(_firstSource?.in_ms ?? 0);
  const [outMs, setOutMs] = useState(_firstSource?.out_ms ?? _firstSource?.duration_ms ?? 0);
  const [currentMs, setCurrentMs] = useState(_firstSource?.in_ms ?? 0);
  const [filmActiveId, setFilmActiveId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [videoCanPlay, setVideoCanPlay] = useState(false);
  const [sourceFailed, setSourceFailed] = useState(false);
  const lastPaintedProxy = useRef<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const isSaving = useRef(false);
  const generatingProxyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        projectCache.set(projectId, { name: data.project.name, clips: data.clips });
        setClips(data.clips);
        setProjectName(data.project.name);
        const firstSource = data.clips.find(c => c.include === 0);
        if (firstSource) {
          setSelectedClip(firstSource);
          setInMs(firstSource.in_ms ?? 0);
          setOutMs(firstSource.out_ms ?? firstSource.duration_ms);
          setCurrentMs(firstSource.in_ms ?? 0);
        }
        const anyWork = data.clips.some((c) => !c.thumbnail_data || !c.waveform_data);
        if (anyWork) {
          invoke("generate_proxies_cmd", { projectId }).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; thumbnailData: string }>(
      "thumbnail-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        setClips((prev) =>
          prev.map((c) =>
            c.id === ev.payload.clipId ? { ...c, thumbnail_data: ev.payload.thumbnailData } : c
          )
        );
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; waveformData: string }>(
      "waveform-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        setClips((prev) =>
          prev.map((c) =>
            c.id === ev.payload.clipId ? { ...c, waveform_data: ev.payload.waveformData } : c
          )
        );
        setSelectedClip((prev) =>
          prev && prev.id === ev.payload.clipId
            ? { ...prev, waveform_data: ev.payload.waveformData }
            : prev
        );
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

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
          setSourceFailed(false);
          return { ...prev, proxy_path: winPath };
        });
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !selectedClip) return;
    const currentSrc = selectedClip.proxy_path ?? selectedClip.local_path;
    const isNewSrc = lastPaintedProxy.current !== currentSrc;
    lastPaintedProxy.current = currentSrc;

    function paintAndPlay() {
      if (!v) return;
      const target = inMs / 1000;
      v.currentTime = target > 0 ? target : 0.05;
      // Always show first frame without autoplaying (WebView2 requires play/pause to repaint)
      v.play().then(() => { v.pause(); setIsPlaying(false); v.currentTime = inMs / 1000; }).catch(() => { v.currentTime = inMs / 1000; });
    }

    if (v.readyState >= 2) {
      paintAndPlay();
    } else {
      v.addEventListener("loadeddata", paintAndPlay, { once: true });
      return () => v.removeEventListener("loadeddata", paintAndPlay);
    }
  }, [selectedClip?.id, selectedClip?.proxy_path]); // eslint-disable-line react-hooks/exhaustive-deps

  const clip = selectedClip;

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

  async function handlePantrySelect(newClip: Clip) {
    if (newClip.id === clip?.id) return;
    await saveCurrentClip();
    setSelectedClip(newClip);
    setInMs(newClip.in_ms ?? 0);
    setOutMs(newClip.out_ms ?? newClip.duration_ms);
    setCurrentMs(newClip.in_ms ?? 0);
    setFilmActiveId(null);
    setIsPlaying(false);
    setVideoCanPlay(false);
    setSourceFailed(false);
    generatingProxyRef.current.delete(newClip.id);
  }

  async function handleNav(dir: -1 | 1) {
    if (!clip) return;
    const sourceClips = clips.filter(c => c.include === 0);
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
    setCurrentMs(next.in_ms ?? 0);
    setFilmActiveId(null);
    setIsPlaying(false);
    setVideoCanPlay(false);
    setSourceFailed(false);
    generatingProxyRef.current.delete(next.id);
  }

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

  async function handleDeleteCut(cutClip: Clip) {
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

  async function handleFilmSelect(filmClip: Clip) {
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
    setInMs(filmClip.in_ms ?? 0);
    setOutMs(filmClip.out_ms ?? filmClip.duration_ms);
    setCurrentMs(filmClip.in_ms ?? 0);
    setFilmActiveId(filmClip.id);
    if (videoRef.current) videoRef.current.currentTime = (filmClip.in_ms ?? 0) / 1000;
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
    setVideoHeight(Math.max(200, Math.min(maxH, resizeDragRef.current.startH + delta)));
  }

  function onResizePointerUp() {
    resizeDragRef.current = null;
  }

  const sourceClips = clips.filter(c => c.include === 0);
  const inFilm = clips.filter((c) => c.include === 1);
  const inFilmCount = inFilm.length;
  const totalMs = inFilm.reduce((sum, c) => sum + Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0)), 0);
  const configured = useConfiguredTabs(projectId ?? "");
  const transitionVal = (() => { try { return sessionStorage.getItem(`rc_transition_${projectId}`) ?? null; } catch { return null; } })();
  const soundMoodVal = (() => { try { const raw = sessionStorage.getItem(`rc_sound_${projectId}`); return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null; } catch { return null; } })();

  const cutPaths = new Set(clips.filter(c => c.include === 1).map(c => c.local_path));
  const pantryClips = sourceClips.map(c => ({
    ...c,
    include: cutPaths.has(c.local_path) ? 1 : 0,
  })) as Clip[];

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

  const clipControls = (
    <div className="flex flex-col items-center gap-4">
      <p className="text-[10px] text-[#e5e5e5]">{sourceIdx + 1} / {sourceClips.length}</p>
      <div className="flex gap-1.5 w-full">
        <button
          onClick={() => handleNav(-1)}
          disabled={!canGoPrev}
          className="flex-1 py-2 border border-white/30 rounded-md text-xs text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
        >
          &#8592; Prev
        </button>
        <button
          onClick={() => handleNav(1)}
          disabled={!canGoNext}
          className="flex-1 py-2 border border-white/30 rounded-md text-xs text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
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
      <p className="text-[10px] text-[#e5e5e5] text-center leading-tight">
        {inFilmCount === 0 ? "No clips added yet" : `${inFilmCount} clip${inFilmCount !== 1 ? "s" : ""} in film`}
      </p>
      {filmActiveId && (
        <button
          onClick={() => {
            const cut = clips.find(c => c.id === filmActiveId);
            if (cut) { handleDeleteCut(cut); setFilmActiveId(null); }
          }}
          className="w-full py-2 border border-red-500/40 text-red-400 text-xs rounded-md hover:border-red-500/70 hover:bg-red-500/10 transition-colors"
        >
          Remove from film
        </button>
      )}
    </div>
  );

  return (
    <EditorShell
      projectId={projectId!}
      projectName={projectName}
      clipCount={inFilmCount}
      totalMs={totalMs}
      activeTab="trim"
      configured={configured}
      leftPanel={
        <MediaPantry
          clips={pantryClips}
          selectedId={clip.include === 0 ? clip.id : sourceClips.find(sc => sc.local_path === clip.local_path)?.id ?? null}
          onSelect={handlePantrySelect}
        />
      }
      transitionValue={transitionVal}
      soundMood={soundMoodVal}
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
          activeId={filmActiveId}
          onDeleteClip={(clipId) => {
            const cut = clips.find(c => c.id === clipId);
            if (cut) { handleDeleteCut(cut); if (filmActiveId === clipId) setFilmActiveId(null); }
          }}
        />
      }
    >
      {/* Center content: video area (flex-1) + clip controls column */}
      <div className="flex flex-1 min-w-0 h-full overflow-hidden">
        {/* Video + TrimBar */}
        <div className="flex flex-col flex-1 min-w-0 gap-3 px-4 py-3 overflow-hidden">
          <div
            ref={videoContainerRef}
            className="w-full rounded-xl overflow-hidden bg-black relative flex-1 min-h-0"
            style={videoHeight != null ? { flex: "none", height: videoHeight } : {}}
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
                if (isPlaying && ms >= outMs) {
                  (e.currentTarget as HTMLVideoElement).currentTime = inMs / 1000;
                }
              }}
              onSeeked={(e) => setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000))}
              onCanPlay={() => setVideoCanPlay(true)}
              onError={() => {
                setSourceFailed(true);
                setVideoCanPlay(false);
                if (!clip.proxy_path && !generatingProxyRef.current.has(clip.id)) {
                  generatingProxyRef.current.add(clip.id);
                  invoke("generate_proxy_for_clip", { projectId, clipId: clip.id }).catch(() => {});
                }
              }}
            />
            {sourceFailed && clip.thumbnail_data && (
              <img src={clip.thumbnail_data} alt="" className="absolute inset-0 w-full h-full object-contain" />
            )}
            {sourceFailed && !clip.proxy_path && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-black/70 px-2.5 py-1.5 rounded-md pointer-events-none">
                <span className="w-3 h-3 border border-[#FF8A65] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-[10px] text-[#e5e5e5]/80 leading-none">Generating video...</span>
              </div>
            )}
          </div>

          <div
            className="w-full h-2 flex items-center justify-center cursor-ns-resize group flex-shrink-0"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
          >
            <div className="w-8 h-0.5 rounded-full bg-white/20 group-hover:bg-white/50 transition-colors" />
          </div>

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
            <span className="text-[10px] text-[#e5e5e5] ml-2 truncate">
              {clip.filename} &middot; {clip.width}x{clip.height}
            </span>
          </div>

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
        </div>

        {/* Prev / Next / Add to Film — right column (w-48 matches effects panel width) */}
        <div className="w-48 flex-shrink-0 flex flex-col items-center justify-center gap-4 px-3 py-4 border-l border-white/10">
          {clipControls}
        </div>
      </div>

      {/* Toast — duplicate cut guard (above bottom tab bar) */}
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-[#1a1a1a] border border-white/15 border-l-2 border-l-[#FF8A65] rounded-md shadow-lg pointer-events-none">
          <p className="text-sm text-[#e5e5e5] whitespace-nowrap">{toast}</p>
        </div>
      )}
    </EditorShell>
  );
}
