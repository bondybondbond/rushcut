import { useState } from "react";
import { JobConfig } from "@/types/project";

const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  transition: "crossfade",
  zoom: false,
  intro_text: "",
  intro_color: "#000000",
  outro_text: "",
  outro_color: "#000000",
  filter_boring: false,
};

const MUSIC_MOODS: { label: string; value: JobConfig["music_mood"] }[] = [
  { label: "No Music", value: "none" },
  { label: "Cinematic", value: "cinematic" },
  { label: "Upbeat", value: "upbeat" },
  { label: "Chill", value: "chill" },
  { label: "Electronic", value: "electronic" },
];

interface Props {
  projectId: string;
  onConfigChange: (config: JobConfig) => void;
}

export function ConfigurePanel({ onConfigChange }: Props) {
  const [config, setConfig] = useState<JobConfig>(DEFAULT_CONFIG);

  function update(patch: Partial<JobConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    onConfigChange(next);
  }

  const row = "border border-white/15 rounded-lg p-5";
  const label = "text-[#e5e5e5] text-base font-medium mb-1";
  const sublabel = "text-[#a3a3a3] text-sm mb-3";

  function Chip({
    active,
    onClick,
    children,
  }: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`text-sm rounded-md px-3.5 py-1.5 border transition-all duration-200 font-medium ${
          active
            ? "border-[#FF8A65] text-[#FF8A65] bg-[#FF8A65]/10"
            : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
        }`}
      >
        {children}
      </button>
    );
  }

  function Toggle({
    checked,
    onChange,
  }: {
    checked: boolean;
    onChange: (v: boolean) => void;
  }) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
          checked ? "bg-[#22c55e]" : "bg-white/25"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    );
  }

  return (
    <div className="space-y-4">
      {/* Music */}
      <div className={row}>
        <p className={label}>Music</p>
        <p className={sublabel}>Background track for your edit.</p>
        <div className="flex flex-wrap gap-2">
          {MUSIC_MOODS.map(({ label: l, value }) => (
            <Chip
              key={value}
              active={config.music_mood === value}
              onClick={() => update({ music_mood: value })}
            >
              {l}
            </Chip>
          ))}
        </div>
      </div>

      {/* Zoom */}
      <div className={row}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Ken Burns Zoom</p>
            <p className={sublabel + " mb-0"}>Subtle zoom on clips.</p>
          </div>
          <Toggle checked={config.zoom} onChange={(v) => update({ zoom: v })} />
        </div>
      </div>

      {/* Intro text */}
      <div className={row}>
        <p className={label}>Intro Card</p>
        <p className={sublabel}>Title card at the start. Leave blank to skip.</p>
        <input
          type="text"
          placeholder="Enter title..."
          value={config.intro_text}
          onChange={(e) => update({ intro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
        />
      </div>

      {/* Outro text */}
      <div className={row}>
        <p className={label}>Outro Card</p>
        <p className={sublabel}>Card at the end. Leave blank to skip.</p>
        <input
          type="text"
          placeholder="Enter text..."
          value={config.outro_text}
          onChange={(e) => update({ outro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
        />
      </div>
    </div>
  );
}
