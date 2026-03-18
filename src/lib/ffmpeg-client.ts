/**
 * lib/ffmpeg-client.ts — Lambda invoke + job poll helpers.
 *
 * Batch 3: stubs only — wired for Batch 4 (AWS Lambda deploy + API route).
 *
 * invokeRender:    Triggers the Lambda function for a job.
 * pollJobStatus:   Polls /api/jobs/[jobId]/status until terminal state.
 */

import type { Job } from "@/types/project";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RenderStatus = Job["status"];

const TERMINAL_STATUSES: RenderStatus[] = [
  "draft_ready",
  "final_ready",
  "failed",
];

// ---------------------------------------------------------------------------
// invokeRender
// ---------------------------------------------------------------------------

/**
 * Invoke the Lambda render function for a job.
 *
 * Batch 4: replace stub with AWS Lambda SDK InvokeCommand (InvocationType: Event)
 * or an internal API route that calls Lambda.
 */
export async function invokeRender(jobId: string): Promise<void> {
  // TODO (Batch 4): call Lambda via AWS SDK or /api/jobs/[jobId]/invoke
  console.log("[ffmpeg-client] invokeRender stub called for job:", jobId);
}

// ---------------------------------------------------------------------------
// pollJobStatus
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 20; // 60s total at 3s interval

/**
 * Poll /api/jobs/[jobId]/status until the job reaches a terminal state.
 *
 * @param jobId      Job UUID to poll.
 * @param onStatus   Called on each status update (for UI progress feedback).
 * @returns          Resolved Job row when complete.
 * @throws           Error if max poll attempts exceeded or job status is "failed".
 */
export async function pollJobStatus(
  jobId: string,
  onStatus?: (status: RenderStatus) => void,
): Promise<Job> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(`/api/jobs/${jobId}/status`);
    if (!resp.ok) {
      throw new Error(`Poll failed (${resp.status}): ${await resp.text()}`);
    }

    const job: Job = await resp.json();
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
