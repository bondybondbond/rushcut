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

  const videoRef = useRef<HTMLVideoElement>(null);
  // isSaving guard — early-return if already saving to prevent double-save
  const isSaving = useRef(false);
  const proxyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load project and trigger proxy generation for smooth scrubbing
  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setClips(data.clips);
        setProjectName(data.project.name);
        if (data.clips.length > 0) {
          const first = data.clips[0];
          setSelectedClip(first);
          setInMs(first.in_ms ?? 0);
          setOutMs(first.out_ms ?? first.duration_ms);
          setCurrentMs(first.in_ms ?? 0); // A8: init playhead to IN point
        }
        // Kick off proxy/thumbnail/waveform generation for all clips that need any of them
        const anyWork = data.clips.some((c) => !c.proxy_path || !c.thumbnail_data || !c.waveform_data);
        if (anyWork) {
          invoke("generate_proxies_cmd", { projectId }).catch(() => {});
          // Poll every 4s to pick up proxy_path as WSL generates them
          proxyPollRef.current = setInterval(() => {
            invoke<ProjectWithClips>("get_project", { projectId })
              .then((refreshed) => {
                setClips((prev) =>
                  prev.map((c) => {
                    const updated = refreshed.clips.find((r) => r.id === c.id);
                    return updated ?? c;
                  })
                );
                // Also update selectedClip's proxy_path
                setSelectedClip((prev) => {
                  if (!prev) return prev;
                  const updated = refreshed.clips.find((r) => r.id === prev.id);
                  return updated ? { ...prev, proxy_path: updated.proxy_path } : prev;
                });
                // Stop polling when all proxies are generated
                const allReady = refreshed.clips.every((c) => c.proxy_path);
                if (allReady) {
                  if (proxyPollRef.current) clearInterval(proxyPollRef.current);
                }
              })
              .catch(() => {});
          }, 4000);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    return () => {
      if (proxyPollRef.current) clearInterval(proxyPollRef.current);
    };
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

  // Sync volume to video element
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // Paint the first frame whenever clip or proxy changes.
  // WebView2 renders black if currentTime stays at 0 on a paused video.
  // Fix: play() forces a decode + paint; we pause immediately after.
  // Waits for loadeddata if the video hasn't buffered yet (readyState < 2).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !selectedClip?.proxy_path) return;

    function paintFrame() {
      if (!v) return;
      const target = inMs / 1000;
      v.currentTime = target > 0 ? target : 0.05; // avoid exact 0 — some H.264 proxies paint black at PTS 0
      v.play()
        .then(() => { v.pause(); v.currentTime = inMs / 1000; })
        .catch(() => { v.currentTime = inMs / 1000; }); // autoplay blocked — seek is best-effort
    }

    if (v.readyState >= 2) {
      paintFrame();
    } else {
      v.addEventListener("loadeddata", paintFrame, { once: true });
      return () => v.removeEventListener("loadeddata", paintFrame);
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
  }

  /** Prev/Next nav — save current first. */
  async function handleNav(dir: -1 | 1) {
    if (!clip) return;
    const idx = clips.findIndex((c) => c.id === clip.id);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= clips.length) return;
    await saveCurrentClip();
    const next = clips[nextIdx];
    setSelectedClip(next);
    setInMs(next.in_ms ?? 0);
    setOutMs(next.out_ms ?? next.duration_ms);
    setCurrentMs(next.in_ms ?? 0); // A8: reset playhead on nav
    setFilmActiveId(null);
    setIsPlaying(false);
  }

  /** Toggle include with optimistic update + DB save + rollback on error. */
  async function handleToggleInclude(targetClip: Clip, include: 0 | 1) {
    if (isSaving.current) return;
    isSaving.current = true;
    const currentInMs = targetClip.id === clip?.id ? inMs : (targetClip.in_ms ?? 0);
    const currentOutMs = targetClip.id === clip?.id ? outMs : (targetClip.out_ms ?? targetClip.duration_ms);
    setClips((prev) => prev.map((c) => (c.id === targetClip.id ? { ...c, include } : c)));
    if (selectedClip?.id === targetClip.id) {
      setSelectedClip((prev) => (prev ? { ...prev, include } : null));
    }
    try {
      await invoke("update_clip_review_cmd", {
        clipId: targetClip.id,
        inMs: currentInMs > 0 ? currentInMs : null,
        outMs: currentOutMs < targetClip.duration_ms ? currentOutMs : null,
        focalX: null,
        focalY: null,
        zoomMode: null,
        include,
      });
    } catch (err) {
      console.error("[trimmer] toggle include failed, rolling back", err);
      setClips((prev) => prev.map((c) => (c.id === targetClip.id ? { ...c, include: targetClip.include } : c)));
      if (selectedClip?.id === targetClip.id) {
        setSelectedClip((prev) => (prev ? { ...prev, include: targetClip.include } : null));
      }
    } finally {
      isSaving.current = false;
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

  /** Film strip clip click — seek centre player to that clip's in point. */
  async function handleFilmSelect(filmClip: Clip) {
    if (filmClip.id !== clip?.id) {
      await handlePantrySelect(filmClip);
    }
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

  const inFilmCount = clips.filter((c) => c.include === 1).length;
  const clipIdx = clip ? clips.findIndex((c) => c.id === clip.id) : -1;
  const canGoPrev = clipIdx > 0;
  const canGoNext = clipIdx < clips.length - 1;

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

  const clipInFilm = clip.include === 1;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5] overflow-hidden">
      {/* Step nav — replaces header, accounts for fixed AppShell NavDrawer at top-left */}
      <StepNav
        active="trimmer"
        projectId={projectId}
        nextLabel="Next: Transitions"
        onNext={() => navigate(`/editor/${projectId}`)}
        nextDisabled={inFilmCount === 0}
      />

      {/* Project name row */}
      <div className="flex items-center px-4 py-1.5 border-b border-white/8 bg-[#0a0a0a]">
        <span className="text-[#e5e5e5]/60 text-xs truncate max-w-[300px]">{projectName}</span>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left — Media Pantry */}
        <aside className="w-52 flex-shrink-0 border-r border-white/10 overflow-hidden">
          <MediaPantry
            clips={clips}
            selectedId={clip.id}
            onSelect={handlePantrySelect}
          />
        </aside>

        {/* Centre — Video player + controls + TrimBar */}
        <main className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-3 overflow-hidden min-w-0">

          {/* Video — A6: click directly on video to play/pause */}
          <div
            className="w-full rounded-xl overflow-hidden bg-black relative flex-shrink-0"
            style={{ aspectRatio: "16/9", maxHeight: "calc(100vh - 320px)" }}
          >
            {clip.proxy_path ? (
              <video
                ref={videoRef}
                key={clip.id}
                src={convertFileSrc(clip.proxy_path)}
                preload="auto"
                playsInline
                loop
                className="w-full h-full object-contain cursor-pointer"
                onClick={togglePlay}
                onPause={() => setIsPlaying(false)}
                onPlay={() => setIsPlaying(true)}
                onTimeUpdate={(e) => setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000))}
                onSeeked={(e) => setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000))}
              />
            ) : (
              /* Proxy not ready yet — show thumbnail + generating message.
                 Raw DJI HEVC won't decode in WebView2; showing it produces silent black video. */
              <div className="w-full h-full flex flex-col items-center justify-center gap-3 relative">
                {clip.thumbnail_data && (
                  <img
                    src={clip.thumbnail_data}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover opacity-25"
                    draggable={false}
                  />
                )}
                <div className="relative flex flex-col items-center gap-2">
                  <span className="inline-block w-6 h-6 border-2 border-[#FF8A65] border-t-transparent rounded-full animate-spin" />
                  <p className="text-[#e5e5e5]/60 text-xs">Generating preview...</p>
                </div>
              </div>
            )}
          </div>

          {/* Play/pause + volume row */}
          <div className="flex items-center gap-3 w-full">
            <button
              onClick={togglePlay}
              className="w-8 h-8 rounded-full border border-white/20 flex items-center justify-center hover:border-white/40 transition-colors flex-shrink-0"
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
            />
          </div>
        </main>

        {/* Right — Nav + Add to film CTA */}
        <aside className="w-44 flex-shrink-0 border-l border-white/10 flex flex-col items-center justify-center gap-4 px-4 py-6">
          <p className="text-[10px] text-[#e5e5e5]/30">
            {clipIdx + 1} / {clips.length}
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

          {clipInFilm ? (
            <button
              onClick={() => handleToggleInclude(clip, 0)}
              className="w-full py-2.5 bg-[#22c55e]/15 border border-[#22c55e]/60 text-[#22c55e] font-semibold rounded-md text-sm hover:bg-[#22c55e]/10 transition-colors"
            >
              In Film &#10003;
            </button>
          ) : (
            <button
              onClick={() => handleToggleInclude(clip, 1)}
              className="w-full py-2.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md text-sm hover:bg-[#ff9e7a] transition-colors"
            >
              + Add to Film
            </button>
          )}

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
          onRemove={(c) => handleToggleInclude(c, 0)}
          onAdd={(c) => handleToggleInclude(c, 1)}
        />
      </div>
    </div>
  );
}
