"use client";

import { useState } from "react";
import { JobConfig } from "@/types/project";

const DEFAULT_CONFIG: JobConfig = {
  transition: "crossfade",
  music_mood: "none",
  silence_removal: true,
  zoom: false,
  intro_card: null,
  end_card: null,
};

const CARD_COLORS = [
  { label: "White", value: "#ffffff" },
  { label: "Black", value: "#000000" },
  { label: "Navy", value: "#1a1a2e" },
];

const MUSIC_MOODS: { label: string; value: JobConfig["music_mood"] }[] = [
  { label: "No Music", value: "none" },
  { label: "Cinematic", value: "cinematic" },
  { label: "Upbeat", value: "upbeat" },
  { label: "Chill", value: "chill" },
  { label: "Electronic", value: "electronic" },
];

const musicEnabled = process.env.NEXT_PUBLIC_MUSIC_ENABLED === "true";

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

  function toggleCard(
    field: "intro_card" | "end_card",
    enabled: boolean
  ) {
    if (!enabled) {
      update({ [field]: null });
    } else {
      update({
        [field]: {
          enabled: true,
          text: "",
          color: "#ffffff",
        },
      });
    }
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
          checked ? "bg-[#FF8A65]" : "bg-white/25"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-[#0a0a0a] transition-transform duration-200 ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    );
  }

  return (
    <div className="space-y-4">
      {/* Transition */}
      <div className={row}>
        <p className={label}>Transition</p>
        <p className={sublabel}>Style of cut between clips.</p>
        <div className="flex gap-2">
          {(["crossfade", "dip_to_black"] as const).map((t) => (
            <Chip
              key={t}
              active={config.transition === t}
              onClick={() => update({ transition: t })}
            >
              {t === "crossfade" ? "Crossfade" : "Dip to black"}
            </Chip>
          ))}
        </div>
      </div>

      {/* Music */}
      <div className={row}>
        <p className={label}>Music</p>
        {!musicEnabled ? (
          <p className="text-[#555555] text-xs">Coming soon</p>
        ) : (
          <>
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
          </>
        )}
      </div>

      {/* Silence removal */}
      <div className={row}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Silence removal</p>
            <p className={sublabel + " mb-0"}>
              Automatically trim silent gaps between clips.
            </p>
          </div>
          <Toggle
            checked={config.silence_removal}
            onChange={(v) => update({ silence_removal: v })}
          />
        </div>
      </div>

      {/* Zoom */}
      <div className={row}>
        <div className="flex items-center justify-between">
          <div>
            <p className={label}>Zoom</p>
            <p className={sublabel + " mb-0"}>
              Slow push-in on key moments. Adds ~30s to render time.
            </p>
          </div>
          <Toggle
            checked={config.zoom}
            onChange={(v) => update({ zoom: v })}
          />
        </div>
      </div>

      {/* Intro card */}
      <div className={row}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className={label}>Intro card</p>
            <p className={sublabel + " mb-0"}>3-second title card at the start.</p>
          </div>
          <Toggle
            checked={!!config.intro_card}
            onChange={(v) => toggleCard("intro_card", v)}
          />
        </div>
        {config.intro_card && (
          <div className="space-y-3 pt-2 border-t border-white/10">
            <input
              type="text"
              placeholder="Enter title..."
              value={config.intro_card.text}
              onChange={(e) =>
                update({
                  intro_card: { ...config.intro_card!, text: e.target.value },
                })
              }
              className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
            />
            <div className="flex items-center gap-2">
              <span className="text-[#a3a3a3] text-xs">Color</span>
              {CARD_COLORS.map(({ label: l, value }) => (
                <button
                  key={value}
                  type="button"
                  title={l}
                  onClick={() =>
                    update({
                      intro_card: { ...config.intro_card!, color: value },
                    })
                  }
                  className={`w-5 h-5 rounded-full border-2 transition-all duration-200 ${
                    config.intro_card?.color === value
                      ? "border-[#e5e5e5] scale-110"
                      : "border-white/20"
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
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className={label}>End card</p>
            <p className={sublabel + " mb-0"}>3-second card at the end.</p>
          </div>
          <Toggle
            checked={!!config.end_card}
            onChange={(v) => toggleCard("end_card", v)}
          />
        </div>
        {config.end_card && (
          <div className="space-y-3 pt-2 border-t border-white/10">
            <input
              type="text"
              placeholder="Enter text..."
              value={config.end_card.text}
              onChange={(e) =>
                update({
                  end_card: { ...config.end_card!, text: e.target.value },
                })
              }
              className="w-full bg-white/5 border border-white/20 rounded px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555555] focus:outline-none focus:border-white/40"
            />
            <div className="flex items-center gap-2">
              <span className="text-[#a3a3a3] text-xs">Color</span>
              {CARD_COLORS.map(({ label: l, value }) => (
                <button
                  key={value}
                  type="button"
                  title={l}
                  onClick={() =>
                    update({
                      end_card: { ...config.end_card!, color: value },
                    })
                  }
                  className={`w-5 h-5 rounded-full border-2 transition-all duration-200 ${
                    config.end_card?.color === value
                      ? "border-[#e5e5e5] scale-110"
                      : "border-white/20"
                  }`}
                  style={{ backgroundColor: value }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
