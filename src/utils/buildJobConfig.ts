import type { CardSpec, JobConfig, TransitionValue } from "@/types/project";
import { getRenderPref, setRenderPref } from "@/utils/renderStore";
import { projectCache } from "@/utils/projectCache";

export const VALID_MOODS = ["none", "cinematic", "upbeat", "chill", "electronic", "custom"] as const;
export const VALID_VOLUMES = ["subtle", "balanced", "prominent"] as const;
export const VALID_TRANSITIONS = ["none", "crossfade", "dip_to_black", "wipe", "wipe_down", "zoom", "barn_door", "band_wipe"] as const;
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

export type CardAnimation = "none" | "appear" | "fade" | "fly_in";

/**
 * A card placed anywhere in the sequence (#149, generalizes the old fixed
 * start/end-only model). Anchored by clip id, not a raw index -- `beforeClipId`
 * is the id of the clip this card sits immediately before; `null` means the very
 * end of the film. Anchoring by id (the same pattern the filmstrip's drag-to-reorder
 * already uses for clips) means a card stays pinned to its neighbour even if clips
 * are reordered/deleted elsewhere in Arrange -- resolving to a wire-format integer
 * only happens at buildJobConfig() time, against the CURRENT clip order.
 */
export interface PlacedCard {
  id: string;
  text: string;
  subtitle: string;
  color: string; // resolved hex
  animation: CardAnimation;
  beforeClipId: string | null;
}

const CARDS_V2_STORAGE_KEY = (projectId: string) => `rc_cards_v2_${projectId}`;

/**
 * Read all placed cards from the render-pref store (localStorage key
 * `rc_cards_v2_${projectId}` -- a new key, not a migration of the old fixed
 * start/end `rc_cards_${projectId}` shape, to avoid misreading it). Filters out
 * any card with an empty title -- mirrors the pipeline render gate
 * `if (c.get("text") or "").strip()` (render.py) -- though in practice the UI
 * never lets an empty-title card get placed in the first place.
 */
