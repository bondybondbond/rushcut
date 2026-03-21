/**
 * lib/ffmpeg-client.ts — Lambda invoke + job poll helpers.
 *
 * invokeRender:    Stub — Lambda is now invoked server-side in /api/jobs/create.
 * pollJobStatus:   Polls /api/jobs/[jobId]/status until terminal state.
 */

import type { JobStatusResponse } from "@/types/project";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderStatus =
  | "queued"
  | "processing"
  | "draft_ready"
  | "final_ready"
  | "failed";

const TERMINAL_STATUSES: RenderStatus[] = [
  "draft_ready",
  "final_ready",
  "failed",
];

// ---------------------------------------------------------------------------
// pollJobStatus
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 120; // 600s (10 min) total at 5s interval

/**
 * Poll /api/jobs/[jobId]/status until the job reaches a terminal state.
 *
 * @param jobId      Job UUID to poll.
 * @param onStatus   Called on each status update (for UI progress feedback).
 * @returns          Resolved JobStatusResponse when complete.
 * @throws           Error if max poll attempts exceeded or job status is "failed".
 */
export async function pollJobStatus(
  jobId: string,
  onStatus?: (status: RenderStatus) => void,
): Promise<JobStatusResponse> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(`/api/jobs/${jobId}/status`);
    if (!resp.ok) {
      throw new Error(`Poll failed (${resp.status}): ${await resp.text()}`);
    }

    const job: JobStatusResponse = await resp.json();
    onStatus?.(job.status);

    if (TERMINAL_STATUSES.includes(job.status)) {
      if (job.status === "failed") {
        throw new Error(`Render job failed: ${job.error ?? "unknown error"}`);
      }
      return job;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Job ${jobId} did not complete after ${POLL_MAX_ATTEMPTS} polls (${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s)`,
  );
}
