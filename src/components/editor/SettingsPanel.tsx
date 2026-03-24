import { JobConfig } from "@/types/project";

interface Props {
  config: JobConfig;
  onChange: (config: JobConfig) => void;
}

export function SettingsPanel({ config, onChange }: Props) {
  function update(patch: Partial<JobConfig>) {
    onChange({ ...config, ...patch });
  }

  const row = "border border-white/15 rounded-lg p-4";
  const label = "text-[#e5e5e5] text-sm font-medium mb-1";
  const sublabel = "text-[#a3a3a3] text-xs mb-3";

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
        className={`text-xs rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
          active
            ? "border-[#FF8A65] text-[#FF8A65] bg-[#FF8A65]/10"
            : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
        }`}
      >
        {children}
      </button>
    );
  }

  function Toggle({ checked, onChange: onToggle }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onToggle(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ${
          checked ? "bg-[#22c55e]" : "bg-white/25"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200 ${
            checked ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[#a3a3a3] text-xs uppercase tracking-wider font-medium mb-4">Settings</p>

      {/* Music */}
      <div className={row}>
        <p className={label}>Music</p>
        <div className="flex flex-wrap gap-2">
          {(["none", "cinematic", "upbeat", "chill", "electronic"] as const).map((mood) => (
            <Chip
              key={mood}
              active={config.music_mood === mood}
              onClick={() => update({ music_mood: mood })}
            >
              {mood === "none" ? "No Music" : mood.charAt(0).toUpperCase() + mood.slice(1)}
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

      {/* Intro */}
      <div className={row}>
        <p className={label}>Intro Card</p>
        <p className={sublabel}>Leave blank to skip.</p>
        <input
          type="text"
          placeholder="Enter title..."
          value={config.intro_text}
          onChange={(e) => update({ intro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
        />
      </div>

      {/* Outro */}
      <div className={row}>
        <p className={label}>Outro Card</p>
        <p className={sublabel}>Leave blank to skip.</p>
        <input
          type="text"
          placeholder="Enter text..."
          value={config.outro_text}
          onChange={(e) => update({ outro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
        />
      </div>
    </div>
  );
}
