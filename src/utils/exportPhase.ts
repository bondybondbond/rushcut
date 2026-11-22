// #267: which of the three export phases (Prepare / Process / Finish) a raw pipeline stage
// belongs to. Derived ONLY from the stage string the pipeline already sends, never the percent.
// null = an unrecognised stage: the caller leaves the phase where it is.
export const PHASES = ["Prepare", "Process", "Finish"] as const;

export function phaseOf(raw: string): number | null {
  const at = raw.indexOf(" | ");
  const p = at < 0 ? raw : raw.slice(0, at);
  if (/^(Preparing clips|Trimming clips|normalise$|silence_trim$)/.test(p)) return 0;
  if (p === "zoom" || p === "cards" || p === "Rendering" || p === "render") return 1;
  if (p === "Mixing music" || p === "music" || p === "loudnorm") return 2;
  return null;
}
