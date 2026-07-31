import type { IpcMain } from "electron";
import type { PrReviewComment } from "@skipper/shared";
import type { EventStream } from "./event-stream";
import {
  applyPlanChatUpdate,
  cancelPlanChat,
  getPlanChatHistory,
  sendPlanChatMessage,
} from "./plan-chat";
import {
  cancelAgentChat,
  confirmCoderChatApply,
  getAgentChatHistory,
  prepareCoderChatApply,
  sendAgentChatMessage,
} from "./agent-chat";
import { startRescore } from "./rescore";

// Plan chat (#145), per-tab agent chat (#170) and the four console replay
// channels. The chat modules are init'd singletons imported directly; only the
// event streams (created in orchestrator.ts) are injected.
export interface ChatIpcDeps {
  ipcMain: IpcMain;
  codingStream: EventStream;
  planningStream: EventStream;
  reviewStream: EventStream;
  composerStream: EventStream;
}

export function registerChatHandlers(deps: ChatIpcDeps): void {
  // Conversational plan review (#145): chat with the planning session at the
  // gate. Guards (state, plan, busy) live in plan-chat.ts.
  deps.ipcMain.handle("skipper:planChat:send", (_e, itemId: string, text: string) =>
    sendPlanChatMessage(itemId, text),
  );
  deps.ipcMain.handle("skipper:planChat:apply", async (_e, itemId: string) => {
    const res = await applyPlanChatUpdate(itemId);
    // Apply re-emitted the plan — re-score it in a detached run (#164). The old
    // confidence report described the plan the discussion just rewrote.
    if (res.ok) startRescore(itemId, res.stored);
    return res;
  });
  deps.ipcMain.handle("skipper:planChat:getHistory", (_e, itemId: string) =>
    getPlanChatHistory(itemId),
  );
  deps.ipcMain.handle("skipper:planChat:cancel", (_e, itemId: string) => {
    cancelPlanChat(itemId);
  });
  // Per-tab agent chat (#170): interrogate the coder / reviewer at their tabs.
  // Guards (availability, binding, busy) live in agent-chat.ts.
  deps.ipcMain.handle(
    "skipper:agentChat:send",
    (_e, kind: unknown, itemId: string, text: string, ctx?: { selectedFile?: string }) => {
      if (kind !== "coder" && kind !== "reviewer") {
        return { ok: false as const, error: `invalid chat kind ${String(kind)}` };
      }
      return sendAgentChatMessage(kind, itemId, text, ctx);
    },
  );
  deps.ipcMain.handle("skipper:agentChat:getHistory", (_e, kind: unknown, itemId: string) => {
    if (kind !== "coder" && kind !== "reviewer") return [];
    return getAgentChatHistory(kind, itemId);
  });
  deps.ipcMain.handle("skipper:agentChat:cancel", (_e, kind: unknown, itemId: string) => {
    if (kind !== "coder" && kind !== "reviewer") return;
    cancelAgentChat(kind, itemId);
  });
  // Coder-chat Apply (#188): distill → preview, then confirm → coding re-entry.
  deps.ipcMain.handle("skipper:agentChat:prepareApply", (_e, itemId: string) =>
    prepareCoderChatApply(itemId),
  );
  deps.ipcMain.handle(
    "skipper:agentChat:confirmApply",
    (_e, itemId: string, instructions: PrReviewComment[]) =>
      confirmCoderChatApply(itemId, instructions),
  );
  // Replay for renderers that mount mid-run; live events ride the per-item channel.
  deps.ipcMain.handle("skipper:coding:getEvents", (_e, itemId: string) => {
    return deps.codingStream.getEvents(itemId);
  });
  deps.ipcMain.handle("skipper:planning:getEvents", (_e, itemId: string) => {
    return deps.planningStream.getEvents(itemId);
  });
  deps.ipcMain.handle("skipper:review:getEvents", (_e, itemId: string) => {
    return deps.reviewStream.getEvents(itemId);
  });
  deps.ipcMain.handle("skipper:composer:getEvents", (_e, key: string) => {
    return deps.composerStream.getEvents(key);
  });
}
