// Per-clip zoom model.
//
// `zoom_mode` is a single opaque TEXT column shared by the DB, Rust and the
// Python pipeline. Encoding:
//   null / "gentle" / "medium" / "tight"  -> static crop-in (Fixed)
//   "kb_<dir>_<ratio>_slow"               -> gradual zoom across full clip
//                                            e.g. "kb_in_1.5_slow"
//
// Speed suffix controls when the zoom fully realizes:
//   slow = 100 % of clip duration (holds at end)
//   med  =  75 % of clip duration (holds for last 25 %)
//   fast =  50 % of clip duration (holds for last 50 %)
//
// This module is the single place that parses / builds / labels that string,
// so no screen ever has to render the raw value.

export type ZoomStyle = "off" | "fixed" | "gradual";

export interface ZoomState {
  style: ZoomStyle;
  fixedRatio: string;   // "gentle" | "medium" | "tight"
  kbDir: "in" | "out";
  kbRatio: string;      // "1.3" | "1.5" | "2.0"
  kbSpeed: string;      // "slow" | "med" | "fast"
}

export const FIXED_AMOUNTS: { value: string; label: string }[] = [
  { value: "gentle", label: "1.3×" },
  { value: "medium", label: "1.5×" },
  { value: "tight",  label: "2×" },
];

export const KB_AMOUNTS: { value: string; label: string }[] = [
  { value: "1.3", label: "1.3×" },
  { value: "1.5", label: "1.5×" },
  { value: "2.0", label: "2×" },
];

export function parseZoom(zoomMode: string | null): ZoomState {
  const base: ZoomState = {
    style: "off", fixedRatio: "medium",
    kbDir: "in", kbRatio: "1.5", kbSpeed: "slow",
  };
  if (!zoomMode) return base;
  if (zoomMode.startsWith("kb_")) {
    const p = zoomMode.split("_");          // ["kb","in","1.5","slow"]
    if (p.length < 3) return base;
    return {
      ...base,
      style: "gradual",
      kbDir: p[1] === "out" ? "out" : "in",
      kbRatio: KB_AMOUNTS.some(a => a.value === p[2]) ? p[2] : "1.5",
      kbSpeed: ["slow", "med", "fast"].includes(p[3]) ? p[3] : "slow",
    };
  }
  return { ...base, style: "fixed", fixedRatio: zoomMode };
}

export function buildZoomMode(s: ZoomState): string | null {
  if (s.style === "off") return null;
  if (s.style === "fixed") return s.fixedRatio;
  return `kb_${s.kbDir}_${s.kbRatio}_${s.kbSpeed}`;
}

// Human-readable label for badges / tooltips — never exposes the raw kb_ string.
export function zoomLabel(zoomMode: string | null): string {
  const z = parseZoom(zoomMode);
  if (z.style === "off") return "No zoom";
  if (z.style === "fixed") {
    return `Fixed zoom ${FIXED_AMOUNTS.find(a => a.value === z.fixedRatio)?.label ?? ""}`.trim();
  }
  const amt = KB_AMOUNTS.find(a => a.value === z.kbRatio)?.label ?? "";
  return `Gradual ${z.kbDir === "out" ? "out" : "in"} ${amt}`.trim();
}
