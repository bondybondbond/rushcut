import { useState, useEffect, useRef } from "react";
import { Play, Pause } from "lucide-react";
import { useParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Clip, ProjectWithClips } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { fmtMs } from "@/utils/fmtMs";
import { projectCache } from "@/utils/projectCache";
import { readTransitionConfig, readCardsConfig } from "@/utils/buildJobConfig";
import { effectiveFilmMs } from "@/utils/filmDuration";
import { getRenderPref, setRenderPref } from "@/utils/renderStore";

type MusicMood = "none" | "cinematic" | "upbeat" | "chill" | "electronic" | "custom";
type LibraryMood = "cinematic" | "upbeat" | "chill" | "electronic";
type MusicSource = "none" | "library" | "custom";
type MusicVolume = "subtle" | "balanced" | "prominent";
type MusicFadeOut = "none" | "2s" | "5s";
type MusicTab = "music" | "mixer";

interface SoundState {
  mood: MusicMood;
  volume: MusicVolume;
  customPath?: string;
  musicFadeOut: MusicFadeOut;
  musicLoop: boolean;
}

const LIBRARY_MOODS: { value: LibraryMood; label: string; description: string }[] = [
  { value: "cinematic",  label: "Cinematic",  description: "Epic orchestral score -- great for travel and nature." },
  { value: "upbeat",     label: "Upbeat",     description: "Energetic and positive -- great for action and sport." },
  { value: "chill",      label: "Chill",      description: "Laid-back and warm -- great for everyday memories." },
  { value: "electronic", label: "Electronic", description: "Driving synth beats -- great for fast-cut montages." },
];

const VOLUMES: { value: MusicVolume; label: string }[] = [
  { value: "subtle",    label: "Subtle" },
  { value: "balanced",  label: "Balanced" },
  { value: "prominent", label: "Prominent" },
];

const VOLUME_LEVELS: Record<MusicVolume, number> = { subtle: 0.3, balanced: 0.6, prominent: 1.0 };
// Music volume for rough-mix playback — same scale, used for musicAudioRef.volume
const MUSIC_VOLUME: Record<MusicVolume, number> = { subtle: 0.3, balanced: 0.6, prominent: 1.0 };

const FADE_OUT_OPTIONS: { value: MusicFadeOut; label: string }[] = [
  { value: "none", label: "None" },
  { value: "2s",   label: "2s" },
  { value: "5s",   label: "5s" },
];

const DEFAULT_SOUND: SoundState = { mood: "none", volume: "balanced", musicFadeOut: "2s", musicLoop: true };
const PREVIEW_DURATION_MS = 30_000;

function deriveSource(mood: MusicMood): MusicSource {
  if (mood === "none") return "none";
  if (mood === "custom") return "custom";
  return "library";
}

function deriveLibraryMood(mood: MusicMood): LibraryMood | null {
  const lib: LibraryMood[] = ["cinematic", "upbeat", "chill", "electronic"];
  return lib.includes(mood as LibraryMood) ? (mood as LibraryMood) : null;
}

function readStorage(key: string): SoundState {
  try {
    const raw = getRenderPref(key);
    if (!raw) return DEFAULT_SOUND;
    const parsed = JSON.parse(raw) as Partial<SoundState>;
    const VALID_MOODS: MusicMood[] = ["none", "cinematic", "upbeat", "chill", "electronic", "custom"];
    const VALID_VOLUMES: MusicVolume[] = ["subtle", "balanced", "prominent"];
    const mood = VALID_MOODS.includes(parsed.mood as MusicMood) ? (parsed.mood as MusicMood) : DEFAULT_SOUND.mood;
    const VALID_FADE_OUTS: MusicFadeOut[] = ["none", "2s", "5s"];
    return {
      mood,
      volume: VALID_VOLUMES.includes(parsed.volume as MusicVolume) ? (parsed.volume as MusicVolume) : DEFAULT_SOUND.volume,
      customPath: typeof parsed.customPath === "string" ? parsed.customPath : undefined,
      musicFadeOut: VALID_FADE_OUTS.includes(parsed.musicFadeOut as MusicFadeOut) ? (parsed.musicFadeOut as MusicFadeOut) : DEFAULT_SOUND.musicFadeOut,
      // Back-compat: existing (pre-U6) projects have no musicLoop key -> default ON (matches today's always-loop render)
      musicLoop: typeof parsed.musicLoop === "boolean" ? parsed.musicLoop : DEFAULT_SOUND.musicLoop,
    };
  } catch {
    return DEFAULT_SOUND;
  }
}

