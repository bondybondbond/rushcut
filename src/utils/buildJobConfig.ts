import type { JobConfig, TransitionValue } from "@/types/project";
import { getRenderPref } from "@/utils/renderStore";

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
 * Read transition config from the render-pref store (localStorage; U1b).
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
    const raw = getRenderPref(`rc_transition_${projectId}`);
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

/** Resolved card colour for a peach/black/white swatch key. */
const CARD_COLOR_MAP: Record<string, string> = { peach: "#FF8A65", black: "#0a0a0a", white: "#ffffff" };

/** One side (open or close) of the cards config, resolved for display + manifest. */
export interface CardSide {
  /** True only when the card is enabled AND has a non-empty title -- mirrors the
   * pipeline render gate `if intro_text:` (render.py). A card with no title never renders. */
  show: boolean;
  /** Trimmed card title. */
  text: string;
  /** Trimmed subtitle (open card only; always "" for close). */
  subtitle: string;
  /** Resolved background hex (#FF8A65 / #0a0a0a / #ffffff). */
  color: string;
}

export interface CardsConfig {
  open: CardSide;
  close: CardSide;
}

/**
 * Read the open/close card config from the render-pref store (localStorage key
 * `rc_cards_${projectId}`). Single source of truth for the enabled+title gate and
 * the colour map -- consumed by buildJobConfig (manifest), the duration model
 * (effectiveFilmMs), and the film-strip card bookends.
 */
export function readCardsConfig(projectId: string): CardsConfig {
  const empty: CardsConfig = {
    open: { show: false, text: "", subtitle: "", color: "#0a0a0a" },
    close: { show: false, text: "", subtitle: "", color: "#0a0a0a" },
  };
  try {
    const raw = getRenderPref(`rc_cards_${projectId}`);
    if (!raw) return empty;
    const c = JSON.parse(raw) as {
      start?: { enabled?: boolean; title?: string; subtitle?: string; color?: string };
      end?: { enabled?: boolean; title?: string; color?: string };
    };
    const openText = (c.start?.title ?? "").trim();
    const closeText = (c.end?.title ?? "").trim();
    return {
      open: {
        show: !!c.start?.enabled && openText !== "",
        text: openText,
        subtitle: (c.start?.subtitle ?? "").trim(),
        color: CARD_COLOR_MAP[c.start?.color ?? ""] ?? "#0a0a0a",
      },
      close: {
        show: !!c.end?.enabled && closeText !== "",
        text: closeText,
        subtitle: "",
        color: CARD_COLOR_MAP[c.end?.color ?? ""] ?? "#0a0a0a",
      },
    };
  } catch {
    return empty;
  }
}

/**
 * Convenience for the duration model: which cards contribute real seconds to the film.
 * Sourced from persisted config -- used by every screen except Arrange's Cards tab,
 * which reads live in-memory card state instead so the estimate updates as you type.
 */
export function cardDurationFlags(projectId: string): { open: boolean; close: boolean } {
  const c = readCardsConfig(projectId);
  return { open: c.open.show, close: c.close.show };
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
  music_loop: true,
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
    const raw = getRenderPref(`rc_sound_${projectId}`);
    if (raw) {
      const s = JSON.parse(raw) as { mood?: string; volume?: string; customPath?: string; musicFadeOut?: string; musicLoop?: boolean };
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
      // U6: loop defaults ON; only an explicit `false` disables it (back-compat for pre-U6 rc_sound)
      if (typeof s.musicLoop === "boolean") {
        config.music_loop = s.musicLoop;
      }
    }
  } catch { /* ignore */ }
  try {
    const res = getRenderPref(`rc_render_res_${projectId}`);
    config.output_resolution = res === "4k" ? "4k" : "1080p";
  } catch { /* ignore */ }
  try {
    const cards = readCardsConfig(projectId);
    if (cards.open.show) {
      config.intro_text = cards.open.text;
      config.intro_subtitle = cards.open.subtitle;
      config.intro_color = cards.open.color;
    }
    if (cards.close.show) {
      config.outro_text = cards.close.text;
      config.outro_color = cards.close.color;
    }
  } catch { /* ignore */ }
  return config;
}
