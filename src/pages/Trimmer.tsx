import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause } from "lucide-react";
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
import { readTransitionConfig } from "@/utils/buildJobConfig";
import { projectCache } from "@/utils/projectCache";

export default function Trimmer() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const _cached = projectCache.get(projectId ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [loading, setLoading] = useState(!_cached);
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  // Fall back to first in-film clip if all clips are already include=1 (no pantry clips)
  const _firstSource = _cached?.clips.find(c => c.include === 0) ?? _cached?.clips.find(c => c.include === 1) ?? null;
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

  const [viewMode, setViewMode] = useState<"clip" | "film">("clip");
  const [filmPlayIdx, setFilmPlayIdx] = useState(0);
  const filmModeRef = useRef(false);
  const filmPlayIdxRef = useRef(0);
  const inFilmRef = useRef<Clip[]>([]);

  // Dual-buffer film playback: two persistent video elements, ping-pong between them
  const filmVideoARef = useRef<HTMLVideoElement>(null);
  const filmVideoBRef = useRef<HTMLVideoElement>(null);
  const activeFilmSlotRef = useRef<"a" | "b">("a");
  // Incremented each time loadIntoSlot runs for a slot — invalidates stale rVFC callbacks
  const slotGenRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 });

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
        // Fall back to first in-film clip if all clips are already include=1 (no pantry clips)
        const firstSource = data.clips.find(c => c.include === 0) ?? data.clips.find(c => c.include === 1) ?? null;
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

  // Batch N: background proxy pre-gen trigger.
  // On unmount (user leaves Trimmer by any path — bottom tab, Home, back),
  // fire-and-forget generate_proxies_cmd with lowPriority. Rust selects only
  // include=1 clips with proxy_status != 'done' — JS sends no clip list.
  // React StrictMode double-mounts in dev; existing Arc<Mutex<HashSet>> guard
  // de-dupes per-project concurrency, so double-call is harmless.
  useEffect(() => {
    if (!projectId) return;
    return () => {
      invoke("generate_proxies_cmd", { projectId, lowPriority: true }).catch(() => {});
    };
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
    if (filmVideoARef.current) filmVideoARef.current.volume = volume;
    if (filmVideoBRef.current) filmVideoBRef.current.volume = volume;
  }, [volume]);

  // Both film slots start hidden; setSlotVisible manages visibility imperatively (avoids React async paint race)
  useEffect(() => {
    if (filmVideoARef.current) { filmVideoARef.current.style.opacity = "0"; filmVideoARef.current.style.pointerEvents = "none"; }
    if (filmVideoBRef.current) { filmVideoBRef.current.style.opacity = "0"; filmVideoBRef.current.style.pointerEvents = "none"; }
  }, []);

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
    const v = viewMode === "film"
      ? getFilmVideo(activeFilmSlotRef.current)
      : videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (viewMode === "clip" && v.readyState === 0) v.load();
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

  // --- Dual-buffer film engine ---

  function getFilmVideo(slot: "a" | "b") {
    return slot === "a" ? filmVideoARef.current : filmVideoBRef.current;
  }

  function setSlotVisible(slot: "a" | "b" | "none") {
    const vA = filmVideoARef.current;
    const vB = filmVideoBRef.current;
    if (vA) { vA.style.opacity = slot === "a" ? "1" : "0"; vA.style.pointerEvents = slot === "a" ? "" : "none"; }
    if (vB) { vB.style.opacity = slot === "b" ? "1" : "0"; vB.style.pointerEvents = slot === "b" ? "" : "none"; }
  }

  /**
   * Plays `v` and reveals via `onReady` only once rVFC presents a frame whose
   * mediaTime is at/near `targetSec` — prevents frame-0 leak after src+seek on
   * WebView2 (compositor may present the loaded frame before the seeked frame
   * is decoded). slotGenRef gate invalidates stale callbacks when superseded.
   */
  function gateFrameRevealThen(
    v: HTMLVideoElement,
    slot: "a" | "b",
    thisGen: number,
    targetSec: number,
    onReady: () => void,
  ) {
    const TOLERANCE_SEC = 0.05;
    const MAX_WAITS = 30;
    let waits = 0;
    v.play().catch(() => {});

    const rVFC = (v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number }) => void) => void;
    }).requestVideoFrameCallback;

    function check(_now: number, metadata: { mediaTime: number }) {
      if (!filmModeRef.current || slotGenRef.current[slot] !== thisGen) return;
      const frameTime = metadata?.mediaTime ?? v.currentTime;
      if (frameTime >= targetSec - TOLERANCE_SEC) {
        onReady();
        return;
      }
      if (waits >= MAX_WAITS) {
        console.warn("film-seek: rVFC mediaTime gate hit safety cap");
        onReady();
        return;
      }
      waits++;
      rVFC?.call(v, check);
    }

    if (rVFC) {
      rVFC.call(v, check);
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (filmModeRef.current && slotGenRef.current[slot] === thisGen) onReady();
      }));
    }
  }

  /** Load clip[idx] into `slot`, seek to startMs (defaults to in_ms), then play and preload next. */
  function loadIntoSlot(idx: number, slot: "a" | "b", startMs?: number) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    filmPlayIdxRef.current = idx;
    setFilmPlayIdx(idx);

    const v = getFilmVideo(slot);
    if (!v) return;

    const seekMs = startMs !== undefined ? startMs : (filmClip.in_ms ?? 0);
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);

    // Bump generation so any in-flight rVFC from a previous loadIntoSlot on this slot is invalidated
    slotGenRef.current[slot]++;
    const thisGen = slotGenRef.current[slot];

    function activate() {
      if (!filmModeRef.current || !v || slotGenRef.current[slot] !== thisGen) return;
      activeFilmSlotRef.current = slot;
      gateFrameRevealThen(v, slot, thisGen, seekMs / 1000, () => {
        setSlotVisible(slot);
        const nextIdx = idx + 1;
        if (nextIdx < inFilmRef.current.length) {
          const nextSlot: "a" | "b" = slot === "a" ? "b" : "a";
          preloadIntoSlot(nextIdx, nextSlot);
        }
      });
    }

    // Hide immediately so frame 0 never shows while the decoder seeks to startMs
    v.style.opacity = "0";
    v.style.pointerEvents = "none";
    v.src = src;
    // Listener BEFORE load() — cached files fire loadedmetadata synchronously
    v.addEventListener("loadedmetadata", () => {
      if (!filmModeRef.current) return;
      // Add seeked listener BEFORE setting currentTime so it catches synchronous fires
      v.addEventListener("seeked", activate, { once: true });
      v.currentTime = seekMs / 1000;
    }, { once: true });
    v.load();
  }

  /**
   * Cross-clip seek during playback: load clip[idx] into the OPPOSITE slot
   * (keeps outgoing clip's frame visible), then swap visibility only after rVFC
   * confirms the new slot has rendered the seek-target frame. Eliminates the
   * frame-0 flash that occurs when loading into the active slot.
   */
  function crossSeekToClip(idx: number, seekMs: number) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const currentSlot = activeFilmSlotRef.current;
    const targetSlot: "a" | "b" = currentSlot === "a" ? "b" : "a";
    const newV = getFilmVideo(targetSlot);
    const oldV = getFilmVideo(currentSlot);
    if (!newV) return;

    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    slotGenRef.current[targetSlot]++;
    const thisGen = slotGenRef.current[targetSlot];

    // Do NOT touch currentSlot's opacity — leave outgoing frame visible.
    newV.src = src;
    newV.addEventListener("loadedmetadata", () => {
      if (slotGenRef.current[targetSlot] !== thisGen || !filmModeRef.current) return;
      newV.addEventListener("seeked", () => {
        if (slotGenRef.current[targetSlot] !== thisGen || !filmModeRef.current) return;
        gateFrameRevealThen(newV, targetSlot, thisGen, seekMs / 1000, () => {
          filmPlayIdxRef.current = idx;
          setFilmPlayIdx(idx);
          activeFilmSlotRef.current = targetSlot;
          setSlotVisible(targetSlot);
          oldV?.pause();
          const nextIdx = idx + 1;
          if (nextIdx < inFilmRef.current.length) {
            preloadIntoSlot(nextIdx, currentSlot);
          }
        });
      }, { once: true });
      newV.currentTime = seekMs / 1000;
    }, { once: true });
    newV.load();
  }

  /** Pre-load clip[idx] into `slot` and seek to in_ms — do not play. */
  function preloadIntoSlot(idx: number, slot: "a" | "b") {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const v = getFilmVideo(slot);
    if (!v) return;
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    v.src = src;
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = (filmClip.in_ms ?? 0) / 1000;
    }, { once: true });
    v.load();
  }

  /** Called from timeupdate on the active slot when the clip boundary is reached. */
  function advanceFilmClip() {
    const nextIdx = filmPlayIdxRef.current + 1;
    if (nextIdx >= inFilmRef.current.length) {
      getFilmVideo(activeFilmSlotRef.current)?.pause();
      filmModeRef.current = false;
      setIsPlaying(false);
      return;
    }

    const nextSlot: "a" | "b" = activeFilmSlotRef.current === "a" ? "b" : "a";
    const nextV = getFilmVideo(nextSlot);

    // Pause current slot
    getFilmVideo(activeFilmSlotRef.current)?.pause();

    filmPlayIdxRef.current = nextIdx;
    setFilmPlayIdx(nextIdx);
    activeFilmSlotRef.current = nextSlot;
    setSlotVisible(nextSlot);

    if (nextV) {
      nextV.play().catch(() => {
        // Inactive slot wasn't preloaded/seeked yet — load it fresh
        loadIntoSlot(nextIdx, nextSlot);
      });
      // Preload the clip after next
      const afterNextIdx = nextIdx + 1;
      if (afterNextIdx < inFilmRef.current.length) {
        const afterNextSlot: "a" | "b" = nextSlot === "a" ? "b" : "a";
        preloadIntoSlot(afterNextIdx, afterNextSlot);
      }
    }
  }

  function handleFilmTimeUpdate(slot: "a" | "b", currentTimeSec: number) {
    if (!filmModeRef.current || slot !== activeFilmSlotRef.current) return;
    const filmClip = inFilmRef.current[filmPlayIdxRef.current];
    if (!filmClip) return;
    const outSec = (filmClip.out_ms ?? filmClip.duration_ms) / 1000;
    if (currentTimeSec >= outSec) {
      advanceFilmClip();
    }
  }

  /** Seek the film to a specific film-time ms (called from timeline click). */
  function seekFilmTo(filmMs: number) {
    const clips_ = inFilmRef.current;
    let elapsed = 0;
    for (let i = 0; i < clips_.length; i++) {
      const clipMs = Math.max(
        0,
        (clips_[i].out_ms ?? clips_[i].duration_ms) - (clips_[i].in_ms ?? 0)
      );
      if (filmMs < elapsed + clipMs || i === clips_.length - 1) {
        const offsetInClip = Math.max(0, filmMs - elapsed);
        const seekToMs = (clips_[i].in_ms ?? 0) + offsetInClip;
        filmModeRef.current = true;

        if (filmPlayIdxRef.current === i && activeFilmSlotRef.current) {
          // Same clip — just seek within it
          const v = getFilmVideo(activeFilmSlotRef.current);
          if (v) {
            v.currentTime = seekToMs / 1000;
            v.play().catch(() => {});
          }
        } else {
          // Different clip — Option H: cross-slot load with rVFC mediaTime gate.
          // Loads into the OPPOSITE slot while outgoing frame stays visible;
          // swap only when the new slot's compositor frame is at/near seekTo.
          crossSeekToClip(i, seekToMs);
        }
        return;
      }
      elapsed += clipMs;
    }
  }

  // Enter/exit film mode
  useEffect(() => {
    filmModeRef.current = viewMode === "film";
    if (viewMode === "film") {
      if (videoRef.current) videoRef.current.pause();
      setIsPlaying(false);
      activeFilmSlotRef.current = "a";
      setFilmPlayIdx(0);
      filmPlayIdxRef.current = 0;
      if (inFilmRef.current.length > 0) loadIntoSlot(0, "a");
      else setSlotVisible("a");
    } else {
      // Pause film videos; clip video restores naturally (its src was never changed)
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();
      setSlotVisible("none");
      setIsPlaying(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const sourceClips = clips.filter(c => c.include === 0);
  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  inFilmRef.current = inFilm;
  const inFilmCount = inFilm.length;
  const totalMs = inFilm.reduce((sum, c) => sum + Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0)), 0);

  // Film playhead: how far we are in film-time (ms), for the StickyFilmStrip cursor
  const filmPositionMs = viewMode === "film" && inFilm[filmPlayIdx]
    ? inFilm.slice(0, filmPlayIdx).reduce(
        (sum, c) => sum + Math.max(0, (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0)),
        0
      ) + Math.max(0, currentMs - (inFilm[filmPlayIdx].in_ms ?? 0))
    : undefined;
  const configured = useConfiguredTabs(projectId ?? "");
  const transitionVal = (() => { try { const tc = readTransitionConfig(projectId ?? ""); return tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null); } catch { return null; } })();
  const soundMoodVal = (() => { try { const raw = sessionStorage.getItem(`rc_sound_${projectId}`); return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null; } catch { return null; } })();

  const cutPaths = new Set(clips.filter(c => c.include === 1).map(c => c.local_path));
  const alreadyCutRegions = selectedClip
    ? clips
        .filter(c =>
          c.include === 1 &&
          c.local_path === selectedClip.local_path &&
          c.id !== selectedClip.id
        )
        .map(c => ({ inMs: c.in_ms ?? 0, outMs: c.out_ms ?? c.duration_ms ?? 0 }))
        .filter(r => r.outMs > r.inMs)
    : [];
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
    <div className="flex flex-col w-full h-full gap-3 py-2">
      <p className="text-sm text-[#e5e5e5] text-center">{sourceIdx + 1} / {sourceClips.length}</p>
      <div className="flex gap-1.5 w-full flex-shrink-0">
        <button
          onClick={() => handleNav(-1)}
          disabled={!canGoPrev}
          className="flex-1 py-3 border border-white/30 rounded-md text-sm text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
        >
          &#8592; Prev
        </button>
        <button
          onClick={() => handleNav(1)}
          disabled={!canGoNext}
          className="flex-1 py-3 border border-white/30 rounded-md text-sm text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
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
        className="w-full py-4 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md text-sm hover:bg-[#ff9e7a] transition-colors flex-shrink-0"
      >
        + Add to Film
      </button>
      <p className="text-sm text-[#e5e5e5] text-center leading-tight flex-shrink-0">
        {inFilmCount === 0 ? "No clips added yet" : `${inFilmCount} clip${inFilmCount !== 1 ? "s" : ""} in film`}
      </p>
      {filmActiveId && (
        <button
          onClick={() => {
            const cut = clips.find(c => c.id === filmActiveId);
            if (cut) { handleDeleteCut(cut); setFilmActiveId(null); }
          }}
          className="w-full py-2.5 border border-red-500/40 text-red-400 text-sm rounded-md hover:border-red-500/70 hover:bg-red-500/10 transition-colors flex-shrink-0"
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
          playheadMs={filmPositionMs}
          onSeek={viewMode === "film" ? seekFilmTo : undefined}
        />
      }
    >
      {/* Center content: video area (flex-1) + clip controls column */}
      <div className="flex flex-1 min-w-0 h-full overflow-hidden">
        {/* Video + TrimBar */}
        <div className="flex flex-col flex-1 min-w-0 gap-3 px-4 py-3 overflow-hidden">
          {/* Clip / Film toggle — only visible when film has clips */}
          {inFilmCount > 0 && (
            <div className="flex self-center flex-shrink-0">
              <button
                onClick={() => setViewMode("clip")}
                className={`px-4 py-1 text-xs rounded-l-md border transition-colors ${
                  viewMode === "clip"
                    ? "bg-white/15 border-white/40 text-white"
                    : "border-white/20 text-[#a3a3a3] hover:text-white"
                }`}
              >
                Clip
              </button>
              <button
                onClick={() => { setFilmPlayIdx(0); setViewMode("film"); }}
                className={`px-4 py-1 text-xs rounded-r-md border-t border-r border-b transition-colors ${
                  viewMode === "film"
                    ? "bg-white/15 border-white/40 text-white"
                    : "border-white/20 text-[#a3a3a3] hover:text-white"
                }`}
              >
                Film
              </button>
            </div>
          )}
          <div
            ref={videoContainerRef}
            className="w-full rounded-xl overflow-hidden bg-black relative flex-1 min-h-0"
            style={videoHeight != null ? { flex: "none", height: videoHeight } : {}}
          >
            {/* ── Clip mode video ── */}
            <video
              ref={videoRef}
              key={clip.id}
              src={clip.proxy_path ? convertFileSrc(clip.proxy_path) : convertFileSrc(clip.local_path)}
              poster={clip.thumbnail_data ?? undefined}
              preload="auto"
              playsInline
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              style={{
                opacity: viewMode === "clip" && !sourceFailed ? 1 : 0,
                pointerEvents: viewMode === "clip" ? undefined : "none",
              }}
              onClick={togglePlay}
              onPause={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onTimeUpdate={(e) => {
                if (viewMode !== "clip") return;
                const sec = (e.currentTarget as HTMLVideoElement).currentTime;
                const ms = Math.round(sec * 1000);
                setCurrentMs(ms);
                if (isPlaying && ms >= outMs) {
                  (e.currentTarget as HTMLVideoElement).currentTime = inMs / 1000;
                }
              }}
              onSeeked={(e) => {
                if (viewMode === "clip") setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000));
              }}
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

            {/* ── Film video A (dual-buffer) ── */}
            <video
              ref={filmVideoARef}
              preload="auto"
              playsInline
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onPause={() => { if (activeFilmSlotRef.current === "a") setIsPlaying(false); }}
              onPlay={() => { if (activeFilmSlotRef.current === "a") setIsPlaying(true); }}
              onTimeUpdate={(e) => {
                if (activeFilmSlotRef.current !== "a") return;
                const sec = (e.currentTarget as HTMLVideoElement).currentTime;
                setCurrentMs(Math.round(sec * 1000));
                handleFilmTimeUpdate("a", sec);
              }}
            />

            {/* ── Film video B (dual-buffer) ── */}
            <video
              ref={filmVideoBRef}
              preload="auto"
              playsInline
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onPause={() => { if (activeFilmSlotRef.current === "b") setIsPlaying(false); }}
              onPlay={() => { if (activeFilmSlotRef.current === "b") setIsPlaying(true); }}
              onTimeUpdate={(e) => {
                if (activeFilmSlotRef.current !== "b") return;
                const sec = (e.currentTarget as HTMLVideoElement).currentTime;
                setCurrentMs(Math.round(sec * 1000));
                handleFilmTimeUpdate("b", sec);
              }}
            />

            {/* Clip mode failure states */}
            {viewMode === "clip" && sourceFailed && clip.thumbnail_data && (
              <img src={clip.thumbnail_data} alt="" className="absolute inset-0 w-full h-full object-contain" />
            )}
            {viewMode === "clip" && sourceFailed && !clip.proxy_path && (
              <div className="absolute bottom-2 right-2 flex items-center gap-1.5 bg-black/70 px-2.5 py-1.5 rounded-md pointer-events-none">
                <span className="w-3 h-3 border border-[#FF8A65] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <span className="text-[10px] text-[#e5e5e5]/80 leading-none">Generating video...</span>
              </div>
            )}
            {/* Film mode overlay: clip position counter */}
            {viewMode === "film" && inFilmCount > 0 && (
              <div className="absolute top-2 left-2 bg-black/60 text-[#e5e5e5] text-xs px-2 py-0.5 rounded pointer-events-none z-10">
                {filmPlayIdx + 1} / {inFilmCount}
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
              disabled={viewMode === "clip" && !videoCanPlay}
              title={viewMode === "clip" && !videoCanPlay ? "Generating video preview, please wait..." : undefined}
              className="w-10 h-10 rounded-full bg-[#FF8A65] text-white flex items-center justify-center hover:bg-[#ff9e7a] transition-all duration-200 flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {isPlaying
                ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
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

          {viewMode === "clip" && (
            <div className="w-full">
              <TrimBar
                durationMs={clip.duration_ms}
                inMs={inMs}
                outMs={outMs}
                currentMs={currentMs}
                waveformData={selectedClip?.waveform_data}
                alreadyCutRegions={alreadyCutRegions}
                onInChange={handleInChange}
                onOutChange={handleOutChange}
                onCommit={saveCurrentClip}
                onSeek={handleSeek}
              />
            </div>
          )}
        </div>

        {/* Prev / Next / Add to Film — right column (w-48 matches effects panel below) */}
        <div className="w-48 flex-shrink-0 flex px-3 py-4 border-l border-white/10">
          {viewMode === "film" ? (
            <div className="flex flex-col w-full h-full gap-3 py-2">
              <p className="text-sm text-[#a3a3a3] text-center">Film preview</p>
              <button
                onClick={() => seekFilmTo(0)}
                className="w-full py-4 border border-white/30 rounded-md text-sm text-[#e5e5e5] hover:border-white/60 hover:bg-white/5 transition-colors flex-shrink-0"
              >
                &#8635; Restart
              </button>
              <p className="text-sm text-[#e5e5e5] text-center flex-shrink-0">
                {inFilmCount} clip{inFilmCount !== 1 ? "s" : ""} in film
              </p>
            </div>
          ) : (
            clipControls
          )}
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
