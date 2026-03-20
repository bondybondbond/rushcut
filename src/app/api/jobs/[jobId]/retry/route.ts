import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { invokeLambdaAsync } from "@/lib/lambda";

const STALE_PROCESSING_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const supabase = createServerClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, status, updated_at")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Don't retry already-complete jobs
  if (job.status === "draft_ready" || job.status === "final_ready") {
    return NextResponse.json(
      { error: "Job already complete" },
      { status: 409 },
    );
  }

  // Staleness guard: don't retry a still-active processing job
  if (job.status === "processing") {
    const updatedAt = new Date(job.updated_at).getTime();
    const age = Date.now() - updatedAt;
    if (age < STALE_PROCESSING_MS) {
      return NextResponse.json(
        { error: "Job is still active — retry after 10 minutes" },
        { status: 409 },
      );
    }
  }

  // Reset to queued
  const { error: patchError } = await supabase
    .from("jobs")
    .update({ status: "queued", error: null })
    .eq("id", jobId);

  if (patchError) {
    console.error("[jobs/retry] failed to reset job status:", patchError);
    return NextResponse.json({ error: patchError.message }, { status: 500 });
  }

  try {
    await invokeLambdaAsync(jobId);
  } catch (lambdaErr) {
    console.error("[jobs/retry] Lambda invoke failed:", lambdaErr);
    // Still return ok — job is queued and can be retried again
  }

  return NextResponse.json({ ok: true });
}
