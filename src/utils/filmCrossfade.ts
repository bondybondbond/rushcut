// #197: live preview of a crossfade / dip-to-black between two film <video> slots.
//
// The finished film overlaps neighbouring elements by `xfadeMs`; the sequence ruler already
// gives every item `xfadeMs` less than its played length. For the preview to run on the ruler
// (needle never parks) the outgoing clip must keep playing for those `xfadeMs` while the next
// one fades in, exactly like the render. This helper only animates the two slots; the page
// owns when to start it and what to do afterwards (pause the outgoing slot, preload, ...).

import type { TransitionValue } from "@/types/project";

export type FadeKind = "crossfade" | "dip";

/** Every non-"none" between-transition is previewed as a dissolve; dip_to_black keeps its dip. */
export function fadeKindFor(between: TransitionValue): FadeKind {
  return between === "dip_to_black" ? "dip" : "crossfade";
}

export interface SlotFadeOpts {
  /** The slot being faded out (may be null/hidden -- e.g. the previous clip was never shown). */
  outV: HTMLVideoElement | null;
  inV: HTMLVideoElement;
  ms: number;
  kind: FadeKind;
  /** Final volume of the incoming clip (its clip_volume). The outgoing ramps down from its own. */
  inVolume: number;
  onDone: () => void;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Linear audio fade-out of one slot over `ms` (the clip tail playing under a card dissolving in). */
export function rampVolumeDown(v: HTMLVideoElement | null, ms: number): () => void {
  if (!v || ms <= 0) return () => {};
  const v0 = v.volume;
  const start = performance.now();
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const restore = () => { try { v.volume = v0; } catch { /* ignore */ } };
  const step = (now: number) => {
    if (stopped) return;
    const p = clamp01((now - start) / ms);
    try { v.volume = clamp01(v0 * (1 - p)); } catch { return; }
    if (p < 1) raf = requestAnimationFrame(step);
    else timer = setTimeout(restore, 80); // the caller pauses it at ~ms; put the level back for its next use
  };
  raf = requestAnimationFrame(step);
  // Cancel: stop ramping and put the level back right away.
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (timer !== null) clearTimeout(timer);
    restore();
  };
}

/**
 * Animate `inV` in over `outV` for `ms`, driving opacity (the incoming slot is stacked on top via
 * z-index, so a dissolve is simply its opacity 0 -> 1) and a linear audio cross-ramp. Returns a
 * cancel function that stops the animation and clears the stacking override; the caller is then
 * responsible for the final visible/paused state (`setSlotVisible`).
 */
export function runSlotFade(opts: SlotFadeOpts): () => void {
  const { outV, inV, ms, kind, inVolume, onDone } = opts;
  const outVolume0 = outV ? outV.volume : 0;
  let raf = 0;
  let cancelled = false;
  const start = performance.now();

  if (outV) { outV.style.zIndex = "1"; outV.style.opacity = "1"; }
  inV.style.zIndex = "2";
  inV.style.opacity = "0";
  inV.style.pointerEvents = "";

  function reset() {
    if (outV) outV.style.zIndex = "";
    inV.style.zIndex = "";
  }

  function frame(now: number) {
    if (cancelled) return;
    const p = ms > 0 ? clamp01((now - start) / ms) : 1;
    if (kind === "dip") {
      // out -> black over the first half, black -> in over the second half.
      if (outV) outV.style.opacity = String(clamp01(1 - p * 2));
      inV.style.opacity = String(clamp01(p * 2 - 1));
    } else {
      inV.style.opacity = String(p);
    }
    try {
      if (outV) outV.volume = clamp01(outVolume0 * (1 - p));
      inV.volume = clamp01(inVolume * p);
    } catch { /* a detached element can throw on volume set; the fade is cosmetic */ }
    if (p >= 1) {
      reset();
      if (outV) outV.style.opacity = "0";
      inV.style.opacity = "1";
      onDone();
      // the outgoing slot was ramped to silence; restore its level for its next use (it is paused now)
      if (outV) { try { outV.volume = outVolume0; } catch { /* ignore */ } }
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    reset();
    if (outV) { try { outV.volume = outVolume0; } catch { /* ignore */ } }
    // the incoming clip may have been cancelled part-way up the ramp: it is the one that keeps playing
    try { inV.volume = inVolume; } catch { /* ignore */ }
  };
}
