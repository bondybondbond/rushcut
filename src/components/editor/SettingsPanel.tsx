"use client";

import { JobConfig } from "@/types/project";

const CARD_COLORS = [
  { label: "White", value: "#ffffff" },
  { label: "Black", value: "#000000" },
  { label: "Navy", value: "#1a1a2e" },
];

const musicEnabled = process.env.NEXT_PUBLIC_MUSIC_ENABLED === "true";

interface Props {
  config: JobConfig;
  onChange: (config: JobConfig) => void;
}

export function SettingsPanel({ config, onChange }: Props) {
  function update(patch: Partial<JobConfig>) {
    onChange({ ...config, ...patch });
  }

  function toggleCard(field: "intro_card" | "end_card", enabled: boolean) {
    update({ [field]: enabled ? { enabled: true, text: "", color: "#ffffff" } : null });
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
          checked ? "bg-[#FF8A65]" : "bg-white/25"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-[#0a0a0a] transition-transform duration-200 ${
            checked ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[#a3a3a3] text-xs uppercase tracking-wider font-medium mb-4">Settings</p>

      {/* Transition */}
      <div className={row}>
        <p className={label}>Transition</p>
        <div className="flex gap-2">
          {(["crossfade", "dip_to_black"] as const).map((t) => (
            <Chip key={t} active={config.transition === t} onClick={() => update({ transition: t })}>
              {t === "crossfade" ? "Crossfade" : "Dip to black"}
            </Chip>
          ))}
        </div>
      </div>

      {/* Silence removal */}
      <div className={row}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Silence removal</p>
            <p className={sublabel + " mb-0"}>Trim silent gaps automatically.</p>
          </div>
          <Toggle checked={config.silence_removal} onChange={(v) => update({ silence_removal: v })} />
        </div>
      </div>

      {/* Intro card */}
      <div className={row}>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className={label}>Intro card</p>
            <p className={sublabel + " mb-0"}>3-second title card at the start.</p>
          </div>
          <Toggle checked={!!config.intro_card} onChange={(v) => toggleCard("intro_card", v)} />
        </div>
        {config.intro_card && (
          <div className="space-y-2 pt-2 border-t border-white/10">
            <input
              type="text"
              placeholder="Enter title..."
              value={config.intro_card.text}
              onChange={(e) => update({ intro_card: { ...config.intro_card!, text: e.target.value } })}
              className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
            />
            <div className="flex items-center gap-2">
              <span className="text-[#a3a3a3] text-xs">Color</span>
              {CARD_COLORS.map(({ label: l, value }) => (
                <button
                  key={value}
                  type="button"
                  title={l}
                  onClick={() => update({ intro_card: { ...config.intro_card!, color: value } })}
                  className={`w-4 h-4 rounded-full border-2 transition-all duration-200 ${
                    config.intro_card?.color === value ? "border-[#e5e5e5] scale-110" : "border-white/20"
                  }`}
                  style={{ backgroundColor: value }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* End card */}
      <div className={row}>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className={label}>End card</p>
            <p className={sublabel + " mb-0"}>3-second card at the end.</p>
          </div>
          <Toggle checked={!!config.end_card} onChange={(v) => toggleCard("end_card", v)} />
        </div>
        {config.end_card && (
          <div className="space-y-2 pt-2 border-t border-white/10">
            <input
              type="text"
              placeholder="Enter text..."
              value={config.end_card.text}
              onChange={(e) => update({ end_card: { ...config.end_card!, text: e.target.value } })}
              className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
            />
            <div className="flex items-center gap-2">
              <span className="text-[#a3a3a3] text-xs">Color</span>
              {CARD_COLORS.map(({ label: l, value }) => (
                <button
                  key={value}
                  type="button"
                  title={l}
                  onClick={() => update({ end_card: { ...config.end_card!, color: value } })}
                  className={`w-4 h-4 rounded-full border-2 transition-all duration-200 ${
                    config.end_card?.color === value ? "border-[#e5e5e5] scale-110" : "border-white/20"
                  }`}
                  style={{ backgroundColor: value }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Music */}
      <div className={row}>
        <p className={label}>Music</p>
        {!musicEnabled ? (
          <p className="text-[#555555] text-xs">Coming soon</p>
        ) : (
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
        )}
      </div>
    </div>
  );
}
