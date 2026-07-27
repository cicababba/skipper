// Usage counters (#256): what the agents actually did with a memory. Offers are
// cheap and noisy (the record entered a top-k), fetches are the strong signal
// (an agent spent tokens reading the full record). Written by the MCP serve
// subprocess on the record file itself — best-effort by contract: a tool result
// must never fail because a counter could not be persisted.

import type { SolutionRecord } from "@skipper/shared";
import { readSolutionRecord, writeSolutionRecord } from "./store";

export function applyOffered(record: SolutionRecord, nowIso: string): SolutionRecord {
  return { ...record, offeredCount: (record.offeredCount ?? 0) + 1, lastOfferedAt: nowIso };
}

export function applyFetched(record: SolutionRecord, nowIso: string): SolutionRecord {
  return { ...record, fetchedCount: (record.fetchedCount ?? 0) + 1, lastFetchedAt: nowIso };
}

async function bump(
  memoryDir: string,
  ref: string,
  apply: (record: SolutionRecord, nowIso: string) => SolutionRecord,
  nowIso: string,
): Promise<void> {
  try {
    const record = await readSolutionRecord(memoryDir, ref);
    if (!record) return;
    await writeSolutionRecord(memoryDir, apply(record, nowIso));
  } catch {
    /* a lost counter is not worth failing a retrieval over */
  }
}

/** One bump per record that entered the returned top-k. */
export async function bumpOffered(memoryDir: string, refs: string[]): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const ref of refs) await bump(memoryDir, ref, applyOffered, nowIso);
}

export async function bumpFetched(memoryDir: string, ref: string): Promise<void> {
  await bump(memoryDir, ref, applyFetched, new Date().toISOString());
}
