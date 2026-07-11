/**
 * Pull a JSON object/array out of a model reply that may contain a fenced
 * code block, prose preamble, or trailing chatter. We try strict parse first,
 * then look for the largest balanced { … } or [ … ] block.
 */
export function parseJsonReply<T>(text: string): T {
  const t = text.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* fall through */
  }
  // Strip a single fenced code block if the whole reply is wrapped in one.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]) as T;
    } catch {
      /* fall through */
    }
  }
  // Find the first { or [ and try to balance-match to its closer. Naive
  // (ignores strings) but works for typical model replies.
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = t.slice(start, i + 1);
          return JSON.parse(slice) as T;
        }
      }
    }
  }
  throw new Error(`No parseable JSON in model reply: ${t.slice(0, 200)}…`);
}
