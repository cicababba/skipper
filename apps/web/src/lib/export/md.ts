// Markdown primitives for the artifact export (#216). Pure string helpers shared
// by every serializer; no React, no window.

/** Longest run of consecutive backticks anywhere in the text. */
function longestBacktickRun(content: string): number {
  let longest = 0;
  const matches = content.match(/`+/g);
  if (matches) for (const m of matches) longest = Math.max(longest, m.length);
  return longest;
}

/**
 * Fence `content` in a code block whose fence is long enough to survive any
 * backtick run inside it (GFM rule: the fence must exceed the longest embedded
 * run). Minimum three backticks.
 */
export function fenceBlock(content: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** Join blocks with `sep`, dropping null/undefined and whitespace-only entries. */
export function joinBlocks(
  blocks: (string | null | undefined)[],
  sep = "\n\n",
): string {
  return blocks.filter((b): b is string => b != null && b.trim() !== "").join(sep);
}

/** A definition-style list item: `- **Label:** value`. */
export function bullet(label: string, value: string): string {
  return `- **${label}:** ${value}`;
}

/** A 0..1 fraction as a whole-percent string: 0.87 → "87%". */
export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
