import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getPresignedGetUrl } from "@/lib/r2";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const supabase = createServerClient();

  const { data: job, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Generate fresh presigned URLs (1h expiry) — generated on each poll so they never go stale
  const draftUrl = job.draft_r2_key
    ? await getPresignedGetUrl(job.draft_r2_key, 3600)
    : undefined;
  const finalUrl = job.final_r2_key
    ? await getPresignedGetUrl(job.final_r2_key, 3600)
    : undefined;

  return NextResponse.json({ ...job, draftUrl, finalUrl });
}
