import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { clipId, duration_ms: clientDuration_ms } = body as {
    clipId: string;
    duration_ms?: number | null;
  };

  // Store client-supplied duration (ffprobe via R2 removed — local pipeline handles probing now)
  if (clipId && clientDuration_ms != null) {
    try {
      const supabase = createServerClient();
      await supabase
        .from("clips")
        .update({ duration_ms: clientDuration_ms })
        .eq("id", clipId);
    } catch {
      // Non-fatal
    }
  }

  return NextResponse.json({ skipped: true, duration_ms: clientDuration_ms ?? null });
}
