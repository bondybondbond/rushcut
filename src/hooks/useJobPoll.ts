"use client";

/**
 * hooks/useJobPoll.ts — Shared polling hook for preview and download pages.
 *
 * Single source of truth for poll state machine, progress labels, and retry logic.
 * Both preview/[jobId] and download/[jobId] consume this hook — no divergence.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { pollJobStatus, type RenderStatus } from "@/lib/ffmpeg-client";
import type { JobStatusResponse } from "@/types/project";

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
  | { phase: "polling"; status: RenderStatus }
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
  });

  // Use a ref to allow retry() to re-trigger the effect without stale closure issues
  const runCount = useRef(0);

  const startPoll = useCallback(() => {
    runCount.current += 1;
    const thisRun = runCount.current;

    setState({ phase: "polling", status: "queued" });

    pollJobStatus(jobId, (status) => {
      // Ignore stale runs if retry() was called
      if (thisRun !== runCount.current) return;
      setState({ phase: "polling", status });
    })
      .then((job) => {
        if (thisRun !== runCount.current) return;
        setState({ phase: "ready", job });
      })
      .catch((err: Error) => {
        if (thisRun !== runCount.current) return;
        if (err.message.includes("did not complete after")) {
          setState({ phase: "timeout" });
        } else {
          setState({ phase: "failed", error: err.message });
        }
      });
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
