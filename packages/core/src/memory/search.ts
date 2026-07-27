import { repoKey, type MemoryHit, type RepoRef } from "@skipper/shared";
import { VectorStore } from "../vectorstore";
import { readSolutionRecord } from "./store";
import { feedbackWeight, recencyWeight, stalenessWeight } from "./ranking";
import { recordFilesTouched } from "./staleness";

/** Wide cosine pool re-ranked with recency + feedback + staleness before taking top-k. */
const RERANK_POOL = 50;
const DEFAULT_K = 5;

export type { MemoryHit };

export interface SearchMemoryOptions {
  /** Scope — only this repo's records participate. */
  repo: RepoRef;
  k?: number;
}

export async function searchMemory(
  memoryDir: string,
  query: string,
  options: SearchMemoryOptions,
): Promise<MemoryHit[]> {
  const store = new VectorStore(memoryDir);
  const candidates = await store.search(query, RERANK_POOL, repoKey(options.repo));

  const hits: MemoryHit[] = [];
  for (const candidate of candidates) {
    const record = await readSolutionRecord(memoryDir, candidate.filePath);
    if (!record) continue;
    hits.push({
      id: record.itemId,
      ref: candidate.filePath,
      score:
        candidate.score *
        recencyWeight(record.capturedAt) *
        feedbackWeight(record.feedback) *
        stalenessWeight(record.staleness),
      title: record.title,
      issueKey: record.issueKey ?? (record.issueNumber != null ? String(record.issueNumber) : ""),
      url: record.url,
      pr: record.pr,
      kind: record.kind,
      planSummary: record.plan?.plan.summary,
      lesson: record.lesson,
      filesTouched: recordFilesTouched(record),
      capturedAt: record.capturedAt,
      feedback: record.feedback,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.k ?? DEFAULT_K);
}
