import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getPresignedPutUrl } from "@/lib/r2";

const ALLOWED_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
];

const MAX_SIZE = 2147483648; // 2 GB

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { filename, size, contentType, projectId: bodyProjectId } = body;

    // Validate filename
    if (!filename || typeof filename !== "string" || filename.trim() === "") {
      return NextResponse.json({ error: "filename is required" }, { status: 400 });
    }

    // Validate size
    if (typeof size !== "number" || size > MAX_SIZE) {
      return NextResponse.json(
        { error: "File too large — max 2 GB per file" },
        { status: 400 }
      );
    }

    // Validate contentType
    if (!ALLOWED_TYPES.includes(contentType)) {
      return NextResponse.json(
        { error: `Unsupported content type: ${contentType}` },
        { status: 400 }
      );
    }

    const supabase = createServerClient();

    // Create project if not provided
    let projectId = bodyProjectId;
    if (!projectId) {
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .insert({ status: "draft" })
        .select("id")
        .single();

      if (projectError) {
        console.error("[presign] failed to create project:", projectError);
        return NextResponse.json({ error: projectError.message }, { status: 500 });
      }
      projectId = project.id;
    }

    // Count existing clips to determine order
    const { count, error: countError } = await supabase
      .from("clips")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);

    if (countError) {
      console.error("[presign] failed to count clips:", countError);
      return NextResponse.json({ error: countError.message }, { status: 500 });
    }

    const order = (count ?? 0) + 1;

    // Insert clip row with a temporary r2_key placeholder
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .insert({
        project_id: projectId,
        filename,
        size_bytes: size,
        r2_key: "", // will be updated below once we have clipId
        order,
        duration_ms: null,
        width: null,
        height: null,
        fps: null,
      })
      .select("id")
      .single();

    if (clipError) {
      console.error("[presign] failed to create clip:", clipError);
      return NextResponse.json({ error: clipError.message }, { status: 500 });
    }

    const clipId = clip.id;
    const r2_key = `projects/${projectId}/clips/${clipId}/${filename}`;

    // Update clip with real r2_key
    const { error: updateError } = await supabase
      .from("clips")
      .update({ r2_key })
      .eq("id", clipId);

    if (updateError) {
      console.error("[presign] failed to update r2_key:", updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const uploadUrl = await getPresignedPutUrl(r2_key, contentType);

    return NextResponse.json({ uploadUrl, clipId, projectId });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[presign] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
