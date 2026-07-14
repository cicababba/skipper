import { NextResponse } from "next/server";
import { listPending } from "@skipper/core";
import { getWorkspacePath } from "@/lib/config";

export async function GET() {
  try {
    const workspace = getWorkspacePath();
    const entries = await listPending(workspace);
    // The renderer doesn't need the absolute filePath visible to the user but
    // it does need a stable identifier to pass back on accept/reject/update.
    return NextResponse.json({
      entries: entries.map((e) => ({
        filePath: e.filePath,
        atom: e.atom,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
