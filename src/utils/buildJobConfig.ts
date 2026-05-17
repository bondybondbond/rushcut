import type { JobConfig } from "@/types/project";

export const VALID_MOODS = ["none", "cinematic", "upbeat", "chill", "electronic", "custom"] as const;
export const VALID_VOLUMES = ["subtle", "balanced", "prominent"] as const;
export const VALID_TRANSITIONS = ["none", "crossfade", "dip_to_black"] as const;
export const VALID_FADE_OUTS = ["none", "2s", "5s"] as const;

export const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  transition: "none",
  intro_text: "",
  intro_color: "#000000",
  outro_text: "",
  outro_color: "#000000",
  zoom: false,
  filter_boring: true,
  music_volume: "balanced",
};

export function buildJobConfig(projectId: string): JobConfig {
  const config: JobConfig = { ...DEFAULT_CONFIG };
  try {
    const t = sessionStorage.getItem(`rc_transition_${projectId}`);
    if (t && (VALID_TRANSITIONS as readonly string[]).includes(t)) {
      config.transition = t as JobConfig["transition"];
    }
  } catch { /* ignore */ }
  try {
    const raw = sessionStorage.getItem(`rc_sound_${projectId}`);
    if (raw) {
      const s = JSON.parse(raw) as { mood?: string; volume?: string; customPath?: string; musicFadeOut?: string };
      if (s.mood && (VALID_MOODS as readonly string[]).includes(s.mood)) {
        config.music_mood = s.mood as JobConfig["music_mood"];
      }
      if (s.volume && (VALID_VOLUMES as readonly string[]).includes(s.volume)) {
        config.music_volume = s.volume as JobConfig["music_volume"];
      }
      if (s.mood === "custom" && s.customPath) {
        config.custom_music_path = s.customPath;
      }
      if (s.musicFadeOut && (VALID_FADE_OUTS as readonly string[]).includes(s.musicFadeOut)) {
        config.music_fade_out = s.musicFadeOut as "none" | "2s" | "5s";
      }
    }
  } catch { /* ignore */ }
  try {
    const res = sessionStorage.getItem(`rc_render_res_${projectId}`);
    if (res === "1080p" || res === "4k") {
      config.output_resolution = res;
    }
  } catch { /* ignore */ }
  return config;
}
