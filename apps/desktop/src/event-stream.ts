import type { BrowserWindow } from "electron";
import type { CodingEvent, CodingEventEnvelope } from "@skipper/shared";

// Fine-grained agent progress (#9): replay buffer + per-item channel, the
// terminal.ts per-id pattern. One factory backs the coding, planning, and
// review streams — each with its own buffers so one run's reset never wipes
// another stream's history.
export const EVENT_BUFFER_MAX = 500;

export interface EventStream {
  emit(itemId: string, event: CodingEvent): void;
  getEvents(itemId: string): CodingEventEnvelope[];
}

export function makeEventStream(opts: {
  channel: string;
  resetPhase: string;
  getWindow: () => BrowserWindow | null;
  onReset?: (itemId: string) => void;
  onEvent?: (itemId: string, event: CodingEvent) => void;
}): EventStream {
  const events = new Map<string, CodingEventEnvelope[]>();
  const seqs = new Map<string, number>();

  function emit(itemId: string, event: CodingEvent): void {
    // A new run restarts the stream: reset the buffer so replay never mixes runs.
    if (event.kind === "status" && event.phase === opts.resetPhase) {
      events.set(itemId, []);
      seqs.set(itemId, 0);
      opts.onReset?.(itemId);
    }
    const seq = seqs.get(itemId) ?? 0;
    seqs.set(itemId, seq + 1);
    const envelope: CodingEventEnvelope = { itemId, seq, at: new Date().toISOString(), event };
    const buffer = events.get(itemId) ?? [];
    buffer.push(envelope);
    if (buffer.length > EVENT_BUFFER_MAX) buffer.shift();
    events.set(itemId, buffer);
    opts.onEvent?.(itemId, event);
    const win = opts.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(`skipper:${opts.channel}:event:${itemId}`, envelope);
    }
  }

  function getEvents(itemId: string): CodingEventEnvelope[] {
    return events.get(itemId) ?? [];
  }

  return { emit, getEvents };
}
