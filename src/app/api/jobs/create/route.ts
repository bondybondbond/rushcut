import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId } = body;

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const supabase = createServerClient();

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({ project_id: projectId, status: "queued", mode: "draft" })
      .select("id")
      .single();

    if (jobError) {
      console.error("[jobs/create] failed to create job:", jobError);
      return NextResponse.json({ error: jobError.message }, { status: 500 });
    }

    return NextResponse.json({ jobId: job.id });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[jobs/create] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
