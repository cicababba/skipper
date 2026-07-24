import type { IpcMain } from "electron";
import {
  readSolutionRecord,
  writeSolutionRecord,
  listSolutionRecords,
  deleteSolutionRecord,
  reconcileMemoryIndex,
  memoryFileName,
  applyFeedbackVote,
  saveOrchestratorManifest,
  type OrchestratorManifest,
} from "@skipper/core";
import { repoKey } from "@skipper/shared";
import type { MemoryPhase, RepoRef } from "@skipper/shared";

export interface MemoryIpcDeps {
  ipcMain: IpcMain;
  memoryDir: string;
  manifestFilePath: string;
  ensureManifest: () => Promise<OrchestratorManifest>;
  broadcast: () => void;
}

export function registerMemoryHandlers(deps: MemoryIpcDeps): void {
  const { ipcMain, ensureManifest, broadcast } = deps;
  // Solutions memory surface (#46). get/feedback drive the "memories used" card;
  // list is the read side #47's browser will consume.
  ipcMain.handle("skipper:memory:get", async (_e, id: string) => {
    return readSolutionRecord(deps.memoryDir, memoryFileName(id));
  });
  ipcMain.handle("skipper:memory:list", async (_e, repo: RepoRef) => {
    const key = repoKey(repo);
    const entries = await listSolutionRecords(deps.memoryDir);
    return entries
      .map((e) => e.record)
      .filter((r) => repoKey(r.repo) === key);
  });
  // 👍/👎 (#46): move the record's aggregate counters by the delta between the
  // item entry's old vote and the new one, and store the new vote as the local
  // idempotency anchor. Feedback is query-time only — no reindex.
  ipcMain.handle(
    "skipper:memory:feedback",
    async (_e, itemId: string, phase: MemoryPhase, id: string, vote: "up" | "down" | null) => {
      const m = await ensureManifest();
      const entry = m.items[itemId]?.usedMemory?.[phase]?.find((ref) => ref.id === id);
      if (!entry) return { ok: false as const, error: "used-memory entry not found" };
      const record = await readSolutionRecord(deps.memoryDir, memoryFileName(id));
      if (!record) return { ok: false as const, error: `no memory record for id "${id}"` };
      const oldVote = entry.vote;
      if (oldVote === (vote ?? undefined)) return { ok: true as const };
      record.feedback = applyFeedbackVote(record.feedback, oldVote, vote);
      try {
        await writeSolutionRecord(deps.memoryDir, record);
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
      if (vote) entry.vote = vote;
      else delete entry.vote;
      await saveOrchestratorManifest(deps.manifestFilePath, m);
      broadcast();
      return { ok: true as const };
    },
  );
  // Delete a record from the browser (#47): drop the file, then reconcile the
  // vector index so the removed record stops surfacing in retrieval.
  ipcMain.handle("skipper:memory:delete", async (_e, id: string) => {
    const removed = await deleteSolutionRecord(deps.memoryDir, memoryFileName(id));
    if (!removed) return { ok: false as const, error: `no memory record for id "${id}"` };
    try {
      await reconcileMemoryIndex(deps.memoryDir);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
    broadcast();
    return { ok: true as const };
  });
}
