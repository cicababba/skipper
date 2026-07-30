// ============================================================
// Skipper — Agent event types, shared by the coding runner (#9)
// and the planner console (#32)
// ============================================================

export type CodingEvent =
  | {
      kind: "status";
      phase: "fetching" | "worktree" | "agent-start" | "resuming" | "scoring" | "graphify";
      detail?: string;
    }
  | { kind: "agent-init"; sessionId: string; model?: string; tools?: string[] }
  | { kind: "text"; text: string }
  // A partial-message increment for the streaming draft bubble (#277) — distinct
  // from `text`, which carries a whole content block. Coalesced upstream so the
  // replay buffer isn't flooded; concatenated (no separator) into the live draft.
  | { kind: "text-delta"; text: string }
  | {
      kind: "tool-use";
      tool: string;
      /** Best-effort: file path, command, pattern, or memory query/id from the tool input. */
      detail?: string;
      /** Full tool input, JSON-stringified and capped — the console expand view. */
      input?: string;
    }
  | {
      kind: "result";
      ok: boolean;
      summary?: string;
      turns?: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { kind: "error"; message: string };

// Chat turns are segmented in the renderer purely from the `resuming` status
// detail the desktop emits when a turn opens (#260). Both sides of that contract
// read these constants: the emitters in apps/desktop/src/{plan-chat,agent-chat,
// composer-chat}.ts and the turn reducer in apps/web/src/lib/inbox/chat-turns.ts.
// A new `resuming` emitter on the planning / coding / review / composer streams
// must NOT reuse these values.
export const CHAT_TURN_DETAILS = {
  planChat: "plan chat",
  planApply: "apply plan changes",
  coderChat: "coder chat",
  reviewerChat: "reviewer chat",
  coderApply: "apply coder chat",
  composerChat: "composer chat",
  composerDraft: "composer draft",
} as const;

/** What rides the per-item IPC channel and the replay buffer. */
export interface CodingEventEnvelope {
  itemId: string;
  /** Per-run monotonic — renderer ordering + replay dedup. */
  seq: number;
  at: string; // ISO 8601
  event: CodingEvent;
}