export function readPlacedCards(projectId: string): PlacedCard[] {
  try {
    const raw = getRenderPref(CARDS_V2_STORAGE_KEY(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PlacedCard[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c) => typeof c?.text === "string" && c.text.trim() !== "");
  } catch {
    return [];
  }
}

export function savePlacedCards(projectId: string, cards: PlacedCard[]): void {
  setRenderPref(CARDS_V2_STORAGE_KEY(projectId), JSON.stringify(cards));
}

/**
 * Resolve each card's clip-id anchor into the pipeline's wire-format index (#148:
 * position 0..n = before clip[n], -1 = end sentinel), against the CURRENT clip
 * order. If the anchor clip no longer exists (deleted after the card was placed),
 * falls back deterministically to end-of-film -- closes the client-side-validation
 * gap flagged when #148 shipped, instead of relying on the pipeline's silent
 * out-of-range clamp.
 */
export function resolveCardPositions(cards: PlacedCard[], inFilmClipIds: string[]): CardSpec[] {
  return cards.map((c) => {
    const idx = c.beforeClipId === null ? -1 : inFilmClipIds.indexOf(c.beforeClipId);
    return {
      text: c.text,
      subtitle: c.subtitle || undefined,
      color: c.color,
      // #152 reverted: dormant no-op field (always "none"). The pipeline no longer
      // reads card `animation`; kept in the manifest shape to avoid an rc_cards_v2
      // migration. Cards enter/leave via the global transition.
      animation: c.animation,
      position: idx,
    };
  });
}

/**
 * Ordered card runs by anchor -- THE single resolver for "which cards sit at
 * which anchor, in what order" (#184). Every consumer that interleaves cards with
 * clips (buildSequenceCore, StickyFilmStrip segments, Trimmer advanceFilmClip /
 * seekFilmTo, Sound Master playback) MUST derive its card iteration from this, so
 * the strip ruler, the playback needle and the render can never disagree on card
 * order or count (the #164/#174 ruler-vs-needle failure class).
 *
 * CONTRACT / invariants:
 *  - `before.get(clipId)` and `end` are subsequences of `cards` in the SAME order
 *    the array is persisted in (`rc_cards_v2_<id>`). The run is NEVER sorted --
 *    persisted array order IS the user-visible order (new card appended last ->
 *    plays last in its run).
 *  - A card whose `beforeClipId` is `null` OR points to a clip not in
 *    `inFilmClipIds` (its anchor clip was deleted) falls into `end` -- matches
 *    `resolveCardPositions` / `cardGapsForClips`.
 *  - Multiple cards may share one anchor (#184 lifted the old "<=1 card per gap"
 *    assumption). Pre-existing `rc_cards_v2` data may already hold silently-hidden
 *    same-anchor duplicates from before the fix; they are rendered faithfully
 *    here, NOT deduped -- cleanup is deliberately out of scope for #184.
 *  - Pure: no I/O, no `Date.now`, deterministic in `cards` + `inFilmClipIds`.
 */
export interface CardRuns<T> {
  /** clipId -> cards anchored immediately before that clip, persisted order. */
  before: Map<string, T[]>;
  /** cards at end-of-film (null anchor or orphaned anchor), persisted order. */
  end: T[];
}
// Generic over anything carrying a `beforeClipId` -- so the render-side
// `PlacedCard[]` and the strip's `PositionedCard[]` both resolve card order
// through this ONE function (Gate 3 #2: every consumer derives an identical
// flattened order).
export function orderedCardRuns<T extends { beforeClipId: string | null }>(
  cards: readonly T[],
  inFilmClipIds: string[],
): CardRuns<T> {
  const inFilm = new Set(inFilmClipIds);
  const before = new Map<string, T[]>();
  const end: T[] = [];
  for (const c of cards) {
    if (c.beforeClipId !== null && inFilm.has(c.beforeClipId)) {
      const run = before.get(c.beforeClipId);
      if (run) run.push(c);
      else before.set(c.beforeClipId, [c]);
    } else {
      end.push(c);
    }
  }
  return { before, end };
}

/**
 * Card count for the duration model (#149 generalizes #74's two-flag {open, close}
 * shape to a plain count -- every placed card adds CARD_DUR_MS + one xfade overlap
 * regardless of where it sits). Consumers that need live in-memory state instead
 * (Arrange's Cards tab, as it's being edited) read their own PlacedCard[] directly.
 */
export function cardDurationFlags(projectId: string): { count: number } {
  return { count: readPlacedCards(projectId).length };
}

/**
 * Per-clip "does a card sit immediately before this clip" map, for
 * filmTimeAtClipStart (#149 generalizes the old single hasOpenCard boolean to
 * arbitrary mid-roll positions). `inFilmClipIds` must be the current in-film clip
 * order (same list the caller uses everywhere else). Also reports whether a card
 * sits at the very end, folding in any orphaned-anchor card (its clip was deleted)
 * the same way resolveCardPositions does.
 */
export function cardGapsForClips(
  cards: PlacedCard[],
  inFilmClipIds: string[],
): { beforeClip: boolean[]; atEnd: boolean } {
  const beforeClip = inFilmClipIds.map((id) => cards.some((c) => c.beforeClipId === id));
  const atEnd = cards.some(
    (c) => c.beforeClipId === null || !inFilmClipIds.includes(c.beforeClipId),
  );
  return { beforeClip, atEnd };
}

export const DEFAULT_CONFIG: JobConfig = {
  music_mood: "none",
  transition: "none",
  opening_transition: "none",
  closing_transition: "none",
  shuffle_between: false,
  cards: [],
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
    const placed = readPlacedCards(projectId);
    // #149: resolve each card's clip-id anchor against the CURRENT clip order (the
    // manifest-build moment) into the pipeline's wire-format index -- see
    // resolveCardPositions for why this must happen here, not at placement time.
    const cachedClips = projectCache.get(projectId)?.clips ?? [];
    const inFilmClipIds = cachedClips
      .filter((c) => c.include === 1)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => c.id);
    config.cards = resolveCardPositions(placed, inFilmClipIds);
  } catch { /* ignore */ }
  return config;
}
