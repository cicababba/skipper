import type { IpcMain } from "electron";
import {
  readSolutionRecord,
  writeSolutionRecord,
  listSolutionRecords,
  deleteSolutionRecord,
  reconcileMemoryIndex,
  memoryFileName,
  applyFeedbackVote,
  createNoteRecord,
  indexOneRecord,
  searchMemory,
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
  localPathFor: (repo: RepoRef) => Promise<string | undefined>;
  runGit: (
    cwd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerMemoryHandlers(deps: MemoryIpcDeps): void {
  const { ipcMain, ensureManifest, broadcast } = deps;

  // Records are only indexed by `skipper memory reindex` today, so the browser
  // reconciles once per session before its first search. A failure (model
  // download, offline) clears the memo so a retry can succeed.
  let reconcileOnce: Promise<unknown> | null = null;
  const ensureIndexed = (): Promise<unknown> => {
    reconcileOnce ??= reconcileMemoryIndex(deps.memoryDir).catch((err) => {
      reconcileOnce = null;
      throw err;
    });
    return reconcileOnce;
  };

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
        return { ok: false as const, error: errorMessage(err) };
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
      return { ok: false as const, error: errorMessage(err) };
    }
    broadcast();
    return { ok: true as const };
  });

  // Semantic search from the Memory tab (#255). In-process: the embedding model
  // stays loaded for the session instead of reloading per query.
  ipcMain.handle("skipper:memory:search", async (_e, repo: RepoRef, query: string, k?: number) => {
    try {
      await ensureIndexed();
      const hits = await searchMemory(deps.memoryDir, query, { repo, k });
      return { ok: true as const, hits };
    } catch (err) {
      return { ok: false as const, error: errorMessage(err) };
    }
  });

  // Direct curation vote on a record (#255) — no manifest entry involved, so
  // records that were never consulted by a run can still be curated. The record's
  // own curationVote is the idempotency anchor. Query-time only — no reindex.
  ipcMain.handle("skipper:memory:curate", async (_e, id: string, vote: "up" | "down" | null) => {
    const record = await readSolutionRecord(deps.memoryDir, memoryFileName(id));
    if (!record) return { ok: false as const, error: `no memory record for id "${id}"` };
    const oldVote = record.curationVote;
    if (oldVote === (vote ?? undefined)) return { ok: true as const };
    record.feedback = applyFeedbackVote(record.feedback, oldVote, vote);
    if (vote) record.curationVote = vote;
    else delete record.curationVote;
    try {
      await writeSolutionRecord(deps.memoryDir, record);
    } catch (err) {
      return { ok: false as const, error: errorMessage(err) };
    }
    broadcast();
    return { ok: true as const };
  });

  ipcMain.handle(
    "skipper:memory:createNote",
    async (_e, repo: RepoRef, body: string, files?: string[], title?: string) => {
      if (!body.trim()) return { ok: false as const, error: "note body is empty" };
      const record = createNoteRecord(repo, body, files, title);
      let ref: string;
      try {
        ref = await writeSolutionRecord(deps.memoryDir, record);
      } catch (err) {
        return { ok: false as const, error: errorMessage(err) };
      }
      // The record file is the source of truth: a failed embedding leaves the
      // note unsearchable until the next session's reconcile heals it, which is
      // no reason to report the note as lost.
      try {
        await indexOneRecord(deps.memoryDir, ref, record);
      } catch {
        /* healed by ensureIndexed on the next session */
      }
      broadcast();
      return { ok: true as const, id: record.itemId };
    },
  );

  ipcMain.handle(
    "skipper:memory:updateNote",
    async (_e, id: string, body: string, files?: string[], title?: string) => {
      if (!body.trim()) return { ok: false as const, error: "note body is empty" };
      const record = await readSolutionRecord(deps.memoryDir, memoryFileName(id));
      if (!record) return { ok: false as const, error: `no memory record for id "${id}"` };
      if (record.kind !== "note") return { ok: false as const, error: "not a note" };
      record.note = files && files.length > 0 ? { body, files } : { body };
      if (title?.trim()) record.title = title.trim();
      let ref: string;
      try {
        ref = await writeSolutionRecord(deps.memoryDir, record);
      } catch (err) {
        return { ok: false as const, error: errorMessage(err) };
      }
      try {
        await indexOneRecord(deps.memoryDir, ref, record);
      } catch {
        /* healed by ensureIndexed on the next session */
      }
      broadcast();
      return { ok: true as const };
    },
  );

  // File autocomplete for note linking (#255): the tracked files of the linked clone.
  ipcMain.handle("skipper:memory:repoFiles", async (_e, repo: RepoRef) => {
    const localPath = await deps.localPathFor(repo);
    if (!localPath) return { ok: false as const, error: "repo not linked" };
    const res = await deps.runGit(localPath, ["ls-files"]);
    if (res.code !== 0) return { ok: false as const, error: res.stderr.trim() || "git ls-files failed" };
    return { ok: true as const, files: res.stdout.split("\n").filter(Boolean) };
  });
}
