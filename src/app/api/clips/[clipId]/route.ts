import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

// PATCH /api/clips/[clipId] — store thumbnail_data after upload
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> }
) {
  try {
    const { clipId } = await params;
    const body = await req.json();
    const { thumbnail_data } = body as { thumbnail_data?: string };

    if (!thumbnail_data) {
      return NextResponse.json({ error: "thumbnail_data required" }, { status: 400 });
    }

    const supabase = createServerClient();
    const { error } = await supabase
      .from("clips")
      .update({ thumbnail_data })
      .eq("id", clipId);

    if (error) {
      console.error("[clips/patch] failed to update thumbnail:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> }
) {
  try {
    const { clipId } = await params;

    const supabase = createServerClient();

    // Delete from Supabase
    const { error: deleteError } = await supabase
      .from("clips")
      .delete()
      .eq("id", clipId);

    if (deleteError) {
      console.error("[clips/delete] failed to delete clip row:", deleteError);
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[clips/delete] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
