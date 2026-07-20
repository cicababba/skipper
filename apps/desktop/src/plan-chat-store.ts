// Plan-review chat transcripts (#145), one JSON file per tracked item under
// <userData>/plans/chat/. Pure Node module; the orchestrator injects plansDir.
// A transcript is bound to the plan generation it was held against
// (planGeneratedAt) — a replan supersedes it, so a stale file is discarded.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanChatMessage, StoredPlanChat } from "@skipper/shared";

const CHAT_DIR = "chat";

/** Item ids contain ":" which is illegal on Windows filenames (mirrors planFileName). */
function chatFileName(itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

function chatPath(plansDir: string, itemId: string): string {
  return join(plansDir, CHAT_DIR, chatFileName(itemId));
}

export async function readPlanChat(
  plansDir: string,
  itemId: string,
): Promise<StoredPlanChat | null> {
  try {
    const raw = await readFile(chatPath(plansDir, itemId), "utf-8");
    const parsed = JSON.parse(raw) as StoredPlanChat;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Append one user→assistant exchange, creating the file when absent and
 * discarding+recreating it when planGeneratedAt no longer matches (a replan
 * superseded the transcript). Called only after a successful reply, so no
 * dangling question is ever persisted. Atomic tmp+rename.
 */
export async function appendPlanChatExchange(
  plansDir: string,
  itemId: string,
  planGeneratedAt: string,
  user: string,
  assistant: string,
): Promise<StoredPlanChat> {
  const existing = await readPlanChat(plansDir, itemId);
  const base: StoredPlanChat =
    existing && existing.planGeneratedAt === planGeneratedAt
      ? existing
      : { version: 1, itemId, planGeneratedAt, messages: [] };
  const now = new Date().toISOString();
  const messages: PlanChatMessage[] = [
    ...base.messages,
    { role: "user", text: user, at: now },
    { role: "assistant", text: assistant, at: now },
  ];
  const updated: StoredPlanChat = { ...base, messages };

  const dir = join(plansDir, CHAT_DIR);
  await mkdir(dir, { recursive: true });
  const path = chatPath(plansDir, itemId);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(updated, null, 2), "utf-8");
  await rename(tmp, path);
  return updated;
}

export async function deletePlanChat(plansDir: string, itemId: string): Promise<void> {
  try {
    await unlink(chatPath(plansDir, itemId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
