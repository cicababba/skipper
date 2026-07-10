import { NextResponse } from "next/server";
import { listPending } from "@nestbrain/core";
import { getWorkspacePath } from "@/lib/config";

export async function GET() {
  try {
    const workspace = getWorkspacePath();
    const pending = (await listPending(workspace)).length;
    return NextResponse.json({ pending });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
