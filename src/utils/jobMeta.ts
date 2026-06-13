// Job metadata helpers (Batch T4). Shared by Library cards and the Render
// done-state so resolution/duration labels read identically on both screens.
//
// IMPORTANT: `settings_json` IS JSON (JSON.stringify(config) from start_job),
// but `analysis_summary` is NOT JSON -- it is a comma-separated `key=value`
// string (e.g. "output_duration_s=12.3,max_resolution=1080,has_4k=0,...").
// Parse it by splitting, never JSON.parse. Mirrors the regex parse in Render.tsx.

import type { Job } from "@/types/project";

/** Parse the comma-separated key=value ANALYSIS string into a lookup. */
export function parseAnalysis(analysis: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!analysis) return out;
  for (const pair of analysis.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** Human-readable output resolution, e.g. "1080p" or "4K". null if unknown. */
export function resLabel(job: Pick<Job, "settings_json" | "analysis_summary">): string | null {
  // Prefer the explicit settings value.
  if (job.settings_json) {
    try {
      const res = (JSON.parse(job.settings_json) as { output_resolution?: string }).output_resolution;
      if (res === "4k") return "4K";
      if (res === "1080p") return "1080p";
    } catch { /* fall through to analysis */ }
  }
  // Fall back to the ANALYSIS string.
  const a = parseAnalysis(job.analysis_summary);
  // Prefer explicit output_resolution over has_4k — source clips can be 4K while
  // the render target is 1080p. has_4k reflects source resolution, not output.
  if (a.output_resolution === "4k") return "4K";
  if (a.output_resolution === "1080p") return "1080p";
  if (a.has_4k === "1") return "4K";
  if (a.max_resolution) return Number(a.max_resolution) >= 2160 ? "4K" : "1080p";
  return null;
}

/** Output duration as m:ss from the ANALYSIS string. null if unknown. */
export function durationLabel(job: Pick<Job, "analysis_summary">): string | null {
  const a = parseAnalysis(job.analysis_summary);
  const secStr = a.output_duration_s;
  if (!secStr) return null;
  const total = Math.round(Number(secStr));
  if (!Number.isFinite(total) || total < 0) return null;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type RenderState = "idle" | "rendering" | "done" | "error";

/** Map a job status (or absence of a job) to the T4 state machine state. */
export function renderStateFromStatus(status: Job["status"] | null | undefined): RenderState {
  switch (status) {
    case "processing":
    case "pending":
      return "rendering";
    case "done":
      return "done";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}
