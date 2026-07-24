/**
 * Pull a JSON object/array out of a model reply that may contain a fenced
 * code block, prose preamble, or trailing chatter. Ordered ladder, first
 * success wins: strict parse → fenced blocks → balanced scan → trailing-comma
 * strip. Everything here is deterministic — the LLM repair round only pays for
 * what this cannot recover.
 */
export function parseJsonReply<T>(text: string): T {
  const t = text.trim();
  for (const candidate of candidates(t)) {
    const parsed = tryParse<T>(candidate);
    if (parsed.ok) return parsed.value;
  }
  throw new Error(`No parseable JSON in model reply: ${t.slice(0, 200)}…`);
}

function* candidates(t: string): Generator<string> {
  yield t;
  // Fenced blocks anywhere in the reply, last first: models that narrate before
  // answering put the payload in the final fence.
  for (const block of fencedBlocks(t).reverse()) yield block;
  const scanned = balancedSlice(t);
  if (scanned) yield scanned;
}

function tryParse<T>(candidate: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch {
    /* fall through to the coercion */
  }
  const stripped = stripTrailingCommas(candidate);
  if (stripped !== candidate) {
    try {
      return { ok: true, value: JSON.parse(stripped) as T };
    } catch {
      /* unrecoverable */
    }
  }
  return { ok: false };
}

function fencedBlocks(t: string): string[] {
  const blocks: string[] = [];
  const re = /```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) blocks.push(m[1].trim());
  return blocks;
}

/**
 * First { or [ balance-matched to its closer, skipping over string literals so
 * braces inside plan prose don't miscount depth.
 */
function balancedSlice(t: string): string | undefined {
  const start = t.search(/[{[]/);
  if (start < 0) return undefined;
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return t.slice(start, i + 1);
  }
  return undefined;
}

function stripTrailingCommas(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "," && /^\s*[}\]]/.test(s.slice(i + 1))) continue;
    out += c;
  }
  return out;
}
