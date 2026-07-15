export interface NdjsonBuffer {
  feed: (chunk: string) => void;
  flush: () => void;
}

/**
 * Stateful NDJSON feeder: buffers partial lines across chunks and hands each
 * parsed object to `onLine`. Malformed lines are dropped rather than thrown —
 * a CLI can interleave non-JSON noise on stdout, and a parse error there must
 * not take down the run.
 */
export function createNdjsonBuffer(onLine: (obj: Record<string, unknown>) => void): NdjsonBuffer {
  let buffer = "";

  const emitLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed === "object" && parsed !== null) {
      onLine(parsed as Record<string, unknown>);
    }
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        emitLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      emitLine(buffer);
      buffer = "";
    },
  };
}
