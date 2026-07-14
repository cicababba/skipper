import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { parseAtom, updatePendingAtom, type KnowledgeAtom } from "@skipper/core";
import { getWorkspacePath } from "@/lib/config";
import { assertSafePendingPath } from "../safe-path";

export async function POST(request: NextRequest) {
  try {
    const { filePath, title, body, tags, score } = (await request.json()) as {
      filePath?: string;
      title?: string;
      body?: string;
      tags?: string[];
      score?: number;
    };
    if (!filePath) {
      return NextResponse.json({ error: "filePath is required" }, { status: 400 });
    }
    const workspace = getWorkspacePath();
    assertSafePendingPath(workspace, filePath);

    const raw = await readFile(filePath, "utf-8");
    const original = parseAtom(raw);
    if (!original) {
      return NextResponse.json({ error: "File is not a valid atom" }, { status: 400 });
    }
    const updated: KnowledgeAtom = {
      ...original,
      title: typeof title === "string" && title.trim() ? title.trim() : original.title,
      body: typeof body === "string" ? body : original.body,
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : original.tags,
      score: typeof score === "number" && Number.isFinite(score)
        ? Math.max(0, Math.min(10, Math.round(score)))
        : original.score,
    };
    const newPath = await updatePendingAtom(filePath, updated);
    return NextResponse.json({ ok: true, filePath: newPath, atom: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
