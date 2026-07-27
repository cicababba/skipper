import { displayKey, repoKey, type SolutionRecord } from "@skipper/shared";
import { VectorStore } from "../vectorstore";
import { listSolutionRecords } from "./store";

/**
 * Text worth embedding: plan gist + distilled lesson + touched files. The record
 * title is excluded — VectorStore.upsert already prepends it. The diff is too
 * noisy to embed; it stays available via the full-record read.
 */
export function buildEmbedText(record: SolutionRecord): string {
  if (record.kind === "note" && record.note) {
    const parts = [record.note.body];
    if (record.note.files && record.note.files.length > 0) {
      parts.push(record.note.files.join(" "));
    }
    return parts.join("\n");
  }
  const parts: string[] = [];
  const plan = record.plan?.plan;
  if (plan) {
    parts.push(plan.summary);
    parts.push(...plan.steps.map((s) => s.title));
  }
  if (record.lesson) parts.push(record.lesson);
  const files = record.diffStats?.files ?? plan?.files.map((f) => f.path) ?? [];
  if (files.length > 0) parts.push(files.join(" "));
  return parts.join("\n");
}

export async function indexSolutionRecord(
  store: VectorStore,
  ref: string,
  record: SolutionRecord,
): Promise<void> {
  await store.upsert(
    record.itemId,
    record.title,
    ref,
    record.kind === "note" ? "note" : "solution",
    buildEmbedText(record),
    [repoKey(record.repo)],
  );
}

/**
 * Index (or re-index) one record against the shared store and persist it.
 * Re-upserting re-embeds, so an edited note becomes findable by its new wording.
 */
export async function indexOneRecord(
  memoryDir: string,
  ref: string,
  record: SolutionRecord,
): Promise<void> {
  const store = new VectorStore(memoryDir);
  await indexSolutionRecord(store, ref, record);
  await store.save();
}

export interface ReconcileResult {
  indexed: number;
  removed: number;
  total: number;
}

/**
 * Bring the vector index in line with the record files: embed missing
 * records, drop entries whose record is gone. Already-indexed ids are skipped,
 * so a record whose embedded text changed (a lesson distilled onto it, #256; a
 * note edited, #255) must be handed to indexOneRecord by whoever changed it —
 * reconcile only heals absences.
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
    onProgress?.(
      `indexed ${ref} (${repoKey(record.repo)} ${displayKey(record.issueKey ?? (record.issueNumber != null ? String(record.issueNumber) : record.itemId))})`,
    );
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
