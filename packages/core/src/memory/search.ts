import { repoKey, type RepoRef, type SolutionRecord } from "@skipper/shared";
import { VectorStore } from "../vectorstore";
import { readSolutionRecord } from "./store";
import { feedbackWeight, recencyWeight } from "./ranking";

/** Wide cosine pool re-ranked with recency + feedback before taking top-k. */
const RERANK_POOL = 50;
const DEFAULT_K = 5;

export interface MemoryHit {
  /** SolutionRecord.itemId — the id `get_memory` (#45) accepts. */
  id: string;
  /** Record filename under the memory dir. */
  ref: string;
  score: number;
  title: string;
  /** Work-item display key; falls back to the number on pre-#71 records. */
  issueKey: string;
  url: string;
  pr: { number: number; url: string };
  planSummary?: string;
  filesTouched: string[];
  capturedAt: string;
  feedback?: SolutionRecord["feedback"];
}

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
        candidate.score * recencyWeight(record.capturedAt) * feedbackWeight(record.feedback),
      title: record.title,
      issueKey: record.issueKey ?? String(record.issueNumber),
      url: record.url,
      pr: record.pr,
      planSummary: record.plan?.plan.summary,
      filesTouched: record.diffStats?.files ?? record.plan?.plan.files.map((f) => f.path) ?? [],
      capturedAt: record.capturedAt,
      feedback: record.feedback,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.k ?? DEFAULT_K);
}
