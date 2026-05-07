import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProjectWithClips } from "@/types/project";
import { StepNav } from "@/components/StepNav";

type MusicMood = "none" | "cinematic" | "upbeat" | "chill" | "electronic" | "custom";
type LibraryMood = "cinematic" | "upbeat" | "chill" | "electronic";
type MusicSource = "none" | "library" | "custom";
type MusicVolume = "subtle" | "balanced" | "prominent";

interface SoundState {
  mood: MusicMood;
  volume: MusicVolume;
  customPath?: string;
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

const DEFAULT_SOUND: SoundState = { mood: "none", volume: "balanced" };
const PREVIEW_DURATION_MS = 30_000;

function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
    return {
      mood,
      volume: VALID_VOLUMES.includes(parsed.volume as MusicVolume) ? (parsed.volume as MusicVolume) : DEFAULT_SOUND.volume,
      customPath: typeof parsed.customPath === "string" ? parsed.customPath : undefined,
    };
  } catch {
    return DEFAULT_SOUND;
  }
}

export default function Sound() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [clipCount, setClipCount] = useState(0);
  const [filmDurationMs, setFilmDurationMs] = useState(0);
  const [musicDir, setMusicDir] = useState<string | null>(null);
  const [trackDurations, setTrackDurations] = useState<Partial<Record<LibraryMood, number>>>({});
  const [customDurationMs, setCustomDurationMs] = useState<number | null>(null);
  const [previewingMood, setPreviewingMood] = useState<LibraryMood | null>(null);
  const [previewingCustom, setPreviewingCustom] = useState(false);

  const storageKey = `rc_sound_${projectId}`;
  const [sound, setSound] = useState<SoundState>(() => readStorage(storageKey));

  const audioRef = useRef<HTMLAudioElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probedRef = useRef(false);

  const source = deriveSource(sound.mood);
  const libraryMood = deriveLibraryMood(sound.mood);

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setProjectName(data.project.name);
        const included = data.clips.filter((c) => c.include !== 0);
        setClipCount(included.length);
        const durMs = included.reduce(
          (sum, c) => sum + (c.out_ms ?? c.duration_ms) - (c.in_ms ?? 0),
          0
        );
        setFilmDurationMs(durMs);
      })
      .catch(() => {});
    invoke<string>("get_music_dir_cmd")
      .then((dir) => {
        if (!dir) return;
        setMusicDir(dir);
        // Gate against re-runs on hot reload / re-mount
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
    };
  }, []);

  function stopPreview() {
    audioRef.current?.pause();
    setPreviewingMood(null);
    setPreviewingCustom(false);
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
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

  function handleVolume(volume: MusicVolume) {
    persist({ ...sound, volume });
    if (audioRef.current && (previewingMood || previewingCustom)) {
      audioRef.current.volume = VOLUME_LEVELS[volume];
    }
  }

  async function handleCustomTrack() {
    stopPreview();
    const result = await open({ filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aac", "flac"] }] });
    if (!result) return;
    const customPath = typeof result === "string" ? result : Array.isArray(result) ? result[0] : null;
    if (!customPath) return;
    persist({ ...sound, mood: "custom", customPath });
    // Probe duration via audioRef — reuse existing element, no second Audio object
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

  // Comparison line — derived above return to avoid JSX IIFE
  const selectedTrackMs =
    source === "library" && libraryMood && trackDurations[libraryMood] !== undefined
      ? trackDurations[libraryMood]! * 1000
      : source === "custom" && customDurationMs !== null
      ? customDurationMs
      : null;

  const showComparison = source !== "none" && filmDurationMs > 0 && selectedTrackMs !== null;

  const loopNote: React.ReactNode =
    !showComparison ? null
    : selectedTrackMs! >= filmDurationMs
    ? <span className="text-[#22c55e]"> &mdash; long enough</span>
    : <span> &mdash; will loop ~{Math.ceil(filmDurationMs / selectedTrackMs!)}x</span>;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <audio ref={audioRef} />

      <StepNav
        active="sound"
        projectId={projectId}
        nextLabel="Next: Render"
        onNext={() => { stopPreview(); navigate(`/render/${projectId}`); }}
        nextDisabled={false}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">

          {/* Header */}
          <div>
            <h1 className="text-3xl font-semibold text-[#FF8A65]">Sound</h1>
            <p className="text-base text-[#a3a3a3] mt-1">
              {projectName
                ? `${projectName} · ${clipCount} clip${clipCount !== 1 ? "s" : ""}${filmDurationMs > 0 ? ` · ${fmtMs(filmDurationMs)}` : ""}`
                : "Loading..."}
            </p>
          </div>

          {/* Music picker card */}
          <div className="border border-white/15 rounded-lg p-6 space-y-4">
            <div>
              <p className="text-xl font-medium text-[#e5e5e5]">Music</p>
              <p className="text-sm text-[#a3a3a3] mt-0.5">
                Choose a music source for your film, or leave it silent.
              </p>
            </div>

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

            {/* Library mood sub-chips — expand when Rushcut Library is selected */}
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

            {/* Stop preview link — visible only while a library mood preview is playing */}
            {previewingMood && (
              <button
                onClick={stopPreview}
                className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] cursor-pointer transition-colors"
              >
                Stop preview
              </button>
            )}

            {/* Description of selected source / mood */}
            {moodDescription && (
              <p className="text-sm text-[#a3a3a3]">{moodDescription}</p>
            )}

            {/* Film vs track duration comparison */}
            {showComparison && (
              <p className="text-sm text-[#a3a3a3]">
                Film: {fmtMs(filmDurationMs)} &middot; Track: {fmtMs(selectedTrackMs!)}{loopNote}
              </p>
            )}

            {/* Volume row — visible when any music source is selected */}
            {source !== "none" && (
              <div className="pt-2 border-t border-white/10 space-y-3">
                <div>
                  <p className="text-base font-medium text-[#e5e5e5]">Volume</p>
                  <p className="text-sm text-[#a3a3a3] mt-0.5">
                    How prominent should the music be in the mix?
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  {VOLUMES.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-volume-${value}`}
                      onClick={() => handleVolume(value)}
                      className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
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
            )}
          </div>

          {/* Footer */}
          <p className="text-sm text-[#a3a3a3]">
            Your choice is saved automatically. Continue to Render to build your film.
          </p>

        </div>
      </div>
    </div>
  );
}
