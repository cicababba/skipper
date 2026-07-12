// ============================================================
// NestBrain — Coding runner event types (issue #9; rendered by #12/#13)
// ============================================================

export type CodingEvent =
  | { kind: "status"; phase: "fetching" | "worktree" | "agent-start" | "resuming"; detail?: string }
  | { kind: "agent-init"; sessionId: string; model?: string; tools?: string[] }
  | { kind: "text"; text: string }
  | {
      kind: "tool-use";
      tool: string;
      /** Best-effort: file path, command, or pattern from the tool input. */
      detail?: string;
    }
  | {
      kind: "result";
      ok: boolean;
      summary?: string;
      turns?: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { kind: "error"; message: string };

/** What rides the per-item IPC channel and the replay buffer. */
export interface CodingEventEnvelope {
  itemId: string;
  /** Per-run monotonic — renderer ordering + replay dedup. */
  seq: number;
  at: string; // ISO 8601
  event: CodingEvent;
}
