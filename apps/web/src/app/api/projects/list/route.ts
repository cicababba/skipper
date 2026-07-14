import { NextResponse } from "next/server";
import { VectorStore } from "@skipper/core";
import { getDataPaths } from "@/lib/config";

/**
 * List projects known to the knowledge base, with the count of indexed
 * articles (summaries + concepts) attributed to each. Used by the search /
 * ask filter dropdowns. The vector index is the source of truth — projects
 * with zero indexed articles simply don't appear.
 */
export async function GET() {
  try {
    const { wikiPath } = getDataPaths();
    const store = new VectorStore(wikiPath);
    const projects = await store.projectCounts();
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
