// Coder/reviewer chat transcripts (#170), one JSON file per tracked item per
// kind under <userData>/plans/chat/. Pure Node module; the orchestrator injects
// plansDir. A transcript is bound to an opaque supersession key (coder →
// worktree.path, reviewer → review.at) — a new binding discards the stale file.
// The plan chat's unsuffixed file (plan-chat-store.ts) is untouched.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentChatKind, PlanChatMessage, StoredAgentChat } from "@skipper/shared";

const CHAT_DIR = "chat";

const KINDS: AgentChatKind[] = ["coder", "reviewer"];

/** Item ids contain ":" which is illegal on Windows filenames (mirrors chatFileName). */
function chatFileName(kind: AgentChatKind, itemId: string): string {
  return `${itemId.replace(/[^A-Za-z0-9._-]/g, "_")}.${kind}.json`;
}

function chatPath(plansDir: string, kind: AgentChatKind, itemId: string): string {
  return join(plansDir, CHAT_DIR, chatFileName(kind, itemId));
}

export async function readAgentChat(
  plansDir: string,
  kind: AgentChatKind,
  itemId: string,
): Promise<StoredAgentChat | null> {
  try {
    const raw = await readFile(chatPath(plansDir, kind, itemId), "utf-8");
    const parsed = JSON.parse(raw) as StoredAgentChat;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function writeAgentChat(
  plansDir: string,
  kind: AgentChatKind,
  itemId: string,
  chat: StoredAgentChat,
): Promise<void> {
  const dir = join(plansDir, CHAT_DIR);
  await mkdir(dir, { recursive: true });
  const path = chatPath(plansDir, kind, itemId);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(chat, null, 2), "utf-8");
  await rename(tmp, path);
}

/**
 * Append one user→assistant exchange, creating the file when absent and
 * discarding+recreating it when the binding no longer matches (a new worktree /
 * review round superseded the transcript). Preserves the chat's own session
 * lineage (sessionId) on a matching binding. Atomic tmp+rename.
 */
export async function appendAgentChatExchange(
  plansDir: string,
  kind: AgentChatKind,
  itemId: string,
  binding: string,
  user: string,
  assistant: string,
): Promise<StoredAgentChat> {
  const existing = await readAgentChat(plansDir, kind, itemId);
  const base: StoredAgentChat =
    existing && existing.binding === binding
      ? existing
      : { version: 1, itemId, kind, binding, messages: [] };
  const now = new Date().toISOString();
  const messages: PlanChatMessage[] = [
    ...base.messages,
    { role: "user", text: user, at: now },
    { role: "assistant", text: assistant, at: now },
  ];
  const updated: StoredAgentChat = { ...base, messages };
  await writeAgentChat(plansDir, kind, itemId, updated);
  return updated;
}

/**
 * Persist the chat's own session id for the given binding, creating the file
 * when absent (the persist-before-run write for a fallback run). A binding
 * mismatch discards the stale transcript and starts fresh.
 */
export async function setAgentChatSessionId(
  plansDir: string,
  kind: AgentChatKind,
  itemId: string,
  binding: string,
  sessionId: string,
): Promise<void> {
  const existing = await readAgentChat(plansDir, kind, itemId);
  const base: StoredAgentChat =
    existing && existing.binding === binding
      ? existing
      : { version: 1, itemId, kind, binding, messages: [] };
  await writeAgentChat(plansDir, kind, itemId, { ...base, sessionId });
}

export async function deleteAgentChat(
  plansDir: string,
  kind: AgentChatKind,
  itemId: string,
): Promise<void> {
  try {
    await unlink(chatPath(plansDir, kind, itemId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Remove both the coder and reviewer transcripts for an item (cleanup parity). */
export async function deleteAgentChats(plansDir: string, itemId: string): Promise<void> {
  await Promise.all(KINDS.map((kind) => deleteAgentChat(plansDir, kind, itemId)));
}
