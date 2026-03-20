import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { invokeLambdaAsync } from "@/lib/lambda";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const supabase = createServerClient();

  // Fetch original (draft) job to get project_id and config from DB (not client state)
  const { data: draftJob, error: fetchError } = await supabase
    .from("jobs")
    .select("project_id, config")
    .eq("id", jobId)
    .single();

  if (fetchError || !draftJob) {
    return NextResponse.json({ error: "Draft job not found" }, { status: 404 });
  }

  // Create new final job row
  const { data: finalJob, error: insertError } = await supabase
    .from("jobs")
    .insert({
      project_id: draftJob.project_id,
      config: draftJob.config,
      mode: "final",
      status: "queued",
    })
    .select("id")
    .single();

  if (insertError || !finalJob) {
    console.error("[jobs/finalise] failed to create final job:", insertError);
    return NextResponse.json(
      { error: insertError?.message ?? "Insert failed" },
      { status: 500 },
    );
  }

  try {
    await invokeLambdaAsync(finalJob.id);
  } catch (lambdaErr) {
    console.error("[jobs/finalise] Lambda invoke failed — job queued for retry:", lambdaErr);
  }

  return NextResponse.json({ jobId: finalJob.id });
}
