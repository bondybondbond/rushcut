import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Clip, ProjectWithClips } from "@/types/project";
import { MediaPantry } from "@/components/trimmer/MediaPantry";
import { TrimBar } from "@/components/trimmer/TrimBar";
import { StickyFilmStrip, cardTextColor } from "@/components/StickyFilmStrip";
import { EditorShell } from "@/components/EditorShell";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { readTransitionConfig, cardDurationFlags, readCardsConfig } from "@/utils/buildJobConfig";
import { effectiveFilmMs, clampedXfadeMs, filmTimeAtClipStart, CARD_DUR_MS } from "@/utils/filmDuration";
import { getRenderPref } from "@/utils/renderStore";
import { projectCache } from "@/utils/projectCache";

// U5c (Issue #2): fire-and-forget freeze-diagnostic trace. Appends to
// %TEMP%\rushcut\playback-trace.log via diag_log_cmd so the last playback events
// before an OS-level GPU TDR freeze survive on disk. Low-frequency, user-driven
// events only (never per-rVFC-frame). Diagnostic signature of a compositor/TDR
// stall: a "gate-start" line with no matching "gate-ok"/"gate-cap" after it.
function diagLog(line: string) {
  invoke("diag_log_cmd", { line }).catch(() => {});
}

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
  const [toast, setToast] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"clip" | "film">("clip");
  const [filmPlayIdx, setFilmPlayIdx] = useState(0);
  // #74 B-lite: when the user clicks an open/close card region on the filmstrip, park the
  // playhead at that card-inclusive film-time and show the card colour over the preview.
  // Applies only while paused (gated below) — pressing play clears it and resumes the clip,
  // so this never touches the dual-buffer / autoplay subsystem (continuous card-hold is #74-followup).
  const [cardHold, setCardHold] = useState<{ filmMs: number; color: string; text: string; subtitle: string } | null>(null);
  const filmModeRef = useRef(false);
  const filmPlayIdxRef = useRef(0);
  const inFilmRef = useRef<Clip[]>([]);

  // Dual-buffer film playback: two persistent video elements, ping-pong between them
  const filmVideoARef = useRef<HTMLVideoElement>(null);
  const filmVideoBRef = useRef<HTMLVideoElement>(null);
  const activeFilmSlotRef = useRef<"a" | "b">("a");
  // Incremented each time loadIntoSlot runs for a slot — invalidates stale rVFC callbacks
  const slotGenRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 });

  // Dual-buffer clip preview (#10): two persistent video elements for clip mode, same
  // ping-pong pattern as the film engine — keeps the outgoing frame visible while the
  // next clip decodes, so Prev/Next/pantry switches never flash black.
  const clipVideoARef = useRef<HTMLVideoElement>(null);
  const clipVideoBRef = useRef<HTMLVideoElement>(null);
  const activeClipSlotRef = useRef<"a" | "b">("a");
  const clipSlotGenRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 });
  // Set by handlers (e.g. handleFilmSelect) to override the load seek target before
  // setSelectedClip fires the load effect; consumed + cleared by that effect.
  const pendingClipStartMsRef = useRef<number | null>(null);

  const videoContainerRef = useRef<HTMLDivElement>(null);
  const [videoHeight, setVideoHeight] = useState<number | null>(null);
  const resizeDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const isSaving = useRef(false);
  const generatingProxyRef = useRef<Set<string>>(new Set());
  // #29: the proxy-progress listener is registered once (deps [projectId]) and so
  // cannot read live `sourceFailed` state. This ref mirrors it so the listener can
  // decide adopt (recovery) vs defer (healthy) without a stale closure.
  const sourceFailedRef = useRef(false);
  // U4d: fire the background zoom warm at most once per Trimmer session (per mount).
  // Project entry is the earliest chokepoint to warm a re-render's zoom cache.

  // Seek-in-progress flag: suppresses onTimeUpdate from overwriting setCurrentMs while
  // the browser is still seeking (prevents the playhead "jump forward then back" stutter).
  const isSeekingRef = useRef(false);

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
          // #29: only swap the in-view clip's src when its source actually FAILED
          // (recovery/upgrade). For a healthy clip, defer adoption — mutating
          // proxy_path here changes the bound <video src> and forces a mid-view
          // abort+reload that re-seeks to in_ms. The clips-array update above keeps
          // the proxy, so re-selecting this clip later picks it up.
          if (sourceFailedRef.current) {
            diagLog(`proxy adopt (recovery) id=${clipId}`);
            setSourceFailed(false);
            return { ...prev, proxy_path: winPath };
          }
          diagLog(`proxy defer (healthy) id=${clipId}`);
          return prev;
        });
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  useEffect(() => {
    if (clipVideoARef.current) clipVideoARef.current.volume = volume;
    if (clipVideoBRef.current) clipVideoBRef.current.volume = volume;
    if (filmVideoARef.current) filmVideoARef.current.volume = volume;
    if (filmVideoBRef.current) filmVideoBRef.current.volume = volume;
  }, [volume]);

  // #29: keep sourceFailedRef in sync for the once-registered proxy-progress listener.
  useEffect(() => { sourceFailedRef.current = sourceFailed; }, [sourceFailed]);

  // All four slots (film A/B + clip A/B) start hidden; visibility is managed imperatively
  // via setSlotVisible / setClipSlotVisible (avoids the React async-paint opacity race).
  useEffect(() => {
    if (filmVideoARef.current) { filmVideoARef.current.style.opacity = "0"; filmVideoARef.current.style.pointerEvents = "none"; }
    if (filmVideoBRef.current) { filmVideoBRef.current.style.opacity = "0"; filmVideoBRef.current.style.pointerEvents = "none"; }
    if (clipVideoARef.current) { clipVideoARef.current.style.opacity = "0"; clipVideoARef.current.style.pointerEvents = "none"; }
    if (clipVideoBRef.current) { clipVideoBRef.current.style.opacity = "0"; clipVideoBRef.current.style.pointerEvents = "none"; }
  }, []);

  // Drive every clip-mode switch (Prev/Next, MediaPantry, film-clip review, initial mount,
  // proxy-arrival) through one central load path. Skipped while film mode owns the slots.
  useEffect(() => {
    if (!selectedClip || filmModeRef.current) return;
    const startMs = pendingClipStartMsRef.current ?? undefined;
    pendingClipStartMsRef.current = null;
    diagLog(`clip-switch id=${selectedClip.id} start=${startMs ?? "in_ms"}`);
    loadClipIntoSlot(selectedClip, startMs);
  }, [selectedClip?.id, selectedClip?.proxy_path]); // eslint-disable-line react-hooks/exhaustive-deps

  const clip = selectedClip;

  const saveCurrentClip = useCallback(async () => {
    if (!clip || !projectId || isSaving.current) return;
    isSaving.current = true;
    try {
      const canonicalInclude = clips.find(c => c.id === clip.id)?.include ?? clip.include;
      console.log("[trimmer] save clip", clip.id, { inMs, outMs, include: canonicalInclude });
      await invoke("update_clip_review_cmd", {
        clipId: clip.id,
        inMs: inMs > 0 ? inMs : null,
        outMs: outMs < clip.duration_ms ? outMs : null,
        focalX: null,
        focalY: null,
        zoomMode: null,
        include: canonicalInclude,
      });
      const newInMs = inMs > 0 ? inMs : null;
      setClips((prev) =>
        prev.map((c) =>
          c.id === clip.id
            ? { ...c, in_ms: newInMs, out_ms: outMs < clip.duration_ms ? outMs : null }
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
      // #11: a fresh cut clones the source's thumbnail (the 1s frame). Re-extract at the
      // cut's own in-point so the film-strip tile shows the cut's true start frame.
      invoke("regenerate_thumbnail_at_cmd", {
        projectId,
        clipId: newCut.id,
        localPath: newCut.local_path,
        atMs: newCut.in_ms ?? 0,
      }).catch(() => {});
    } catch (err) {
      console.error("[trimmer] add cut failed", err);
    }
  }

  async function handleDeleteCut(cutClip: Clip) {
    // Clamp filmPlayIdx against the post-delete in-film list before setClips fires async.
    // setClips is async — `clips`/`inFilm` are still pre-delete in this render cycle, so
    // derive the new in-film list locally (mirrors handleReorder pattern).
    const newClips = clips.filter(c => c.id !== cutClip.id);
    const newInFilm = newClips.filter(c => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
    const currentId = inFilm[filmPlayIdx]?.id;
    const newIdx = currentId ? newInFilm.findIndex(c => c.id === currentId) : -1;
    if (newIdx >= 0) {
      if (newIdx !== filmPlayIdx) {
        setFilmPlayIdx(newIdx);
        filmPlayIdxRef.current = newIdx;
      }
    } else {
      const clamped = Math.max(0, newInFilm.length - 1);
      setFilmPlayIdx(clamped);
      filmPlayIdxRef.current = clamped;
    }

    setClips(prev => prev.filter(c => c.id !== cutClip.id));
    try {
      await invoke("delete_clip_cmd", { clipId: cutClip.id });
    } catch (err) {
      console.error("[trimmer] delete cut failed, rolling back", err);
      setClips(prev => [...prev, cutClip]);
    }
  }

  // Reorder film clips (drag-to-reorder on StickyFilmStrip). The arg is the new order of the
  // in-film clip ids. Merge it back into the full clips array (film clips keep their slots,
  // reordered among themselves) and renumber every sort_order = its full-array index — matching
  // reorder_clips_cmd. The local renumber is required because StickyFilmStrip sorts by sort_order,
  // not array order.
  async function handleReorder(orderedInFilmIds: string[]) {
    const previous = clips;
    const orderSet = new Set(orderedInFilmIds);
    const byId = new Map(clips.map((c) => [c.id, c]));
    const reorderedFilm = orderedInFilmIds.map((id) => byId.get(id)!);
    let k = 0;
    const merged = clips.map((c) => (orderSet.has(c.id) ? reorderedFilm[k++] : c));
    const next = merged.map((c, i) => ({ ...c, sort_order: i }));

    // filmPlayIdx is an integer index into inFilm. After reorder, inFilm changes order but
    // the integer stays fixed, so inFilm[filmPlayIdx] points to the wrong clip. Correct it
    // by finding the currently-playing clip by ID in the new order.
    const currentlyPlayingId = inFilm[filmPlayIdx]?.id;
    if (currentlyPlayingId) {
      const newInFilm = next.filter(c => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
      const newIdx = newInFilm.findIndex(c => c.id === currentlyPlayingId);
      if (newIdx >= 0 && newIdx !== filmPlayIdx) {
        setFilmPlayIdx(newIdx);
        filmPlayIdxRef.current = newIdx;
      }
    }

    setClips(next);
    if (projectId) projectCache.set(projectId, { name: projectName, clips: next });
    try {
      await invoke("reorder_clips_cmd", { clipIds: next.map((c) => c.id) });
    } catch (err) {
      console.error("[trimmer] reorder failed, rolling back", err);
      setClips(previous);
      if (projectId) projectCache.set(projectId, { name: projectName, clips: previous });
    }
  }

  // U5a: handle drag updates the marker only — it must NOT seek/reset the video playhead.
  // (Clicking a handle still seeks, via TrimBar's click handler -> onSeek -> handleSeek.)
  function handleInChange(ms: number) {
    setInMs(ms);
  }

  function handleOutChange(ms: number) {
    setOutMs(ms);
  }

  function handleSeek(ms: number) {
    diagLog(`clip-seek ms=${ms} playing=${isPlaying}`);
    isSeekingRef.current = true;
    const v = activeClipVideo();
    if (v) v.currentTime = ms / 1000;
    setCurrentMs(ms);
    // U5a: if already playing, continue playing after seek. If paused, stay paused.
    if (isPlaying && videoCanPlay && v) {
      v.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  }

  async function handleFilmSelect(filmClip: Clip) {
    const sourceRow = clips.find(c => c.include === 0 && c.local_path === filmClip.local_path);
    const workClip = sourceRow ?? filmClip;
    const startMs = filmClip.in_ms ?? 0;
    if (workClip.id !== clip?.id) {
      await saveCurrentClip();
      // Hand the film-cut's in-point to the load effect so the dual-buffer seeks there
      // (the source row's stored in_ms can differ from this specific cut's).
      pendingClipStartMsRef.current = startMs;
      setSelectedClip(workClip);
      setIsPlaying(false);
      setVideoCanPlay(false);
      setSourceFailed(false);
      generatingProxyRef.current.delete(workClip.id);
    } else {
      // Same source already loaded — no reload, just seek the active slot.
      const v = activeClipVideo();
      if (v) v.currentTime = startMs / 1000;
    }
    setInMs(filmClip.in_ms ?? 0);
    setOutMs(filmClip.out_ms ?? filmClip.duration_ms);
    setCurrentMs(startMs);
    setFilmActiveId(filmClip.id);
  }

  function togglePlay() {
    const v = viewMode === "film"
      ? getFilmVideo(activeFilmSlotRef.current)
      : activeClipVideo();
    if (!v) return;
    diagLog(`toggle-play mode=${viewMode} wasPaused=${v.paused}`);
    if (v.paused) {
      if (viewMode === "clip" && v.readyState === 0) v.load();
      // U5b item 4b: at the clip's natural end, restart from the in-marker.
      // Gated on the natural end (v.ended / duration), NOT outMs — playback is
      // free across the whole clip; markers are only the cut boundary.
      if (viewMode === "clip" && clip && (v.ended || v.currentTime * 1000 >= clip.duration_ms - 50)) {
        v.currentTime = inMs / 1000;
        setCurrentMs(inMs);
      }
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

  // --- Dual-buffer clip preview (#10) ---

  function getClipVideo(slot: "a" | "b") {
    return slot === "a" ? clipVideoARef.current : clipVideoBRef.current;
  }

  /** The clip-mode video element currently revealed to the user. */
  function activeClipVideo() {
    return getClipVideo(activeClipSlotRef.current);
  }

  /** The film-mode video element currently revealed to the user (null if no slot is active). */
  function activeFilmVideo() {
    return activeFilmSlotRef.current ? getFilmVideo(activeFilmSlotRef.current) : null;
  }

  /**
   * Reveal `slot`, hide the other — in one synchronous call so BOTH clip slots are never
   * invisible while clip mode is active (LEARNINGS: dual-buffer must not blank the frame).
   */
  function setClipSlotVisible(slot: "a" | "b") {
    const vA = clipVideoARef.current;
    const vB = clipVideoBRef.current;
    if (vA) { vA.style.opacity = slot === "a" ? "1" : "0"; vA.style.pointerEvents = slot === "a" ? "" : "none"; }
    if (vB) { vB.style.opacity = slot === "b" ? "1" : "0"; vB.style.pointerEvents = slot === "b" ? "" : "none"; }
  }

  function hideBothClipSlots() {
    if (clipVideoARef.current) { clipVideoARef.current.style.opacity = "0"; clipVideoARef.current.style.pointerEvents = "none"; }
    if (clipVideoBRef.current) { clipVideoBRef.current.style.opacity = "0"; clipVideoBRef.current.style.pointerEvents = "none"; }
  }

  function handleClipSlotError(erroredClip: Clip | null) {
    if (filmModeRef.current) return;
    setSourceFailed(true);
    setVideoCanPlay(false);
    if (erroredClip && !erroredClip.proxy_path && !generatingProxyRef.current.has(erroredClip.id)) {
      generatingProxyRef.current.add(erroredClip.id);
      invoke("generate_proxy_for_clip", { projectId, clipId: erroredClip.id }).catch(() => {});
    }
  }

  /**
   * Load `clipToLoad` into the OPPOSITE clip slot, seek to startMs (defaults to in_ms),
   * gate the reveal on the new slot rendering the target frame, then swap visibility.
   * The outgoing slot stays at opacity 1 the whole time — no black flash. Mirrors the
   * film engine's crossSeekToClip, minus film-only playback/preload concerns.
   */
  function loadClipIntoSlot(clipToLoad: Clip, startMs?: number, shouldPlay = false) {
    const currentSlot = activeClipSlotRef.current;
    const targetSlot: "a" | "b" = currentSlot === "a" ? "b" : "a";
    const newV = getClipVideo(targetSlot);
    const oldV = getClipVideo(currentSlot);
    if (!newV) return;

    const seekMs = startMs !== undefined ? startMs : (clipToLoad.in_ms ?? 0);
    const src = convertFileSrc(clipToLoad.proxy_path ?? clipToLoad.local_path);

    // Bump generation so any in-flight rVFC from a previous load on this slot is invalidated.
    clipSlotGenRef.current[targetSlot]++;
    const thisGen = clipSlotGenRef.current[targetSlot];
    const isValid = () => !filmModeRef.current && clipSlotGenRef.current[targetSlot] === thisGen;

    diagLog(`clip-load id=${clipToLoad.id} from=${currentSlot} to=${targetSlot} seekMs=${seekMs}`);

    // Do NOT touch the outgoing slot's opacity — leave its frame visible until reveal.
    newV.muted = true; // suppress audio blip during rVFC frame-detect
    newV.volume = volume;
    newV.src = src;
    newV.addEventListener("loadedmetadata", () => {
      if (!isValid()) return;
      newV.addEventListener("seeked", () => {
        if (!isValid()) return;
        gateFrameRevealThen(newV, targetSlot, thisGen, seekMs / 1000, isValid, () => {
          setClipSlotVisible(targetSlot); // reveals new + hides old atomically
          activeClipSlotRef.current = targetSlot;
          newV.muted = false;
          if (shouldPlay) {
            setIsPlaying(true);
          } else {
            newV.pause(); // gateFrameRevealThen called play() to drive rVFC — undo it
            setIsPlaying(false);
          }
          oldV?.pause();
          setSourceFailed(false);
          setVideoCanPlay(true);
          setCurrentMs(seekMs);
        });
      }, { once: true });
      newV.currentTime = seekMs / 1000;
    }, { once: true });
    newV.load();
  }

  /**
   * Plays `v` and reveals via `onReady` only once rVFC presents a frame whose
   * mediaTime is at/near `targetSec` — prevents frame-0 leak after src+seek on
   * WebView2 (compositor may present the loaded frame before the seeked frame
   * is decoded). slotGenRef gate invalidates stale callbacks when superseded.
   */
  /**
   * `isValid` decouples this gate from any one mode: callers pass their own staleness
   * guard (film: `filmModeRef.current && slotGenRef[slot]===gen`; clip: `!filmModeRef.current
   * && clipSlotGenRef[slot]===gen`). The gate itself only handles the rVFC frame-ready reveal.
   */
  function gateFrameRevealThen(
    v: HTMLVideoElement,
    slot: "a" | "b",
    thisGen: number,
    targetSec: number,
    isValid: () => boolean,
    onReady: () => void,
  ) {
    const TOLERANCE_SEC = 0.05;
    const MAX_WAITS = 30;
    let waits = 0;
    diagLog(`gate-start slot=${slot} gen=${thisGen} target=${targetSec.toFixed(3)}`);
    v.play().catch(() => {});

    const rVFC = (v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number }) => void) => void;
    }).requestVideoFrameCallback;

    function check(_now: number, metadata: { mediaTime: number }) {
      if (!isValid()) return;
      const frameTime = metadata?.mediaTime ?? v.currentTime;
      if (frameTime >= targetSec - TOLERANCE_SEC) {
        diagLog(`gate-ok slot=${slot} gen=${thisGen} fires=${waits + 1}`);
        onReady();
        return;
      }
      if (waits >= MAX_WAITS) {
        console.warn("film-seek: rVFC mediaTime gate hit safety cap");
        diagLog(`gate-cap slot=${slot} gen=${thisGen} fires=${waits}`);
        onReady();
        return;
      }
      waits++;
      rVFC?.call(v, check);
    }

    if (rVFC) {
      rVFC.call(v, check);
    } else {
      diagLog(`gate-noRVFC slot=${slot} gen=${thisGen}`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (isValid()) onReady();
      }));
    }
  }

  /** Load clip[idx] into `slot`, seek to startMs (defaults to in_ms), then optionally play and preload next. */
  function loadIntoSlot(idx: number, slot: "a" | "b", startMs?: number, shouldPlay = true) {
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
      v.muted = true; // suppress audio blip during rVFC frame-detect (same pattern as crossSeekToClip)
      gateFrameRevealThen(v, slot, thisGen, seekMs / 1000,
        () => filmModeRef.current && slotGenRef.current[slot] === thisGen,
        () => {
        setSlotVisible(slot);
        if (!shouldPlay) v.pause();
        v.muted = false;
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
  function crossSeekToClip(idx: number, seekMs: number, shouldPlay = true) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const currentSlot = activeFilmSlotRef.current;
    const targetSlot: "a" | "b" = currentSlot === "a" ? "b" : "a";
    const newV = getFilmVideo(targetSlot);
    const oldV = getFilmVideo(currentSlot);
    if (!newV) return;
    // Both slots decode concurrently here (outgoing stays visible while new loads) —
    // the prime window for doubled GPU decode load under heavy seeking.
    diagLog(`cross-seek idx=${idx} from=${currentSlot} to=${targetSlot} seekMs=${seekMs}`);

    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    slotGenRef.current[targetSlot]++;
    const thisGen = slotGenRef.current[targetSlot];

    // Do NOT touch currentSlot's opacity — leave outgoing frame visible.
    newV.src = src;
    newV.addEventListener("loadedmetadata", () => {
      if (slotGenRef.current[targetSlot] !== thisGen || !filmModeRef.current) return;
      newV.addEventListener("seeked", () => {
        if (slotGenRef.current[targetSlot] !== thisGen || !filmModeRef.current) return;
        newV.muted = true; // suppress audio during rVFC frame-detect phase
        gateFrameRevealThen(newV, targetSlot, thisGen, seekMs / 1000,
          () => filmModeRef.current && slotGenRef.current[targetSlot] === thisGen,
          () => {
          filmPlayIdxRef.current = idx;
          setFilmPlayIdx(idx);
          setCurrentMs(seekMs); // cursor lands at click position before onTimeUpdate resumes
          activeFilmSlotRef.current = targetSlot;
          setSlotVisible(targetSlot);
          newV.muted = false; // restore audio now that the correct frame is displayed
          isSeekingRef.current = false;
          // gateFrameRevealThen called play() for its rVFC mechanism — reconcile state:
          // if we should be playing, force setIsPlaying(true) because onPlay fired before
          // activeFilmSlot was updated so its slot guard failed to update state.
          // if we should be paused, undo the play() call now that we've revealed the frame.
          if (shouldPlay) setIsPlaying(true);
          else newV.pause();
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
    diagLog(`film-advance next=${nextIdx}`);
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
        // Inactive slot wasn't preloaded/seeked yet — load it fresh.
        // U5a step 1 (diagnostic): this fallback is the visible clip-switch hitch
        // (full src reload at the boundary). If this never logs during normal
        // playback, the preload chain already covers boundaries — no fix needed.
        console.warn("[film-stutter] advanceFilmClip fallback reload, idx=", nextIdx);
        diagLog(`film-advance-fallback idx=${nextIdx}`);
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

  /**
   * Seek the film to a specific render-time ms (called from timeline click / nav).
   * `filmMs` is telescoped render-time (matches the StickyFilmStrip ruler), so the walk
   * accumulates per-clip render widths (trimmed - xfade, last clip keeps full length).
   * The within-clip offset still maps 1:1 to playback time, so seekToMs = in_ms + offset.
   */
  function seekFilmTo(filmMs: number) {
    diagLog(`film-seek filmMs=${filmMs} playing=${isPlaying}`);
    const wasPlaying = isPlaying;
    const clips_ = inFilmRef.current;
    const xfadeMs = clampedXfadeMs(clips_, readTransitionConfig(projectId ?? ""));

    // #74: cards bracket the film as first-class 3s elements. `filmMs` from the strip is
    // card-inclusive, so map the card regions explicitly. The open card leads at
    // [0, CARD_DUR_MS - xfade); the clip chain telescopes EXACTLY like the strip segments
    // (every element but the last loses one xfade), and a close card (when present) makes the
    // last clip telescope too. Clicking a card region parks the playhead + shows the colour
    // overlay; it must NOT mis-seek a video (B-lite — no autoplay-through-card here).
    const cards = readCardsConfig(projectId ?? "");
    const hasOpen = cards.open.show && clips_.length > 0;
    const hasClose = cards.close.show && clips_.length > 0;
    const leadMs = hasOpen ? Math.max(0, CARD_DUR_MS - xfadeMs) : 0;

    if (hasOpen && filmMs < leadMs) {
      // Open-card region — park playhead on the card colour, leave the video paused.
      activeFilmVideo()?.pause();
      setCardHold({ filmMs, color: cards.open.color, text: cards.open.text, subtitle: cards.open.subtitle });
      return;
    }

    // Clip-region (and close-card-region) walk in card-inclusive film-time.
    let elapsed = leadMs;
    for (let i = 0; i < clips_.length; i++) {
      const trimmed = Math.max(
        0,
        (clips_[i].out_ms ?? clips_[i].duration_ms) - (clips_[i].in_ms ?? 0)
      );
      // A clip telescopes unless it is the very last film element (i.e. last clip AND no close card).
      const isLastElement = i === clips_.length - 1 && !hasClose;
      const clipMs = Math.max(0, trimmed - (!isLastElement ? xfadeMs : 0));
      if (filmMs < elapsed + clipMs || (i === clips_.length - 1 && !hasClose)) {
        setCardHold(null); // leaving any card region
        const offsetInClip = Math.max(0, filmMs - elapsed);
        const seekToMs = (clips_[i].in_ms ?? 0) + offsetInClip;
        filmModeRef.current = true;
        isSeekingRef.current = true;

        if (filmPlayIdxRef.current === i && activeFilmSlotRef.current) {
          // Same clip — just seek within it; onSeeked resets isSeekingRef.
          const v = getFilmVideo(activeFilmSlotRef.current);
          if (v) {
            v.currentTime = seekToMs / 1000;
            setCurrentMs(seekToMs); // cursor jumps to click position immediately
            if (wasPlaying) v.play().catch(() => {});
          }
        } else {
          // Different clip — Option H: cross-slot load with rVFC mediaTime gate.
          // Loads into the OPPOSITE slot while outgoing frame stays visible;
          // swap only when the new slot's compositor frame is at/near seekTo.
          // onReady resets isSeekingRef and reconciles play state.
          crossSeekToClip(i, seekToMs, wasPlaying);
        }
        return;
      }
      elapsed += clipMs;
    }

    // Past the last clip with a close card present — close-card region. Park on its colour.
    if (hasClose) {
      activeFilmVideo()?.pause();
      setCardHold({ filmMs, color: cards.close.color, text: cards.close.text, subtitle: cards.close.subtitle });
    }
  }

  /**
   * U5b item 5: prev/next film-clip nav. Reads filmPlayIdxRef (imperative — always
   * fresh) for the current index, then reuses seekFilmTo by computing the film-time
   * at the target clip's start. seekFilmTo preserves play state (wasPlaying) and
   * updates both filmPlayIdx state + ref, so the counter/disabled binding stay in sync.
   */
  function gotoFilmClip(dir: -1 | 1) {
    const list = inFilmRef.current;
    const target = filmPlayIdxRef.current + dir;
    if (target < 0 || target >= list.length) return;
    diagLog(`film-nav dir=${dir} target=${target}`);
    // Render-time start of the target clip — seekFilmTo consumes card-inclusive telescoped
    // render-time (#71/#74), so pass the open-card lead via hasOpenCard.
    const xfadeMs = clampedXfadeMs(list, readTransitionConfig(projectId ?? ""));
    const hasOpen = readCardsConfig(projectId ?? "").open.show && list.length > 0;
    seekFilmTo(filmTimeAtClipStart(list, target, xfadeMs, hasOpen));
  }

  // #74: a card-region park is a paused, film-mode-only state. Clear it the moment playback
  // starts or the user leaves film mode, so the overlay/playhead override never lingers.
  useEffect(() => {
    if (isPlaying || viewMode !== "film") setCardHold(null);
  }, [isPlaying, viewMode]);

  // Enter/exit film mode
  useEffect(() => {
    filmModeRef.current = viewMode === "film";
    if (viewMode === "film") {
      // Leaving clip mode: pause + hide the clip slots (clip mode is no longer active, so
      // blanking them here does not violate the never-blank-while-active rule).
      activeClipVideo()?.pause();
      hideBothClipSlots();
      setIsPlaying(false);
      activeFilmSlotRef.current = "a";
      setFilmPlayIdx(0);
      filmPlayIdxRef.current = 0;
      if (inFilmRef.current.length > 0) loadIntoSlot(0, "a", undefined, false);
      else setSlotVisible("a");
    } else {
      // Entering clip mode: pause + hide film slots, then re-reveal the active clip slot.
      // The clip slots' src/decoded frame were never touched while in film mode, so the
      // last frame is still intact — reveal it (no reload, no flash). Reveal BEFORE the
      // film slots vanish so there is never a blank moment.
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();
      const activeClip = getClipVideo(activeClipSlotRef.current);
      if (activeClip?.src) {
        setClipSlotVisible(activeClipSlotRef.current);
      } else if (selectedClip) {
        loadClipIntoSlot(selectedClip); // never loaded yet (e.g. mounted straight into film)
      }
      setSlotVisible("none");
      setIsPlaying(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);

  const sourceClips = clips.filter(c => c.include === 0);
  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  inFilmRef.current = inFilm;
  const inFilmCount = inFilm.length;
  // #62: displayed runtime subtracts transition overlap (telescoped, like the render).
  const totalMs = effectiveFilmMs(inFilm, readTransitionConfig(projectId ?? ""), cardDurationFlags(projectId ?? ""));

  // Render-time (telescoped) overlap per cut — shared by the playhead, seek + ruler (#71).
  const filmXfadeOverlapMs = clampedXfadeMs(inFilm, readTransitionConfig(projectId ?? ""));

  // #74: card tiles for the filmstrip. Cards are edited on Arrange and persisted to the store,
  // so Trimmer reads them via readCardsConfig (no live in-memory state here).
  const filmCards = readCardsConfig(projectId ?? "");
  const openCardStrip = filmCards.open.show
    ? { color: filmCards.open.color, text: filmCards.open.text }
    : null;
  const closeCardStrip = filmCards.close.show
    ? { color: filmCards.close.color, text: filmCards.close.text }
    : null;

  // Film playhead: how far we are in render-time (ms), for the StickyFilmStrip cursor.
  // Telescoped via the shared filmTimeAtClipStart so the playhead matches the ruler (#71); the
  // open card adds its lead time so the playhead stays aligned with the card-inclusive ruler (#74).
  // When parked on a card region (paused), the cardHold position overrides the clip-derived one.
  const filmPositionMs = viewMode === "film"
    ? (cardHold && !isPlaying
        ? cardHold.filmMs
        : inFilm[filmPlayIdx]
          ? filmTimeAtClipStart(inFilm, filmPlayIdx, filmXfadeOverlapMs, openCardStrip !== null)
            + Math.max(0, currentMs - (inFilm[filmPlayIdx].in_ms ?? 0))
          : undefined)
    : undefined;
  const configured = useConfiguredTabs(projectId ?? "");
  const transitionVal = (() => { try { const tc = readTransitionConfig(projectId ?? ""); return tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null); } catch { return null; } })();
  const soundMoodVal = (() => { try { const raw = getRenderPref(`rc_sound_${projectId}`); return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null; } catch { return null; } })();

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
    <div className="flex flex-col w-full h-full gap-3 py-2 justify-center">
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
          clips={sourceClips}
          selectedId={clip.include === 0 ? clip.id : sourceClips.find(sc => sc.local_path === clip.local_path)?.id ?? null}
          onSelect={handlePantrySelect}
          inFilmPaths={cutPaths}
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
          onReorder={handleReorder}
          playheadMs={filmPositionMs}
          onSeek={viewMode === "film" ? seekFilmTo : undefined}
          xfadeOverlapMs={filmXfadeOverlapMs}
          openCard={openCardStrip}
          closeCard={closeCardStrip}
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
          {/* U5b item 5b: flex row flanks the video with film prev/next. Sizing
              (flex-1 / videoHeight resize override) lives on THIS row; the inner
              container is h-full so the resize handle still measures the same height. */}
          <div
            className="flex gap-4 w-full flex-1 min-h-0"
            style={videoHeight != null ? { flex: "none", height: videoHeight } : {}}
          >
            <button
              type="button"
              data-testid={viewMode === "film" ? "trim-film-prev" : "trim-clip-prev"}
              onClick={() => viewMode === "film" ? gotoFilmClip(-1) : handleNav(-1)}
              disabled={viewMode === "film" ? filmPlayIdx <= 0 : !canGoPrev}
              className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={14} />
              Prev
            </button>
          <div
            ref={videoContainerRef}
            className="rounded-xl overflow-hidden bg-black relative flex-1 min-h-0 h-full"
          >
            {/* ── Clip mode video A (dual-buffer, #10) — src/opacity set imperatively ── */}
            <video
              ref={clipVideoARef}
              preload="auto"
              playsInline
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onPause={() => { if (viewMode === "clip" && activeClipSlotRef.current === "a") setIsPlaying(false); }}
              onPlay={() => { if (viewMode === "clip" && activeClipSlotRef.current === "a") setIsPlaying(true); }}
              onTimeUpdate={(e) => {
                if (viewMode !== "clip" || activeClipSlotRef.current !== "a") return;
                if (!isSeekingRef.current) setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000));
              }}
              onSeeked={(e) => {
                if (activeClipSlotRef.current !== "a") return;
                isSeekingRef.current = false;
                if (viewMode === "clip") setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000));
              }}
              onCanPlay={() => { if (!filmModeRef.current) setVideoCanPlay(true); }}
              onError={() => handleClipSlotError(clip)}
            />

            {/* ── Clip mode video B (dual-buffer, #10) ── */}
            <video
              ref={clipVideoBRef}
              preload="auto"
              playsInline
              className="absolute inset-0 w-full h-full object-contain cursor-pointer"
              onClick={togglePlay}
              onPause={() => { if (viewMode === "clip" && activeClipSlotRef.current === "b") setIsPlaying(false); }}
              onPlay={() => { if (viewMode === "clip" && activeClipSlotRef.current === "b") setIsPlaying(true); }}
              onTimeUpdate={(e) => {
                if (viewMode !== "clip" || activeClipSlotRef.current !== "b") return;
                if (!isSeekingRef.current) setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000));
              }}
              onSeeked={(e) => {
                if (activeClipSlotRef.current !== "b") return;
                isSeekingRef.current = false;
                if (viewMode === "clip") setCurrentMs(Math.round((e.currentTarget as HTMLVideoElement).currentTime * 1000));
              }}
              onCanPlay={() => { if (!filmModeRef.current) setVideoCanPlay(true); }}
              onError={() => handleClipSlotError(clip)}
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
                if (!isSeekingRef.current) setCurrentMs(Math.round(sec * 1000));
                handleFilmTimeUpdate("a", sec);
              }}
              onSeeked={() => { if (activeFilmSlotRef.current === "a") isSeekingRef.current = false; }}
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
                if (!isSeekingRef.current) setCurrentMs(Math.round(sec * 1000));
                handleFilmTimeUpdate("b", sec);
              }}
              onSeeked={() => { if (activeFilmSlotRef.current === "b") isSeekingRef.current = false; }}
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
            {/* Position counter overlay — film mode shows film clip index, clip mode shows source clip index */}
            {viewMode === "film" && inFilmCount > 0 && (
              <div className="absolute top-2 left-2 bg-black/60 text-[#e5e5e5] text-xs px-2 py-0.5 rounded pointer-events-none z-10">
                {filmPlayIdx + 1} / {inFilmCount}
              </div>
            )}
            {viewMode === "clip" && sourceClips.length > 1 && (
              <div className="absolute top-2 left-2 bg-black/60 text-[#e5e5e5] text-xs px-2 py-0.5 rounded pointer-events-none z-10">
                {sourceIdx + 1} / {sourceClips.length}
              </div>
            )}
            {/* #74: card-colour hold — shown when the playhead is parked on an open/close card
                region (paused, film mode). Solid colour mirrors the strip card tile.
                Text is interim: the final preview uses card preview proxies (#76). */}
            {viewMode === "film" && cardHold && !isPlaying && (
              <div
                className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center"
                style={{ background: cardHold.color }}
              >
                {(cardHold.text || cardHold.subtitle) && (
                  <div className="flex flex-col items-center gap-2 px-8 select-none">
                    {cardHold.text && (
                      <p
                        className="text-center font-semibold"
                        style={{
                          color: cardTextColor(cardHold.color),
                          fontSize: "clamp(1.25rem, 3vw, 2.5rem)",
                        }}
                      >
                        {cardHold.text}
                      </p>
                    )}
                    {cardHold.subtitle && (
                      <p
                        className="text-center font-normal"
                        style={{
                          color: cardTextColor(cardHold.color),
                          fontSize: "clamp(0.875rem, 1.8vw, 1.5rem)",
                          opacity: 0.75,
                        }}
                      >
                        {cardHold.subtitle}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
            <button
              type="button"
              data-testid={viewMode === "film" ? "trim-film-next" : "trim-clip-next"}
              onClick={() => viewMode === "film" ? gotoFilmClip(1) : handleNav(1)}
              disabled={viewMode === "film" ? filmPlayIdx >= inFilmCount - 1 : !canGoNext}
              className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight size={14} />
            </button>
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
