import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getPresignedGetUrl } from "@/lib/r2";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const supabase = createServerClient();

  const { data: clips, error } = await supabase
    .from("clips")
    .select("*")
    .eq("project_id", projectId)
    .order("order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Attach presigned URL for each clip so the client can generate thumbnails
  const clipsWithUrls = await Promise.all(
    (clips ?? []).map(async (clip) => {
      const presignedUrl = await getPresignedGetUrl(clip.r2_key, 3600).catch(() => null);
      return { ...clip, presignedUrl };
    })
  );

  return NextResponse.json({ clips: clipsWithUrls });
}
