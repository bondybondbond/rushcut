import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { clips } = body as { clips: Array<{ id: string; order: number }> };

    if (!Array.isArray(clips)) {
      return NextResponse.json({ error: "clips must be an array" }, { status: 400 });
    }

    const supabase = createServerClient();

    await Promise.all(
      clips.map(({ id, order }) =>
        supabase.from("clips").update({ order }).eq("id", id)
      )
    );

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[clips/reorder] unexpected error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
