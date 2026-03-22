import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { invokeLambdaAsync } from "@/lib/lambda";
import { JobConfig } from "@/types/project";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { projectId, config, mode } = body as {
      projectId: string;
      config?: JobConfig | null;
      mode?: "draft" | "final";
    };

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const supabase = createServerClient();

    const { data: job, error: jobError } = await supabase
      .from("jobs")
      .insert({ project_id: projectId, status: "queued", mode: mode ?? "final", config: config ?? null })
      .select("id")
      .single();

    if (jobError) {
      console.error("[jobs/create] failed to create job:", jobError);
      return NextResponse.json({ error: jobError.message }, { status: 500 });
    }

    // Invoke Lambda async (fire-and-forget). Non-fatal: job is in DB and can be retried.
    try {
      await invokeLambdaAsync(job.id);
    } catch (lambdaErr) {
      console.error("[jobs/create] Lambda invoke failed — job queued for retry:", lambdaErr);
    }

    return NextResponse.json({ jobId: job.id });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[jobs/create] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