export default function Sound() {
  const { projectId } = useParams<{ projectId: string }>();

  const _cached = projectCache.get(projectId ?? "");
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [musicDir, setMusicDir] = useState<string | null>(null);
  const [trackDurations, setTrackDurations] = useState<Partial<Record<LibraryMood, number>>>({});
  const [customDurationMs, setCustomDurationMs] = useState<number | null>(null);
  const [previewingMood, setPreviewingMood] = useState<LibraryMood | null>(null);
  const [previewingCustom, setPreviewingCustom] = useState(false);

  const storageKey = `rc_sound_${projectId}`;
  const [sound, setSound] = useState<SoundState>(() => readStorage(storageKey));
  const [musicTab, setMusicTab] = useState<MusicTab>("music");

  const audioRef = useRef<HTMLAudioElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probedRef = useRef(false);

  // Rough-mix playback refs — dual-buffer A/B slots (mirrors Trimmer.tsx dual-buffer engine)
  const filmVideoARef = useRef<HTMLVideoElement>(null);  // slot A
  const filmVideoBRef = useRef<HTMLVideoElement>(null);  // slot B
  const activeFilmSlotRef = useRef<"a" | "b">("a");      // which slot is currently visible
  const slotGenRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 }); // invalidates stale rVFC callbacks
  const musicAudioRef = useRef<HTMLAudioElement>(null);  // music track during rough mix
  const filmPlayingRef = useRef(false);                  // imperative flag (avoids stale closures)
  const filmPlayIdxRef = useRef(0);                      // current clip index (fast access)
  const clipStartMsRef = useRef(0);                      // cumulative film-time at current clip start
  const inFilmRef = useRef<typeof inFilm>([]);           // stable ref for event callbacks
  const progressBarFillRef = useRef<HTMLDivElement>(null); // imperative progress bar fill (avoids re-render)
  const elapsedLabelRef = useRef<HTMLSpanElement>(null);   // imperative elapsed-time label
  const hasPlayedRef = useRef(false);                      // true once playback has started; hides "Press play" overlay after film ends

  // Rough-mix playback state
  const [isFilmPlaying, setIsFilmPlaying] = useState(false);
  const [isFilmPaused, setIsFilmPaused] = useState(false);
  const [filmPlayIdx, setFilmPlayIdx] = useState(0);    // drives "Clip N / M" label
  // #51: transient note shown when a clip's proxy is missing and we fell back to the source file
  const [proxyFallbackNote, setProxyFallbackNote] = useState(false);
  const proxyNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const configured = useConfiguredTabs(projectId ?? "");

  const source = deriveSource(sound.mood);
  const libraryMood = deriveLibraryMood(sound.mood);

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  // GEOMETRY value: naive sum drives the master-preview scrub bar, seek, fade marker,
  // and playhead -- the preview plays proxies sequentially, so its timeline is naive (#62).
  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);
  // DISPLAY value: effective runtime (transition overlap subtracted + card seconds added)
  // for the runtime label + music loop/coverage math, which times against the telescoped
  // render (#62/#63). Read cards once; reuse for both the duration and the strip bookends.
  const cardsCfg = readCardsConfig(projectId ?? "");
  const effectiveMs = effectiveFilmMs(inFilm, readTransitionConfig(projectId ?? ""), {
    open: cardsCfg.open.show,
    close: cardsCfg.close.show,
  });
  // Keep inFilmRef current so playback callbacks always read the latest clip list
  // without needing to re-subscribe on every render.
  inFilmRef.current = inFilm;

  const { transitionVal, openingTransitionVal, closingTransitionVal } = (() => {
    try {
      const tc = readTransitionConfig(projectId ?? "");
      return {
        transitionVal: tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null),
        openingTransitionVal: tc.opening !== "none" ? tc.opening : null,
        closingTransitionVal: tc.closing !== "none" ? tc.closing : null,
      };
    } catch { return { transitionVal: null, openingTransitionVal: null, closingTransitionVal: null }; }
  })();

  useEffect(() => {
    if (!projectId) return;
    // #50: additive zoom-cache warm on Sound mount (backup to Arrange triggers + Render backstop).
    // Gives the warm the full Sound-screen dwell to finish before the user reaches Render, closing
    // the Arrange->Sound->Render gap. The Rust {project_id}:zoom guard dedupes the Arrange-unmount fire.
    invoke("warm_zoom_cache_cmd", { projectId }).catch(() => {});
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        projectCache.set(projectId, { name: data.project.name, clips: data.clips });
        setProjectName(data.project.name);
        setClips(data.clips);
      })
      .catch(() => {});
    invoke<string>("get_music_dir_cmd")
      .then((dir) => {
        if (!dir) return;
        setMusicDir(dir);
        if (probedRef.current) return;
        probedRef.current = true;
        const moods: LibraryMood[] = ["cinematic", "upbeat", "chill", "electronic"];
        moods.forEach((mood) => {
          const a = new Audio();
          a.preload = "metadata";
          a.src = convertFileSrc(dir + "\\" + mood + ".mp3");
          a.addEventListener("loadedmetadata", () => {
            setTrackDurations((prev) => ({ ...prev, [mood]: a.duration }));
          }, { once: true });
        });
      })
      .catch(() => {});
  }, [projectId]);

  // Both film slots start hidden; setSlotVisible manages visibility imperatively (avoids React async paint race)
  useEffect(() => {
    if (filmVideoARef.current) { filmVideoARef.current.style.opacity = "0"; filmVideoARef.current.style.pointerEvents = "none"; }
    if (filmVideoBRef.current) { filmVideoBRef.current.style.opacity = "0"; filmVideoBRef.current.style.pointerEvents = "none"; }
  }, []);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
      if (proxyNoteTimerRef.current !== null) clearTimeout(proxyNoteTimerRef.current);
      // Stop rough-mix playback on route leave
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();
      musicAudioRef.current?.pause();
      filmPlayingRef.current = false;
    };
  }, []);

  // Real-time volume sync — if music is playing and user changes the volume chip, take effect immediately
  useEffect(() => {
    if (!isFilmPlaying) return;
    const ma = musicAudioRef.current;
    if (!ma) return;
    ma.volume = MUSIC_VOLUME[sound.volume];
  }, [sound.volume, isFilmPlaying]);

  // ---------------------------------------------------------------------------
  // Dual-buffer film engine (ported from Trimmer.tsx lines 340–498)
  // ---------------------------------------------------------------------------

  function getFilmVideo(slot: "a" | "b") {
    return slot === "a" ? filmVideoARef.current : filmVideoBRef.current;
  }

  // #51: stamp which clip + source-kind a slot's <video> currently holds, so the
  // onError handler can resolve the clip and decide whether a fallback is still possible.
  // usingSource="0" -> currently playing the proxy; "1" -> already on the original source file.
  function stampSlot(v: HTMLVideoElement, clip: Clip) {
    v.dataset.clipId = clip.id;
    v.dataset.usingSource = clip.proxy_path ? "0" : "1";
  }

  // #51: a slot's <video> failed to load/play. If it was on the proxy, fall back to the
  // original source file (dual-buffer aware): the PRELOADED (inactive) slot retries silently
  // so it is ready when promoted; the ACTIVE slot recovers mid-playback and surfaces a note.
  // If it was already on the source, give up gracefully (advance past the clip if active) so
  // the film never stalls.
  function handleSlotError(slot: "a" | "b") {
    const v = getFilmVideo(slot);
    if (!v) return;
    const clip = inFilmRef.current.find((c) => c.id === v.dataset.clipId);
    if (!clip) return;
    const isActive = slot === activeFilmSlotRef.current;

    if (v.dataset.usingSource === "1" || !clip.proxy_path) {
      // Already on the source (or no proxy to fall back from) and still failing.
      if (isActive && filmPlayingRef.current) {
        console.warn("[sound] active slot source playback failed, advancing past clip", clip.id);
        advanceFilmClipRough();
      }
      return;
    }

    // Proxy failed -> swap to the original source file at the clip's in-point.
    const sourceSrc = convertFileSrc(clip.local_path);
    const seekSec = (clip.in_ms ?? 0) / 1000;
    v.dataset.usingSource = "1";
    v.src = sourceSrc;
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = seekSec;
      if (isActive && filmPlayingRef.current) v.play().catch(() => {});
    }, { once: true });
    v.load();

    if (isActive) {
      setProxyFallbackNote(true);
      if (proxyNoteTimerRef.current !== null) clearTimeout(proxyNoteTimerRef.current);
      proxyNoteTimerRef.current = setTimeout(() => {
        setProxyFallbackNote(false);
        proxyNoteTimerRef.current = null;
      }, 4000);
    }
  }

  function setSlotVisible(slot: "a" | "b" | "none") {
    const vA = filmVideoARef.current;
    const vB = filmVideoBRef.current;
    if (vA) { vA.style.opacity = slot === "a" ? "1" : "0"; vA.style.pointerEvents = slot === "a" ? "" : "none"; }
    if (vB) { vB.style.opacity = slot === "b" ? "1" : "0"; vB.style.pointerEvents = slot === "b" ? "" : "none"; }
  }

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
      if (!filmPlayingRef.current || slotGenRef.current[slot] !== thisGen) return;
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
        if (filmPlayingRef.current && slotGenRef.current[slot] === thisGen) onReady();
      }));
    }
  }

  function loadIntoSlot(idx: number, slot: "a" | "b", startMs?: number) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    filmPlayIdxRef.current = idx;
    setFilmPlayIdx(idx);

    const v = getFilmVideo(slot);
    if (!v) return;

    const seekMs = startMs !== undefined ? startMs : (filmClip.in_ms ?? 0);
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);

    slotGenRef.current[slot]++;
    const thisGen = slotGenRef.current[slot];

    function activate() {
      if (!filmPlayingRef.current || !v || slotGenRef.current[slot] !== thisGen) return;
      activeFilmSlotRef.current = slot;
      v.volume = Math.min(1, filmClip.clip_volume ?? 1.0);
      gateFrameRevealThen(v, slot, thisGen, seekMs / 1000, () => {
        setSlotVisible(slot);
        const nextIdx = idx + 1;
        if (nextIdx < inFilmRef.current.length) {
          const nextSlot: "a" | "b" = slot === "a" ? "b" : "a";
          preloadIntoSlot(nextIdx, nextSlot);
        }
      });
    }

    v.style.opacity = "0";
    v.style.pointerEvents = "none";
    v.src = src;
    stampSlot(v, filmClip);
    v.addEventListener("loadedmetadata", () => {
      if (!filmPlayingRef.current) return;
      v.addEventListener("seeked", activate, { once: true });
      v.currentTime = seekMs / 1000;
    }, { once: true });
    v.load();
  }

  function preloadIntoSlot(idx: number, slot: "a" | "b") {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const v = getFilmVideo(slot);
    if (!v) return;
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    v.src = src;
    stampSlot(v, filmClip);
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = (filmClip.in_ms ?? 0) / 1000;
    }, { once: true });
    v.load();
  }

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

    newV.src = src;
    stampSlot(newV, filmClip);
    newV.addEventListener("loadedmetadata", () => {
      if (slotGenRef.current[targetSlot] !== thisGen || !filmPlayingRef.current) return;
      newV.addEventListener("seeked", () => {
        if (slotGenRef.current[targetSlot] !== thisGen || !filmPlayingRef.current) return;
        gateFrameRevealThen(newV, targetSlot, thisGen, seekMs / 1000, () => {
          filmPlayIdxRef.current = idx;
          setFilmPlayIdx(idx);
          activeFilmSlotRef.current = targetSlot;
          newV.volume = Math.min(1, filmClip.clip_volume ?? 1.0);
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

  function stopPreview() {
    audioRef.current?.pause();
    setPreviewingMood(null);
    setPreviewingCustom(false);
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rough-mix live playback
  // ---------------------------------------------------------------------------

  function advanceFilmClipRough() {
    // Guard against stray onEnded re-entry after the film already stopped (e.g. a
    // buffered/preloaded slot firing `ended` post-seek). Without this, the advance
    // state machine plays one extra clip with no music sync. See U6 follow-up Bug A.
    if (!filmPlayingRef.current) return;
    const prevClip = inFilmRef.current[filmPlayIdxRef.current];
    if (prevClip) {
      clipStartMsRef.current += Math.max(
        0,
        (prevClip.out_ms ?? prevClip.duration_ms) - (prevClip.in_ms ?? 0),
      );
    }

    const nextIdx = filmPlayIdxRef.current + 1;
    if (nextIdx >= inFilmRef.current.length) {
      stopFilmPlayback();
      return;
    }

    // Snap progress to new clip's start position immediately — avoids the brief
    // "go back a bit" jitter where progress holds at end-of-clip-N until clip-N+1's
    // first timeupdate fires.
    if (progressBarFillRef.current && totalMs > 0) {
      progressBarFillRef.current.style.width = `${Math.min(100, (clipStartMsRef.current / totalMs) * 100)}%`;
    }
    if (elapsedLabelRef.current) {
      elapsedLabelRef.current.textContent = `${fmtMs(clipStartMsRef.current)} / ${fmtMs(totalMs)}`;
    }

    // Dual-buffer advance: swap to the preloaded inactive slot, then play it.
    // Slot-gen invalidation replaces the old isAdvancingRef guard.
    const nextSlot: "a" | "b" = activeFilmSlotRef.current === "a" ? "b" : "a";
    const nextV = getFilmVideo(nextSlot);

    getFilmVideo(activeFilmSlotRef.current)?.pause();

    filmPlayIdxRef.current = nextIdx;
    setFilmPlayIdx(nextIdx);
    activeFilmSlotRef.current = nextSlot;
    setSlotVisible(nextSlot);

    if (nextV) {
      const nextClip = inFilmRef.current[nextIdx];
      if (nextClip) nextV.volume = Math.min(1, nextClip.clip_volume ?? 1.0);
      nextV.play().catch(() => {
        // Inactive slot wasn't preloaded yet — load it fresh
        loadIntoSlot(nextIdx, nextSlot);
      });
      const afterNextIdx = nextIdx + 1;
      if (afterNextIdx < inFilmRef.current.length) {
        const afterNextSlot: "a" | "b" = nextSlot === "a" ? "b" : "a";
        preloadIntoSlot(afterNextIdx, afterNextSlot);
      }
    }
  }

  function handleFilmTimeUpdate(slot: "a" | "b", currentTimeSec: number) {
    // Ignore events from the inactive slot — only the active slot drives progress
    if (!filmPlayingRef.current || slot !== activeFilmSlotRef.current) return;
    const clip = inFilmRef.current[filmPlayIdxRef.current];
    if (!clip) return;

    // Respect user trim out_ms — onEnded fires at the END of the source file,
    // not at the user's trim point.
    const outSec = (clip.out_ms ?? clip.duration_ms) / 1000;
    if (currentTimeSec >= outSec) {
      advanceFilmClipRough();
      return;
    }

    const offsetInClip = Math.max(0, currentTimeSec - (clip.in_ms ?? 0) / 1000) * 1000;
    const elapsedMs = clipStartMsRef.current + offsetInClip;

    // Imperative DOM updates — avoid React re-render at 4-66Hz timeupdate rate
    if (progressBarFillRef.current && totalMs > 0) {
      progressBarFillRef.current.style.width = `${Math.min(100, (elapsedMs / totalMs) * 100)}%`;
    }
    if (elapsedLabelRef.current) {
      elapsedLabelRef.current.textContent = `${fmtMs(elapsedMs)} / ${fmtMs(totalMs)}`;
    }

    // Music fade-out — applies to the END OF THE ENTIRE FILM (by design)
    const ma = musicAudioRef.current;
    if (!ma) return;
    const fadeMs = ({ none: 0, "2s": 2000, "5s": 5000 } as Record<string, number>)[sound.musicFadeOut] ?? 0;
    if (fadeMs > 0 && totalMs > 0) {
      const remainingMs = totalMs - elapsedMs;
      if (remainingMs <= fadeMs) {
        ma.volume = MUSIC_VOLUME[sound.volume] * Math.max(0, remainingMs / fadeMs);
      }
    }
  }

  function startFilmPlayback() {
    stopPreview(); // stop any mood chip preview
    hasPlayedRef.current = true;
    filmPlayingRef.current = true;
    filmPlayIdxRef.current = 0;
    clipStartMsRef.current = 0;
    activeFilmSlotRef.current = "a";
    slotGenRef.current = { a: 0, b: 0 };
    setFilmPlayIdx(0);
    setIsFilmPlaying(true);

    const ma = musicAudioRef.current;
    if (ma && sound.mood !== "none") {
      const src =
        sound.mood === "custom" && sound.customPath
          ? convertFileSrc(sound.customPath)
          : musicDir
          ? convertFileSrc(musicDir + "\\" + sound.mood + ".mp3")
          : null;
      if (src) {
        ma.src = src;
        ma.loop = sound.musicLoop; // U6: loop track to fill film when enabled
        ma.volume = MUSIC_VOLUME[sound.volume];
        ma.currentTime = 0;
        ma.play().catch(() => {});
      }
    }
    // Dual-buffer: load clip 0 into slot A; preload of clip 1 into slot B happens inside loadIntoSlot's onReady
    loadIntoSlot(0, "a");
  }

  function pauseFilmPlayback() {
    filmPlayingRef.current = false;
    getFilmVideo(activeFilmSlotRef.current)?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(true);
  }

  function resumeFilmPlayback() {
    filmPlayingRef.current = true;
    getFilmVideo(activeFilmSlotRef.current)?.play().catch(() => {});
    musicAudioRef.current?.play().catch(() => {});
    setIsFilmPlaying(true);
    setIsFilmPaused(false);
  }

  function stopFilmPlayback() {
    filmPlayingRef.current = false;
    filmVideoARef.current?.pause();
    filmVideoBRef.current?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(false);
    filmPlayIdxRef.current = 0;
    clipStartMsRef.current = 0;
    // Do NOT call setSlotVisible("none") here — leave the last frame visible in the active slot.
    // startFilmPlayback resets activeFilmSlotRef and slotGenRef when restarting.
    setFilmPlayIdx(0);
    if (progressBarFillRef.current) progressBarFillRef.current.style.width = "0%";
    if (elapsedLabelRef.current) elapsedLabelRef.current.textContent = `${fmtMs(0)} / ${fmtMs(totalMs)}`;
  }

  // Seek to any position in the film. Works from idle, playing, or paused.
  // Music is kept in sync — its currentTime is set to match the film position.
  function seekToFilmMs(targetMs: number) {
    const clips = inFilmRef.current;
    if (clips.length === 0 || totalMs <= 0) return;

    const clamped = Math.max(0, Math.min(targetMs, totalMs));

    // Find which clip contains this position
    let acc = 0;
    let idx = clips.length - 1;
    for (let i = 0; i < clips.length; i++) {
      const dur = (clips[i].out_ms ?? clips[i].duration_ms) - (clips[i].in_ms ?? 0);
      if (acc + dur > clamped || i === clips.length - 1) { idx = i; break; }
      acc += dur;
    }

    const clip = clips[idx];
    const seekMs = (clip.in_ms ?? 0) + (clamped - acc);

    // Update tracking refs + visual indicators immediately
    clipStartMsRef.current = acc;
    if (progressBarFillRef.current && totalMs > 0) {
      progressBarFillRef.current.style.width = `${(clamped / totalMs) * 100}%`;
    }
    if (elapsedLabelRef.current) {
      elapsedLabelRef.current.textContent = `${fmtMs(clamped)} / ${fmtMs(totalMs)}`;
    }

    const wasIdle = !filmPlayingRef.current && !isFilmPaused;
    const ma = musicAudioRef.current;

    if (wasIdle && ma && sound.mood !== "none") {
      const src =
        sound.mood === "custom" && sound.customPath
          ? convertFileSrc(sound.customPath)
          : musicDir
          ? convertFileSrc(musicDir + "\\" + sound.mood + ".mp3")
          : null;
      if (src) {
        ma.src = src;
        ma.loop = sound.musicLoop;
        ma.load();
      }
    }

    // Sync music position — reset volume first so fade re-applies from handleFilmTimeUpdate
    if (ma) {
      ma.loop = sound.musicLoop; // U6: keep loop state current (volume chip / mood may have changed)
      ma.volume = MUSIC_VOLUME[sound.volume];
      // wasIdle: play() must fire inside the seeked handler — WebView2 resolves play() immediately
      // but never starts playback if called while a seek is still in flight (LEARNINGS: mute-bridge pattern).
      const shouldPlayAfterSeek = wasIdle && sound.mood !== "none";
      const trySync = () => {
        try {
          const trackDur = ma.duration || clamped / 1000;
          // U6: loop ON -> map film time into the looped track via modulo; OFF -> clamp to track end (plays once)
          const target = sound.musicLoop
            ? (clamped / 1000) % trackDur
            : Math.min(clamped / 1000, trackDur);
          // U6b: film still rolling but music already ran out (loop OFF) and user scrubbed BACK into the track.
          // ma.ended is the primary signal; ma.paused arm is narrowed to "paused because it reached the end"
          // so it won't leak when manual-pause / mid-seek pause states are added later.
          const musicEndedButFilmRolling =
            filmPlayingRef.current && !isFilmPaused &&
            (ma.ended || (ma.paused && ma.currentTime >= trackDur - 0.1));
          // Only resume if the film position is genuinely WITHIN the track (loop OFF) — not at/after its end.
          const withinTrack = !sound.musicLoop && clamped / 1000 < trackDur - 0.05;
          const shouldPlay = shouldPlayAfterSeek || (musicEndedButFilmRolling && withinTrack);
          // Skip redundant reseeks within 100ms (matches scrub-debounce tolerance) — avoids glitch during a continuous drag
          if (Math.abs(target - ma.currentTime) < 0.1) {
            if (shouldPlay) ma.play().catch(() => {});
            return;
          }
          // Mute-bridge the reseek (LEARNINGS: WebView2 audio dropout on currentTime write); unmute + play once seek lands
          ma.muted = true;
          ma.addEventListener("seeked", () => {
            ma.muted = false;
            if (shouldPlay) ma.play().catch(() => {});
          }, { once: true });
          ma.currentTime = target;
        } catch (e) { /* music may not be loaded yet */ }
      };
      if (ma.readyState >= 1) trySync();
      else ma.addEventListener("loadedmetadata", trySync, { once: true });
    }

    if (wasIdle) {
      hasPlayedRef.current = true;
      filmPlayingRef.current = true;
      activeFilmSlotRef.current = "a";
      slotGenRef.current = { a: 0, b: 0 };
      setIsFilmPlaying(true);
      setIsFilmPaused(false);
      // Load into slot A with seek target; music play is handled by trySync's seeked handler above
      loadIntoSlot(idx, "a", seekMs);
      return;
    }

    // Mid-playback or paused: use cross-slot seek if different clip, direct seek if same
    if (filmPlayIdxRef.current === idx) {
      // Same clip — seek in the active slot directly
      const v = getFilmVideo(activeFilmSlotRef.current);
      if (v) {
        v.currentTime = seekMs / 1000;
        if (filmPlayingRef.current) v.play().catch(() => {});
      }
      filmPlayIdxRef.current = idx;
      setFilmPlayIdx(idx);
    } else {
      // Different clip — use crossSeekToClip (outgoing frame stays visible until new frame ready)
      crossSeekToClip(idx, seekMs);
    }
    clipStartMsRef.current = acc;
  }

  function startCustomPreview() {
    if (!sound.customPath || !audioRef.current) return;
    const audio = audioRef.current;
    audio.src = convertFileSrc(sound.customPath);
    audio.volume = VOLUME_LEVELS[sound.volume];
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setPreviewingCustom(true);
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      audioRef.current?.pause();
      setPreviewingCustom(false);
      previewTimerRef.current = null;
    }, PREVIEW_DURATION_MS);
  }

  function startPreview(mood: LibraryMood, volume: MusicVolume = sound.volume) {
    if (!musicDir || !audioRef.current) return;
    const audio = audioRef.current;
    audio.src = convertFileSrc(musicDir + "\\" + mood + ".mp3");
    audio.volume = VOLUME_LEVELS[volume];
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setPreviewingMood(mood);
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      audioRef.current?.pause();
      setPreviewingMood(null);
      previewTimerRef.current = null;
    }, PREVIEW_DURATION_MS);
  }

  function persist(next: SoundState) {
    setSound(next);
    setRenderPref(storageKey, JSON.stringify(next));
  }

  function handleSourceClick(newSource: MusicSource) {
    if (newSource === "none") {
      stopPreview();
      setCustomDurationMs(null);
      persist({ ...sound, mood: "none" });
    } else if (newSource === "library") {
      if (source === "library") return;
      stopPreview();
      setCustomDurationMs(null);
      const targetMood = libraryMood ?? "cinematic";
      persist({ ...sound, mood: targetMood });
    } else {
      if (source === "custom") return;
      stopPreview();
      persist({ ...sound, mood: "custom" });
    }
  }

  function handleLibraryMoodClick(mood: LibraryMood) {
    persist({ ...sound, mood });
    startPreview(mood);
  }

  function handleMusicTabChange(t: MusicTab) {
    if (t !== "mixer" && (isFilmPlaying || isFilmPaused)) stopFilmPlayback();
    if (t === "mixer") stopPreview();   // stop mood chip preview when entering Master
    setMusicTab(t);
  }

  function handleVolume(volume: MusicVolume) {
    persist({ ...sound, volume });
    if (audioRef.current && (previewingMood || previewingCustom)) {
      audioRef.current.volume = VOLUME_LEVELS[volume];
    }
    // real-time update handled by useEffect above
  }

  function handleFadeOut(musicFadeOut: MusicFadeOut) {
    persist({ ...sound, musicFadeOut });
  }

  function handleLoopToggle() {
    const musicLoop = !sound.musicLoop;
    // Apply to a live preview immediately so the user hears the change without restarting
    if (musicAudioRef.current) musicAudioRef.current.loop = musicLoop;
    persist({ ...sound, musicLoop });
  }

  async function handleCustomTrack() {
    stopPreview();
    const result = await open({ filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aac", "flac"] }] });
    if (!result) return;
    const customPath = typeof result === "string" ? result : Array.isArray(result) ? result[0] : null;
    if (!customPath) return;
    persist({ ...sound, mood: "custom", customPath });
    if (audioRef.current) {
      const handler = () => {
        setCustomDurationMs((audioRef.current?.duration ?? 0) * 1000);
      };
      audioRef.current.addEventListener("loadedmetadata", handler, { once: true });
      audioRef.current.preload = "metadata";
      audioRef.current.src = convertFileSrc(customPath);
    }
  }

  function sourceChipClass(s: MusicSource): string {
    const base = "text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium";
    const isActive = source === s;
    if (s === "none") {
      return isActive
        ? `${base} border-white/60 text-white bg-white/15`
        : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
    }
    return isActive
      ? `${base} border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`
      : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
  }

  function moodChipClass(value: LibraryMood): string {
    const base = "text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium";
    return libraryMood === value
      ? `${base} border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`
      : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
  }

  const moodDescription =
    source === "library" && libraryMood
      ? LIBRARY_MOODS.find((m) => m.value === libraryMood)?.description
      : source === "custom" && sound.customPath
      ? "Your own audio track will be mixed with your clips."
      : source === "none"
      ? "Your film will render without a music track."
      : null;

  const selectedTrackMs =
    source === "library" && libraryMood && trackDurations[libraryMood] !== undefined
      ? trackDurations[libraryMood]! * 1000
      : source === "custom" && customDurationMs !== null
      ? customDurationMs
      : null;

  // #62: music coverage/loop math compares the track to the EFFECTIVE (telescoped) film.
  const showComparison = source !== "none" && effectiveMs > 0 && selectedTrackMs !== null;

  const loopNote: React.ReactNode =
    !showComparison ? null
    : selectedTrackMs! >= effectiveMs
    ? <span className="text-[#22c55e]"> &mdash; long enough</span>
    : sound.musicLoop
    ? <span> &mdash; will loop ~{Math.ceil(effectiveMs / selectedTrackMs!)}x</span>
    : <span> &mdash; plays once, then silence</span>;

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={effectiveMs}
      activeTab="sound"
      configured={configured}
      transitionValue={transitionVal}
      openingTransition={openingTransitionVal}
      closingTransition={closingTransitionVal}
      soundMood={sound.mood}
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
        />
      }
    >
      <audio ref={audioRef} />
      <audio ref={musicAudioRef} />

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* In-screen tab bar */}
        <div className="flex items-center justify-center gap-2 px-6 pt-3 pb-3 border-b border-white/10 flex-shrink-0">
          {(["music", "mixer"] as MusicTab[]).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`music-tab-${t}`}
              onClick={() => handleMusicTabChange(t)}
              className={`text-sm rounded-md px-4 py-1.5 border transition-all duration-200 font-medium ${
                musicTab === t
                  ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                  : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
              }`}
            >
              {t === "music" ? "Music" : "Master"}
            </button>
          ))}
        </div>

        {/* ── Music tab ──────────────────────────────────────────────── */}
        <div className={musicTab === "music" ? "flex-1 overflow-y-auto" : "hidden"}>
          <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
            <h1 className="text-3xl font-semibold text-[#FF8A65]">Music</h1>

            {/* Music picker card */}
            <div className="border border-white/15 rounded-lg p-6 space-y-4">
              {/* Source selector — 3 top-level options */}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  data-testid="chip-mood-none"
                  onClick={() => handleSourceClick("none")}
                  className={sourceChipClass("none")}
                >
                  No Music
                </button>
                <button
                  type="button"
                  data-testid="chip-source-library"
                  onClick={() => handleSourceClick("library")}
                  className={sourceChipClass("library")}
                >
                  Rushcut Library
                </button>
                <button
                  type="button"
                  data-testid="chip-mood-custom"
                  onClick={() => handleSourceClick("custom")}
                  className={sourceChipClass("custom")}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-3.5 h-3.5 mr-1.5 shrink-0 inline-block"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload Own Track
                </button>
              </div>

              {/* Library mood sub-chips */}
              {source === "library" && (
                <>
                  <div className="border-t border-white/10" />
                  <div className="flex flex-wrap gap-3">
                    {LIBRARY_MOODS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`chip-mood-${value}`}
                        onClick={() => handleLibraryMoodClick(value)}
                        className={moodChipClass(value)}
                      >
                        {label}{trackDurations[value] !== undefined ? ` · ${fmtMs(trackDurations[value]! * 1000)}` : ""}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Custom track — empty state */}
              {source === "custom" && !sound.customPath && (
                <button
                  type="button"
                  onClick={handleCustomTrack}
                  className="flex items-center gap-2 w-full px-4 py-3 rounded-md border border-dashed border-white/25 text-sm text-[#a3a3a3] hover:border-white/50 hover:text-[#e5e5e5] transition-all duration-200"
                >
                  <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Choose audio file...
                </button>
              )}

              {/* Custom track — file chosen */}
              {source === "custom" && sound.customPath && (
                <div className="flex items-center gap-3">
                  <p className="text-base font-semibold text-[#e5e5e5] truncate flex-1">
                    {sound.customPath.split("\\").pop() ?? sound.customPath.split("/").pop()}
                  </p>
                  <button
                    type="button"
                    onClick={previewingCustom ? stopPreview : startCustomPreview}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm font-medium transition-all duration-200 shrink-0 ${
                      previewingCustom
                        ? "border-white/60 text-white bg-white/10"
                        : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                    }`}
                  >
                    {previewingCustom ? (
                      <>
                        <svg viewBox="0 0 15 15" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <rect x="3" y="3" width="9" height="9" rx="0.5" />
                        </svg>
                        Stop
                      </>
                    ) : (
                      <>
                        {/* Play — teenyicons MIT: https://github.com/teenyicons/teenyicons */}
                        <svg viewBox="0 0 15 15" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path d="M4.79062 2.09314C4.63821 1.98427 4.43774 1.96972 4.27121 2.05542C4.10467 2.14112 4 2.31271 4 2.5V12.5C4 12.6873 4.10467 12.8589 4.27121 12.9446C4.43774 13.0303 4.63821 13.0157 4.79062 12.9069L11.7906 7.90687C11.922 7.81301 12 7.66148 12 7.5C12 7.33853 11.922 7.18699 11.7906 7.09314L4.79062 2.09314Z" />
                        </svg>
                        Preview
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCustomTrack}
                    className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors shrink-0"
                  >
                    Change
                  </button>
                </div>
              )}

              {/* Stop preview link */}
              {previewingMood && (
                <button
                  onClick={stopPreview}
                  className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] cursor-pointer transition-colors"
                >
                  Stop preview
                </button>
              )}

              {/* Description */}
              {moodDescription && (
                <p className="text-sm text-[#a3a3a3]">{moodDescription}</p>
              )}

              {/* Film vs track duration comparison */}
              {showComparison && (
                <p className="text-sm text-[#a3a3a3]">
                  Film: {fmtMs(effectiveMs)} &middot; Track: {fmtMs(selectedTrackMs!)}{loopNote}
                </p>
              )}
            </div>

            {/* Music fade-out — set here once, applied at render and in the Master preview */}
            <div className="border border-white/15 rounded-lg p-5 space-y-3">
              <div>
                <p className="text-base font-medium text-[#e5e5e5]">Music fade-out</p>
                <p className="text-sm text-[#a3a3a3] mt-0.5">
                  How should the music tail off at the end of the film?
                </p>
              </div>
              <div className="flex gap-3">
                {FADE_OUT_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`chip-fadeout-${value}`}
                    onClick={() => handleFadeOut(value)}
                    className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                      sound.musicFadeOut === value
                        ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                        : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Loop music — fill the film when the track is shorter than the film */}
            <div className="border border-white/15 rounded-lg p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-medium text-[#e5e5e5]">Loop music to fill film</p>
                <p className="text-sm text-[#a3a3a3] mt-0.5">
                  When the track is shorter than the film, repeat it. Off plays the track once, then silence.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sound.musicLoop}
                data-testid="toggle-music-loop"
                onClick={handleLoopToggle}
                className={`relative w-11 h-6 rounded-full flex-shrink-0 transition-colors duration-200 ${
                  sound.musicLoop ? "bg-[#99B3FF]" : "bg-white/25"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
                    sound.musicLoop ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <p className="text-sm text-[#a3a3a3]">
              Settings are saved automatically. Head to Master to preview with music.
            </p>
          </div>
        </div>

        {/* ── Master mixer tab — full film preview + music controls ── */}
        <div className={musicTab === "mixer" ? "flex flex-1 min-h-0" : "hidden"}>

          {/* Center: video player + controls bar */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Video area — dual-buffer A/B slots (mirrors Trimmer.tsx lines 770–846) */}
            <div className="flex-1 bg-black min-h-0 relative overflow-hidden">
              {/* Slot A */}
              <video
                ref={filmVideoARef}
                preload="auto"
                playsInline
                className={`absolute inset-0 w-full h-full object-contain ${inFilm.length > 0 ? "cursor-pointer" : ""}`}
                onClick={
                  isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : inFilm.length > 0 ? startFilmPlayback
                  : undefined
                }
                onEnded={() => { if (activeFilmSlotRef.current === "a") advanceFilmClipRough(); }}
                onError={() => handleSlotError("a")}
                onTimeUpdate={(e) => {
                  if (activeFilmSlotRef.current !== "a") return;
                  handleFilmTimeUpdate("a", (e.currentTarget as HTMLVideoElement).currentTime);
                }}
              />
              {/* Slot B */}
              <video
                ref={filmVideoBRef}
                preload="auto"
                playsInline
                className={`absolute inset-0 w-full h-full object-contain ${inFilm.length > 0 ? "cursor-pointer" : ""}`}
                onClick={
                  isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : inFilm.length > 0 ? startFilmPlayback
                  : undefined
                }
                onEnded={() => { if (activeFilmSlotRef.current === "b") advanceFilmClipRough(); }}
                onError={() => handleSlotError("b")}
                onTimeUpdate={(e) => {
                  if (activeFilmSlotRef.current !== "b") return;
                  handleFilmTimeUpdate("b", (e.currentTarget as HTMLVideoElement).currentTime);
                }}
              />
              {/* Placeholder — shown only when truly idle and never started playing.
                  hasPlayedRef prevents re-showing after natural film end. */}
              {!isFilmPlaying && !isFilmPaused && !hasPlayedRef.current && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-sm text-[#a3a3a3]">
                    {inFilm.length === 0 ? "No clips in film" : "Press play to preview"}
                  </p>
                </div>
              )}
              {/* U6 Bug B: idle click-catcher. The slot <video>s start at pointer-events:none
                  (set on mount + by setSlotVisible), so on first entry no element receives the
                  click. This transparent overlay (z-10, above the videos) lets a click anywhere
                  on the preview start playback. It unmounts the instant playback starts, so it
                  never intercepts the pause/resume toggle that the visible slot then handles. */}
              {!isFilmPlaying && !isFilmPaused && inFilm.length > 0 && (
                <div
                  className="absolute inset-0 z-10 cursor-pointer"
                  onClick={startFilmPlayback}
                />
              )}
            </div>

            {/* Controls bar — relative z-20 so scrubber + play button always win the
                stacking order over the idle click-catcher overlay (defensive; they're
                already a separate sibling below the video area). */}
            <div className="relative z-20 flex items-center gap-3 px-4 py-3 border-t border-white/10 flex-shrink-0">
              {/* Play / Pause button — canonical media button per DESIGN.md */}
              <button
                disabled={inFilm.length === 0}
                onClick={
                  isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : startFilmPlayback
                }
                className="w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              >
                {isFilmPlaying
                  ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                  : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                }
              </button>

              {/* Seekable progress bar with fade-out marker */}
              <div
                role="slider"
                aria-label="Film progress"
                className="flex-1 h-1.5 bg-white/20 rounded-full cursor-pointer relative"
                onClick={(e) => {
                  if (inFilm.length === 0 || totalMs === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  seekToFilmMs(Math.round(frac * totalMs));
                }}
              >
                <div
                  ref={progressBarFillRef}
                  className="h-full bg-[#FF8A65] rounded-full pointer-events-none"
                  style={{ width: "0%" }}
                />
                {/* Fade-out marker — vertical tick + label showing where music starts fading */}
                {(() => {
                  const fadeMs = ({ none: 0, "2s": 2000, "5s": 5000 } as Record<string, number>)[sound.musicFadeOut] ?? 0;
                  if (fadeMs <= 0 || totalMs <= 0 || sound.mood === "none") return null;
                  const pct = Math.max(0, ((totalMs - fadeMs) / totalMs) * 100);
                  return (
                    <div
                      className="absolute pointer-events-none"
                      style={{ left: `${pct}%`, top: "50%", transform: "translate(-50%, -50%)" }}
                    >
                      {/* Label above the tick — "fade 2s" */}
                      <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 text-[9px] text-white/50 whitespace-nowrap leading-none">
                        fade {sound.musicFadeOut}
                      </span>
                      {/* Tick */}
                      <div className="h-3 w-0.5 bg-white/70 mx-auto" />
                    </div>
                  );
                })()}
              </div>

              {/* Elapsed / total timer */}
              <span
                ref={elapsedLabelRef}
                className="text-sm text-[#e5e5e5] flex-shrink-0 tabular-nums font-mono"
              >
                {`${fmtMs(0)} / ${fmtMs(totalMs)}`}
              </span>
            </div>

            {/* #51: transient note when a clip's proxy was missing and we fell back to the source file */}
            {proxyFallbackNote && (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-[#1a1a1a] border border-white/15 border-l-2 border-l-[#FF8A65] rounded-md shadow-lg pointer-events-none">
                <p className="text-sm text-[#e5e5e5] whitespace-nowrap">Optimised preview missing for one clip -- using the original file.</p>
              </div>
            )}
          </div>

          {/* Right sidebar: music controls */}
          <div className="w-52 flex-shrink-0 border-l border-white/10 overflow-y-auto">
            <div className="p-4 space-y-6">

              {/* Current music selection */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a3a3a3] mb-2">Music</p>
                {sound.mood === "none" ? (
                  <p className="text-sm text-[#a3a3a3]">None &mdash; set in Music tab</p>
                ) : sound.mood === "custom" ? (
                  <p className="text-sm text-[#e5e5e5] truncate">
                    {sound.customPath?.split("\\").pop() ?? "Custom track"}
                  </p>
                ) : (
                  <p className="text-sm font-medium text-[#e5e5e5]">
                    {LIBRARY_MOODS.find((m) => m.value === sound.mood)?.label}
                  </p>
                )}
              </div>

              {/* Volume */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a3a3a3] mb-2">Volume</p>
                <div className="flex flex-col gap-2">
                  {VOLUMES.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-volume-${value}`}
                      onClick={() => handleVolume(value)}
                      className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium text-left ${
                        sound.volume === value
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-xs text-[#a3a3a3]">
                Settings saved automatically.{sound.musicFadeOut !== "none" ? ` Fade-out: ${sound.musicFadeOut}.` : ""}
              </p>
            </div>
          </div>
        </div>
      </div>
    </EditorShell>
  );
}
