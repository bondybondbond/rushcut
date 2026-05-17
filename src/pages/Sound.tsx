import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Clip, ProjectWithClips } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { fmtMs } from "@/utils/fmtMs";
import { projectCache } from "@/utils/projectCache";

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

const DEFAULT_SOUND: SoundState = { mood: "none", volume: "balanced", musicFadeOut: "2s" };
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
    const raw = sessionStorage.getItem(key);
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

  // Rough-mix playback refs
  const filmVideoRef = useRef<HTMLVideoElement>(null);   // cycles through included clips
  const musicAudioRef = useRef<HTMLAudioElement>(null);  // music track during rough mix
  const filmPlayingRef = useRef(false);                  // imperative flag (avoids stale closures)
  const filmPlayIdxRef = useRef(0);                      // current clip index (fast access)
  const clipStartMsRef = useRef(0);                      // cumulative film-time at current clip start
  const inFilmRef = useRef<typeof inFilm>([]);           // stable ref for event callbacks
  const loadedClipIdxRef = useRef(-1);                  // which clip index is currently loaded in filmVideoRef
  const progressBarFillRef = useRef<HTMLDivElement>(null); // imperative progress bar fill (avoids re-render)
  const elapsedLabelRef = useRef<HTMLSpanElement>(null);   // imperative elapsed-time label
  const isAdvancingRef = useRef(false);                    // guard against double-advance (onEnded + timeupdate race)
  const hasPlayedRef = useRef(false);                       // true once playback has started; hides "Press play" overlay after film ends

  // Rough-mix playback state
  const [isFilmPlaying, setIsFilmPlaying] = useState(false);
  const [isFilmPaused, setIsFilmPaused] = useState(false);
  const [filmPlayIdx, setFilmPlayIdx] = useState(0);    // drives "Clip N / M" label

  const configured = useConfiguredTabs(projectId ?? "");

  const source = deriveSource(sound.mood);
  const libraryMood = deriveLibraryMood(sound.mood);

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  // Keep inFilmRef current so playback callbacks always read the latest clip list
  // without needing to re-subscribe on every render.
  inFilmRef.current = inFilm;

  const transitionVal = (() => {
    try { return sessionStorage.getItem(`rc_transition_${projectId}`) ?? null; } catch { return null; }
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

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
      // Stop rough-mix playback on route leave
      filmVideoRef.current?.pause();
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

  function loadAndPlayClip(idx: number) {
    const clip = inFilmRef.current[idx];
    const v = filmVideoRef.current;
    if (!clip || !v) return;
    // Source rule: proxy if present (already H.264), else local path
    const src = convertFileSrc(clip.proxy_path ?? clip.local_path);
    v.src = src;
    v.volume = Math.min(1, clip.clip_volume ?? 1.0);
    loadedClipIdxRef.current = idx;
    console.log(`[rough-mix] loadAndPlayClip idx=${idx} src=${src.slice(-40)} vol=${v.volume}`);
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = (clip.in_ms ?? 0) / 1000;
      v.play().catch(() => {});
    }, { once: true });
    v.load();
  }

  function advanceFilmClipRough() {
    // Guard: onEnded + timeupdate can both fire near boundary — only advance once
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

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
      isAdvancingRef.current = false;
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

    filmPlayIdxRef.current = nextIdx;
    setFilmPlayIdx(nextIdx);
    loadAndPlayClip(nextIdx);
    // Reset guard after new clip has had time to load + start emitting events
    setTimeout(() => { isAdvancingRef.current = false; }, 250);
  }

  function handleFilmTimeUpdate() {
    const v = filmVideoRef.current;
    if (!v || !filmPlayingRef.current) return;
    const clip = inFilmRef.current[filmPlayIdxRef.current];
    if (!clip) return;

    // Respect user trim out_ms — onEnded fires at the END of the source file,
    // not at the user's trim point. Without this, the film plays past where it
    // ends in the Trimmer Film tab.
    const outSec = (clip.out_ms ?? clip.duration_ms) / 1000;
    if (v.currentTime >= outSec) {
      advanceFilmClipRough();
      return;
    }

    const offsetInClip = Math.max(0, v.currentTime - (clip.in_ms ?? 0) / 1000) * 1000;
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
        console.log(
          `[rough-mix] FADE clip=${filmPlayIdxRef.current} t=${v.currentTime.toFixed(2)} ` +
          `elapsedMs=${Math.round(elapsedMs)} remainingMs=${Math.round(remainingMs)} fadeMs=${fadeMs}`,
        );
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
        // No loop in V1 — looping independently of the film makes fade-out semantics muddy
        ma.loop = false;
        ma.volume = MUSIC_VOLUME[sound.volume];
        ma.currentTime = 0;
        console.log(`[rough-mix] music src=${src.slice(-40)} volume=${ma.volume}`);
        ma.play().catch(() => {});
      }
    }
    loadAndPlayClip(0);
  }

  function pauseFilmPlayback() {
    filmPlayingRef.current = false;
    filmVideoRef.current?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(true);
  }

  function resumeFilmPlayback() {
    filmPlayingRef.current = true;
    filmVideoRef.current?.play().catch(() => {});
    musicAudioRef.current?.play().catch(() => {});
    setIsFilmPlaying(true);
    setIsFilmPaused(false);
  }

  function stopFilmPlayback() {
    filmPlayingRef.current = false;
    filmVideoRef.current?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(false);
    filmPlayIdxRef.current = 0;
    clipStartMsRef.current = 0;
    loadedClipIdxRef.current = -1;
    setFilmPlayIdx(0);
    if (progressBarFillRef.current) progressBarFillRef.current.style.width = "0%";
    if (elapsedLabelRef.current) elapsedLabelRef.current.textContent = `${fmtMs(0)} / ${fmtMs(totalMs)}`;
  }

  // Seek to any position in the film. Works from idle, playing, or paused.
  // Music is kept in sync — its currentTime is set to match the film position
  // so seek/jump is an accurate preview of how music would play at that moment.
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
    const seekSec = (clip.in_ms ?? 0) / 1000 + (clamped - acc) / 1000;

    // Update tracking refs + visual indicators immediately
    filmPlayIdxRef.current = idx;
    clipStartMsRef.current = acc;
    setFilmPlayIdx(idx);
    if (progressBarFillRef.current && totalMs > 0) {
      progressBarFillRef.current.style.width = `${(clamped / totalMs) * 100}%`;
    }
    if (elapsedLabelRef.current) {
      elapsedLabelRef.current.textContent = `${fmtMs(clamped)} / ${fmtMs(totalMs)}`;
    }

    const wasIdle = !filmPlayingRef.current && !isFilmPaused;
    const ma = musicAudioRef.current;

    if (wasIdle && ma && sound.mood !== "none") {
      // Starting fresh from idle — load music
      const src =
        sound.mood === "custom" && sound.customPath
          ? convertFileSrc(sound.customPath)
          : musicDir
          ? convertFileSrc(musicDir + "\\" + sound.mood + ".mp3")
          : null;
      if (src) {
        ma.src = src;
        ma.loop = false;
        ma.load();
      }
    }

    // Sync music position to film position — fixes "music doesn't reflect fade
    // when user seeks ahead" and "music silent after fade-out then seek back".
    if (ma) {
      // Reset volume to base — handleFilmTimeUpdate will re-apply fade if in fade zone
      ma.volume = MUSIC_VOLUME[sound.volume];
      const trySync = () => {
        try { ma.currentTime = Math.min(clamped / 1000, ma.duration || clamped / 1000); }
        catch { /* music may not be loaded yet */ }
      };
      if (ma.readyState >= 1) trySync();
      else ma.addEventListener("loadedmetadata", trySync, { once: true });
    }

    if (wasIdle) {
      hasPlayedRef.current = true;
      filmPlayingRef.current = true;
      setIsFilmPlaying(true);
      setIsFilmPaused(false);
      if (ma && sound.mood !== "none") ma.play().catch(() => {});
    }

    const v = filmVideoRef.current;
    if (!v) return;
    v.volume = Math.min(1, clip.clip_volume ?? 1.0);

    if (loadedClipIdxRef.current === idx) {
      // Same clip — just seek the video
      v.currentTime = seekSec;
      if (filmPlayingRef.current) v.play().catch(() => {});
    } else {
      // Different clip — load it then seek
      loadedClipIdxRef.current = idx;
      const src = convertFileSrc(clip.proxy_path ?? clip.local_path);
      v.addEventListener("loadedmetadata", () => {
        v.currentTime = seekSec;
        if (filmPlayingRef.current) v.play().catch(() => {});
      }, { once: true });
      v.src = src;
      v.load();
    }
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
    sessionStorage.setItem(storageKey, JSON.stringify(next));
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

  const showComparison = source !== "none" && totalMs > 0 && selectedTrackMs !== null;

  const loopNote: React.ReactNode =
    !showComparison ? null
    : selectedTrackMs! >= totalMs
    ? <span className="text-[#22c55e]"> &mdash; long enough</span>
    : <span> &mdash; will loop ~{Math.ceil(totalMs / selectedTrackMs!)}x</span>;

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={totalMs}
      activeTab="sound"
      configured={configured}
      transitionValue={transitionVal}
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
                  Film: {fmtMs(totalMs)} &middot; Track: {fmtMs(selectedTrackMs!)}{loopNote}
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

            <p className="text-sm text-[#a3a3a3]">
              Settings are saved automatically. Head to Master to preview with music.
            </p>
          </div>
        </div>

        {/* ── Master mixer tab — full film preview + music controls ── */}
        <div className={musicTab === "mixer" ? "flex flex-1 min-h-0" : "hidden"}>

          {/* Center: video player + controls bar */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Video area — click anywhere to pause/resume (matches Trimmer Film tab) */}
            <div className="flex-1 bg-black flex items-center justify-center min-h-0 relative">
              <video
                ref={filmVideoRef}
                onEnded={advanceFilmClipRough}
                onTimeUpdate={handleFilmTimeUpdate}
                onClick={
                  isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : inFilm.length > 0 ? startFilmPlayback
                  : undefined
                }
                className={`max-h-full max-w-full object-contain ${inFilm.length > 0 ? "cursor-pointer" : ""}`}
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
            </div>

            {/* Controls bar */}
            <div className="flex items-center gap-3 px-4 py-3 border-t border-white/10 flex-shrink-0">
              {/* Play / Pause button */}
              <button
                disabled={inFilm.length === 0}
                onClick={
                  isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : startFilmPlayback
                }
                className="w-8 h-8 flex items-center justify-center rounded-full bg-[#FF8A65] text-[#0a0a0a] hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              >
                {isFilmPlaying ? (
                  /* Pause — two bars */
                  <svg viewBox="0 0 15 15" fill="currentColor" className="w-3 h-3">
                    <rect x="3.5" y="2" width="2.5" height="11" rx="0.5" />
                    <rect x="9" y="2" width="2.5" height="11" rx="0.5" />
                  </svg>
                ) : (
                  /* Play — teenyicons MIT */
                  <svg viewBox="0 0 15 15" fill="currentColor" className="w-3 h-3">
                    <path d="M4.79062 2.09314C4.63821 1.98427 4.43774 1.96972 4.27121 2.05542C4.10467 2.14112 4 2.31271 4 2.5V12.5C4 12.6873 4.10467 12.8589 4.27121 12.9446C4.43774 13.0303 4.63821 13.0157 4.79062 12.9069L11.7906 7.90687C11.922 7.81301 12 7.66148 12 7.5C12 7.33853 11.922 7.18699 11.7906 7.09314L4.79062 2.09314Z" />
                  </svg>
                )}
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
                className="text-sm text-[#a3a3a3] flex-shrink-0 tabular-nums font-mono"
              >
                {`${fmtMs(0)} / ${fmtMs(totalMs)}`}
              </span>
            </div>
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
