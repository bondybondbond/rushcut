import type { JobConfig, TransitionValue } from "@/types/project";

export const VALID_MOODS = ["none", "cinematic", "upbeat", "chill", "electronic", "custom"] as const;
export const VALID_VOLUMES = ["subtle", "balanced", "prominent"] as const;
export const VALID_TRANSITIONS = ["none", "crossfade", "dip_to_black", "wipe", "wipe_down", "zoom", "dissolve", "barn_door", "band_wipe"] as const;
export const VALID_FADE_OUTS = ["none", "2s", "5s"] as const;

/** Shape stored in rc_transition_${projectId} since M2. Pre-M2 stored a plain string. */
export interface TransitionConfig {
  between: TransitionValue;
  opening: TransitionValue;
  closing: TransitionValue;
  shuffleBetween: boolean;
}

/**
 * Read transition config from sessionStorage.
 * Handles both the legacy plain-string format (pre-M2) and the new JSON format (M2+).
 */
export function readTransitionConfig(projectId: string): TransitionConfig {
  const defaults: TransitionConfig = {
    between: "none",
    opening: "none",
    closing: "none",
    shuffleBetween: false,
  };
  try {
    const raw = sessionStorage.getItem(`rc_transition_${projectId}`);
    if (!raw) return defaults;
    // Compat: pre-M2 stored a plain transition string (e.g. "crossfade")
    if (!raw.startsWith("{")) {
      const val = raw as TransitionValue;
      if ((VALID_TRANSITIONS as readonly string[]).includes(val)) {
        return { ...defaults, between: val };
      }
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<TransitionConfig>;
    return {
      between: (VALID_TRANSITIONS as readonly string[]).includes(parsed.between ?? "")
        ? (parsed.between as TransitionValue)
        : "none",
      opening: (VALID_TRANSITIONS as readonly string[]).includes(parsed.opening ?? "")
        ? (parsed.opening as TransitionValue)
        : "none",
      closing: (VALID_TRANSITIONS as readonly string[]).includes(parsed.closing ?? "")
        ? (parsed.closing as TransitionValue)
        : "none",
      shuffleBetween: parsed.shuffleBetween === true,
    };
  } catch {
    return defaults;
  }
}

export const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  transition: "none",
  opening_transition: "none",
  closing_transition: "none",
  shuffle_between: false,
  intro_text: "",
  intro_subtitle: "",
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
    const tc = readTransitionConfig(projectId);
    config.transition = tc.between;
    config.opening_transition = tc.opening;
    config.closing_transition = tc.closing;
    config.shuffle_between = tc.shuffleBetween;
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
  try {
    config.use_amf = sessionStorage.getItem(`rc_fast_render_${projectId}`) === "1";
  } catch { /* ignore */ }
  try {
    const raw = sessionStorage.getItem(`rc_cards_${projectId}`);
    if (raw) {
      const COLOR_MAP: Record<string, string> = { peach: "#FF8A65", black: "#0a0a0a", white: "#ffffff" };
      const c = JSON.parse(raw) as {
        start?: { enabled?: boolean; title?: string; subtitle?: string; color?: string };
        end?: { enabled?: boolean; title?: string; color?: string };
      };
      if (c.start?.enabled) {
        config.intro_text = c.start.title || "";
        config.intro_subtitle = c.start.subtitle || "";
        config.intro_color = COLOR_MAP[c.start.color ?? ""] ?? "#0a0a0a";
      }
      if (c.end?.enabled) {
        config.outro_text = c.end.title || "";
        config.outro_color = COLOR_MAP[c.end.color ?? ""] ?? "#0a0a0a";
      }
    }
  } catch { /* ignore */ }
  return config;
}
