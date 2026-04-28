import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectWithClips } from "@/types/project";
import { StepNav } from "@/components/StepNav";

type MusicMood = "none" | "cinematic" | "upbeat" | "chill" | "electronic";
type MusicVolume = "subtle" | "balanced" | "prominent";

interface SoundState {
  mood: MusicMood;
  volume: MusicVolume;
}

const MOODS: { value: MusicMood; label: string; description: string }[] = [
  { value: "none",       label: "No Music",   description: "Film renders without a music track." },
  { value: "cinematic",  label: "Cinematic",  description: "Epic orchestral score — great for travel and nature." },
  { value: "upbeat",     label: "Upbeat",     description: "Energetic and positive — great for action and sport." },
  { value: "chill",      label: "Chill",      description: "Laid-back and warm — great for everyday memories." },
  { value: "electronic", label: "Electronic", description: "Driving synth beats — great for fast-cut montages." },
];

const VOLUMES: { value: MusicVolume; label: string }[] = [
  { value: "subtle",    label: "Subtle" },
  { value: "balanced",  label: "Balanced" },
  { value: "prominent", label: "Prominent" },
];

const DEFAULT_SOUND: SoundState = { mood: "none", volume: "balanced" };

function readStorage(key: string): SoundState {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return DEFAULT_SOUND;
    const parsed = JSON.parse(raw) as Partial<SoundState>;
    const VALID_MOODS: MusicMood[] = ["none", "cinematic", "upbeat", "chill", "electronic"];
    const VALID_VOLUMES: MusicVolume[] = ["subtle", "balanced", "prominent"];
    return {
      mood: VALID_MOODS.includes(parsed.mood as MusicMood) ? (parsed.mood as MusicMood) : DEFAULT_SOUND.mood,
      volume: VALID_VOLUMES.includes(parsed.volume as MusicVolume) ? (parsed.volume as MusicVolume) : DEFAULT_SOUND.volume,
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

  const storageKey = `rc_sound_${projectId}`;
  const [sound, setSound] = useState<SoundState>(() => readStorage(storageKey));

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setProjectName(data.project.name);
        setClipCount(data.clips.filter((c) => c.include !== 0).length);
      })
      .catch(() => {});
  }, [projectId]);

  function handleMood(mood: MusicMood) {
    const next = { ...sound, mood };
    setSound(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  }

  function handleVolume(volume: MusicVolume) {
    const next = { ...sound, volume };
    setSound(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <StepNav
        active="sound"
        projectId={projectId}
        nextLabel="Next: Render"
        onNext={() => navigate(`/editor/${projectId}`)}
        nextDisabled={false}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">

          {/* Header */}
          <div>
            <h1 className="text-3xl font-semibold text-[#FF8A65]">Sound</h1>
            <p className="text-base text-[#a3a3a3] mt-1">
              {projectName
                ? `${projectName} · ${clipCount} clip${clipCount !== 1 ? "s" : ""}`
                : "Loading…"}
            </p>
          </div>

          {/* Music mood picker */}
          <div className="border border-white/15 rounded-lg p-6 space-y-4">
            <div>
              <p className="text-xl font-medium text-[#e5e5e5]">Music</p>
              <p className="text-sm text-[#a3a3a3] mt-0.5">
                Choose a music mood for your film, or leave it silent.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {MOODS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`chip-mood-${value}`}
                  onClick={() => handleMood(value)}
                  className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                    sound.mood === value
                      ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                      : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Description of selected mood */}
            <p className="text-sm text-[#a3a3a3]">
              {MOODS.find((m) => m.value === sound.mood)?.description}
            </p>

            {/* Volume — conditional on mood !== "none" */}
            {sound.mood !== "none" && (
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

          {/* Footer info */}
          <p className="text-sm text-[#a3a3a3]">
            Your choice is saved automatically. Continue to Render to build your film.
          </p>

        </div>
      </div>
    </div>
  );
}
