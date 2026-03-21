"use client";

/**
 * hooks/useJobPoll.ts — Shared polling hook for preview and download pages.
 *
 * Single source of truth for poll state machine, progress labels, and retry logic.
 * Both preview/[jobId] and download/[jobId] consume this hook — no divergence.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { RenderStatus } from "@/lib/ffmpeg-client";
import type { JobStatusResponse } from "@/types/project";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120;

const TERMINAL_STATUSES: RenderStatus[] = [
  "draft_ready",
  "final_ready",
  "failed",
];

// ---------------------------------------------------------------------------
// Progress labels — defined here so both pages use the same strings
// ---------------------------------------------------------------------------

export const PROGRESS_LABELS: Record<RenderStatus, string> = {
  queued: "Queued — waiting for a render slot...",
  processing: "Assembling your film...",
  draft_ready: "Draft ready",
  final_ready: "Done",
  failed: "Render failed",
};

// ---------------------------------------------------------------------------
// Poll state
// ---------------------------------------------------------------------------

type PollState =
  | { phase: "polling"; status: RenderStatus; progressPct: number | null }
  | { phase: "ready"; job: JobStatusResponse }
  | { phase: "failed"; error: string }
  | { phase: "timeout" };

export type UseJobPollResult = PollState & { retry: () => void };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useJobPoll(jobId: string): UseJobPollResult {
  const [state, setState] = useState<PollState>({
    phase: "polling",
    status: "queued",
    progressPct: null,
  });

  // Use a ref to allow retry() to re-trigger the effect without stale closure issues
  const runCount = useRef(0);

  const startPoll = useCallback(() => {
    runCount.current += 1;
    const thisRun = runCount.current;

    setState({ phase: "polling", status: "queued", progressPct: null });

    (async () => {
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        if (thisRun !== runCount.current) return;

        try {
          const resp = await fetch(`/api/jobs/${jobId}/status`);
          if (!resp.ok) {
            throw new Error(`Poll failed (${resp.status}): ${await resp.text()}`);
          }

          const job: JobStatusResponse = await resp.json();

          if (TERMINAL_STATUSES.includes(job.status)) {
            if (thisRun !== runCount.current) return;
            if (job.status === "failed") {
              setState({ phase: "failed", error: job.error ?? "Render failed" });
            } else {
              setState({ phase: "ready", job });
            }
            return;
          }

          if (thisRun !== runCount.current) return;
          setState({
            phase: "polling",
            status: job.status,
            progressPct: job.progress_pct ?? null,
          });
        } catch (err: unknown) {
          if (thisRun !== runCount.current) return;
          setState({ phase: "failed", error: (err as Error).message });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      // Timed out
      if (thisRun !== runCount.current) return;
      setState({ phase: "timeout" });
    })();
  }, [jobId]);

  useEffect(() => {
    startPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const retry = useCallback(async () => {
    try {
      await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    } catch {
      // Ignore network errors — startPoll will reflect real status on next poll
    }
    startPoll();
  }, [jobId, startPoll]);

  return { ...state, retry };
}
