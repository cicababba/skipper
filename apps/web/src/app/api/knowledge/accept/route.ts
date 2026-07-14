import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { acceptAtom, parseAtom } from "@skipper/core";
import { getWorkspacePath } from "@/lib/config";
import { assertSafePendingPath } from "../safe-path";

export async function POST(request: NextRequest) {
  try {
    const { filePath } = (await request.json()) as { filePath?: string };
    if (!filePath) {
      return NextResponse.json({ error: "filePath is required" }, { status: 400 });
    }
    const workspace = getWorkspacePath();
    assertSafePendingPath(workspace, filePath);

    const raw = await readFile(filePath, "utf-8");
    const atom = parseAtom(raw);
    if (!atom) {
      return NextResponse.json({ error: "File is not a valid atom" }, { status: 400 });
    }

    const dest = await acceptAtom(workspace, { filePath, atom });
    return NextResponse.json({ ok: true, dest });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
