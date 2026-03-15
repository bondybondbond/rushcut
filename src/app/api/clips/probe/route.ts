import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { getPresignedGetUrl } from "@/lib/r2";
import { execFileNoThrow } from "@/utils/execFileNoThrow";

export async function POST(req: NextRequest) {
  // Vercel Hobby: binary size limit — skip ffprobe
  if (process.env.VERCEL) {
    return NextResponse.json({ skipped: true });
  }

  try {
    const body = await req.json();
    const { clipId } = body;

    if (!clipId) {
      return NextResponse.json({ error: "clipId is required" }, { status: 400 });
    }

    const supabase = createServerClient();

    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("id, r2_key")
      .eq("id", clipId)
      .single();

    if (clipError) {
      console.error("[probe] failed to fetch clip:", clipError);
      return NextResponse.json({ error: clipError.message }, { status: 500 });
    }

    const presignedUrl = await getPresignedGetUrl(clip.r2_key);

    // Dynamically import to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffprobeInstaller = require("@ffprobe-installer/ffprobe");
    const ffprobePath: string = ffprobeInstaller.path;

    const result = await execFileNoThrow(ffprobePath, [
      "-v", "quiet",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,duration",
      "-of", "json",
      presignedUrl,
    ]);

    if (result.code !== 0) {
      console.error("[probe] ffprobe failed:", result.stderr);
      return NextResponse.json({ error: result.stderr }, { status: 500 });
    }

    let parsed: { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; duration?: string }> };
    try {
      parsed = JSON.parse(result.stdout);
    } catch (parseErr) {
      console.error("[probe] failed to parse ffprobe output:", parseErr, result.stdout);
      return NextResponse.json({ error: "Failed to parse ffprobe output" }, { status: 500 });
    }

    const stream = parsed?.streams?.[0];
    if (!stream) {
      console.error("[probe] no video streams found in ffprobe output");
      return NextResponse.json({ error: "No video streams found" }, { status: 500 });
    }

    // Parse r_frame_rate: "30000/1001" → divide → round to 2 decimal places
    let fps: number | null = null;
    if (stream.r_frame_rate) {
      const parts = stream.r_frame_rate.split("/");
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        fps = den !== 0 ? Math.round((num / den) * 100) / 100 : null;
      } else {
        fps = parseFloat(stream.r_frame_rate) || null;
      }
    }

    // duration is seconds float → ms INT
    const duration_ms = stream.duration
      ? Math.round(parseFloat(stream.duration) * 1000)
      : null;

    const width = stream.width ?? null;
    const height = stream.height ?? null;

    const { error: updateError } = await supabase
      .from("clips")
      .update({ duration_ms, width, height, fps })
      .eq("id", clipId);

    if (updateError) {
      console.error("[probe] failed to update clip metadata:", updateError);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ duration_ms, width, height, fps });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[probe] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
