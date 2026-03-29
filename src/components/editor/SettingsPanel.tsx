import { JobConfig } from "@/types/project";

const CARD_COLORS = [
  { label: "Black", value: "#000000" },
  { label: "White", value: "#ffffff" },
  { label: "Navy", value: "#1a1a2e" },
  { label: "Sand", value: "#C9A96E" },
];

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
    testId,
    children,
  }: {
    active: boolean;
    onClick: () => void;
    testId?: string;
    children: React.ReactNode;
  }) {
    return (
      <button
        type="button"
        data-testid={testId}
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

  function ColorSwatch({
    color,
    selected,
    label: swatchLabel,
    onSelect,
    testId,
  }: {
    color: string;
    selected: boolean;
    label: string;
    onSelect: () => void;
    testId?: string;
  }) {
    return (
      <button
        type="button"
        data-testid={testId}
        title={swatchLabel}
        onClick={onSelect}
        className={`w-7 h-7 rounded-full border-2 transition-all ${
          selected ? "border-[#FF8A65] scale-110" : "border-white/20 hover:border-white/50"
        }`}
        style={{ backgroundColor: color }}
      />
    );
  }

  function TrashBtn({ onClick }: { onClick: () => void }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="p-1 text-red-400 hover:bg-red-400/10 rounded transition-colors"
        aria-label="Remove card"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
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
              testId={`chip-music-${mood}`}
              active={config.music_mood === mood}
              onClick={() => update({ music_mood: mood })}
            >
              {mood === "none" ? "No Music" : mood.charAt(0).toUpperCase() + mood.slice(1)}
            </Chip>
          ))}
        </div>
        {config.music_mood !== "none" && (
          <div className="mt-3 flex items-center gap-3">
            <span className="text-xs text-[#a3a3a3] shrink-0">Volume</span>
            <div className="flex gap-2">
              {(["subtle", "balanced", "prominent"] as const).map((level) => (
                <Chip
                  key={level}
                  testId={`chip-volume-${level}`}
                  active={config.music_volume === level}
                  onClick={() => update({ music_volume: level })}
                >
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Transition effect */}
      <div className={row}>
        <p className={label}>Transition effect</p>
        <div className="flex gap-2">
          <Chip
            testId="chip-transition-none"
            active={config.transition === "none"}
            onClick={() => update({ transition: "none" })}
          >
            None
          </Chip>
          <Chip
            testId="chip-transition-crossfade"
            active={config.transition === "crossfade"}
            onClick={() => update({ transition: "crossfade" })}
          >
            Crossfade
          </Chip>
          <Chip
            testId="chip-transition-dip-to-black"
            active={config.transition === "dip_to_black"}
            onClick={() => update({ transition: "dip_to_black" })}
          >
            Dip to black
          </Chip>
        </div>
      </div>

      {/* Smart clip selection (filter_boring) */}
      <div className={row}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Smart Clip Selection</p>
            <p className={sublabel + " mb-0"}>
              Auto-exclude static clips. Keep best 20 by motion score.
            </p>
          </div>
          <button
            type="button"
            data-testid="toggle-filter-boring"
            onClick={() => update({ filter_boring: !config.filter_boring })}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              config.filter_boring ? "bg-[#FF8A65]" : "bg-white/25"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                config.filter_boring ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Ken Burns Zoom — disabled, coming soon */}
      <div className={`${row} opacity-50`}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Ken Burns Zoom</p>
            <p className={sublabel + " mb-0"}>
              Subtle zoom on clips.{" "}
              <span className="text-[#C9A96E]">Coming soon.</span>
            </p>
          </div>
          <div
            className="relative inline-flex h-5 w-9 items-center rounded-full bg-white/25 cursor-not-allowed"
            title="Coming soon"
          >
            <span className="inline-block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-white" />
          </div>
        </div>
      </div>

      {/* Intro card */}
      <div className={row}>
        <div className="flex items-center justify-between mb-1">
          <p className={label + " mb-0"}>Intro Card</p>
          {config.intro_text && (
            <TrashBtn onClick={() => update({ intro_text: "", intro_color: "#000000" })} />
          )}
        </div>
        <p className={sublabel}>Leave blank to skip.</p>
        <input
          data-testid="input-intro-text"
          type="text"
          placeholder="Enter title..."
          value={config.intro_text}
          onChange={(e) => update({ intro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder:text-[#555555] focus:outline-none focus:border-white/40 mb-3"
        />
        {config.intro_text && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#a3a3a3]">Background</span>
            {CARD_COLORS.map((c) => (
              <ColorSwatch
                key={c.value}
                testId={`swatch-intro-${c.label.toLowerCase()}`}
                color={c.value}
                label={c.label}
                selected={config.intro_color === c.value}
                onSelect={() => update({ intro_color: c.value })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Outro card */}
      <div className={row}>
        <div className="flex items-center justify-between mb-1">
          <p className={label + " mb-0"}>Outro Card</p>
          {config.outro_text && (
            <TrashBtn onClick={() => update({ outro_text: "", outro_color: "#000000" })} />
          )}
        </div>
        <p className={sublabel}>Leave blank to skip.</p>
        <input
          data-testid="input-outro-text"
          type="text"
          placeholder="Enter text..."
          value={config.outro_text}
          onChange={(e) => update({ outro_text: e.target.value })}
          className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder:text-[#555555] focus:outline-none focus:border-white/40 mb-3"
        />
        {config.outro_text && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#a3a3a3]">Background</span>
            {CARD_COLORS.map((c) => (
              <ColorSwatch
                key={c.value}
                testId={`swatch-outro-${c.label.toLowerCase()}`}
                color={c.value}
                label={c.label}
                selected={config.outro_color === c.value}
                onSelect={() => update({ outro_color: c.value })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Output info */}
      <p className="text-xs text-[#a3a3a3] pt-1">
        Your clips will be processed at 1080p.{" "}
        <span
          title="4K processing is coming soon."
          className="text-[#C9A96E] cursor-help underline decoration-dotted"
        >
          4K coming soon
        </span>
      </p>
    </div>
  );
}
