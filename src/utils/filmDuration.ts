import type { Clip } from "@/types/project";
import type { TransitionConfig } from "@/utils/buildJobConfig";

// Crossfade overlap per cut, in ms. MUST stay in sync with pipeline/transitions.py
// XFADE_DUR = 1.5 (seconds). The render telescopes every transition by this amount,
// clamped to half the shortest clip -- see render.py / transitions.py.
export const XFADE_DUR_MS = 1500;

/** Trimmed length of a single clip in ms (out - in, floored at 0). */
export function trimmedMs(clip: Clip): number {
  return Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
}

/**
 * Naive sum of trimmed clip lengths. This is the TIMELINE GEOMETRY value:
 * clips are laid end-to-end visually and their cumulative start offsets are naive.
 * Use this for px-per-ms, tick marks, scrub-bar position, playhead, and seek math.
 */
export function naiveFilmMs(inFilm: Clip[]): number {
  return inFilm.reduce((sum, c) => sum + trimmedMs(c), 0);
}

/**
 * Effective DISPLAYED runtime after subtracting transition overlap -- mirrors the
 * pipeline telescoping math (#62). This is the value shown to the user as the film
 * runtime, NOT the absolute rendered-file duration: text intro/outro cards add real
 * seconds in the render but are absent from the clips array, so card-heavy films will
 * still undercount here until #63. Backend/music truth comes from get_duration(output).
 *
 * Mirrors render.py: has_xfade = (between != "none") || shuffleBetween;
 *   total = naive - (n-1) * min(1500, min(clip)/2)
 * plus +0.1s net per open/close-to-black (black_dur - xfade_dur).
 */
export function effectiveFilmMs(inFilm: Clip[], tc: TransitionConfig): number {
  const n = inFilm.length;
  // Guard: empty selection -> 0; a single clip has no cuts and no overlap.
  if (n === 0) return 0;
  let total = naiveFilmMs(inFilm);

  const hasOverlap = tc.between !== "none" || tc.shuffleBetween;
  if (hasOverlap && n >= 2) {
    // Guard: clamp against the shortest *non-zero* clip so a pathological
    // zero-length trim can't drive xfade_dur to 0 or negative.
    const positiveDurs = inFilm.map(trimmedMs).filter((d) => d > 0);
    if (positiveDurs.length > 0) {
      const xfadeMs = Math.min(XFADE_DUR_MS, Math.min(...positiveDurs) / 2);
      total -= (n - 1) * xfadeMs;
    }
  }

  // Open/close-to-black each net +0.1s overlap (gated on the transition, not card text).
  if (tc.opening !== "none") total += 100;
  if (tc.closing !== "none") total += 100;

  return Math.max(0, total);
}
