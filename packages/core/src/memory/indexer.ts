import { repoKey, type SolutionRecord } from "@skipper/shared";
import { VectorStore } from "../vectorstore";
import { listSolutionRecords } from "./store";

/**
 * Text worth embedding: plan gist + touched files. The record title is
 * excluded — VectorStore.upsert already prepends it. The diff is too noisy
 * to embed; it stays available via the full-record read.
 */
export function buildEmbedText(record: SolutionRecord): string {
  const parts: string[] = [];
  const plan = record.plan?.plan;
  if (plan) {
    parts.push(plan.summary);
    parts.push(...plan.steps.map((s) => s.title));
  }
  const files = record.diffStats?.files ?? plan?.files.map((f) => f.path) ?? [];
  if (files.length > 0) parts.push(files.join(" "));
  return parts.join("\n");
}

export async function indexSolutionRecord(
  store: VectorStore,
  ref: string,
  record: SolutionRecord,
): Promise<void> {
  await store.upsert(record.itemId, record.title, ref, "solution", buildEmbedText(record), [
    repoKey(record.repo),
  ]);
}

export interface ReconcileResult {
  indexed: number;
  removed: number;
  total: number;
}

/**
 * Bring the vector index in line with the record files: embed missing
 * records, drop entries whose record is gone. Idempotent — records are
 * immutable after capture (feedback is applied at query time, not embedded).
 */
export async function reconcileMemoryIndex(
  memoryDir: string,
  onProgress?: (message: string) => void,
): Promise<ReconcileResult> {
  const store = new VectorStore(memoryDir);
  const entries = await listSolutionRecords(memoryDir);

  let indexed = 0;
  for (const { ref, record } of entries) {
    if (await store.has(record.itemId)) continue;
    await indexSolutionRecord(store, ref, record);
    indexed++;
    onProgress?.(`indexed ${ref} (${repoKey(record.repo)} #${record.issueNumber})`);
  }

  const known = new Set(entries.map((e) => e.record.itemId));
  let removed = 0;
  for (const id of await store.ids()) {
    if (known.has(id)) continue;
    await store.remove(id);
    removed++;
    onProgress?.(`removed stale entry ${id}`);
  }

  if (indexed > 0 || removed > 0) await store.save();
  return { indexed, removed, total: entries.length };
}
