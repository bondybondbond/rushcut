import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { deleteObject } from "@/lib/r2";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ clipId: string }> }
) {
  try {
    const { clipId } = await params;

    const supabase = createServerClient();

    const { data: clip, error: fetchError } = await supabase
      .from("clips")
      .select("id, r2_key")
      .eq("id", clipId)
      .single();

    if (fetchError) {
      console.error("[clips/delete] failed to fetch clip:", fetchError);
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    // Delete from R2 first
    await deleteObject(clip.r2_key);

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
