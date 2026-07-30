// Atlassian Document Format → markdown-ish flattener. Pure, zero deps. Jira Cloud
// returns issue descriptions as ADF documents; Data Center returns plain strings.

interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface AdfNode {
  type?: string;
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

function asNode(value: unknown): AdfNode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as AdfNode;
}

function attrString(node: AdfNode, key: string): string | undefined {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : undefined;
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content : [];
}

function applyMarks(text: string, marks: AdfMark[] | undefined): string {
  let out = text;
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "";
        out = `[${out}](${href})`;
        break;
      }
      default:
        break; // unknown mark — leave the text bare
    }
  }
  return out;
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention": {
      const text = attrString(node, "text") ?? "";
      return `@${text.replace(/^@/, "")}`;
    }
    case "emoji":
      return attrString(node, "shortName") ?? attrString(node, "text") ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return attrString(node, "url") ?? "";
    default:
      return renderInline(children(node));
  }
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length ? pad + line : line))
    .join("\n");
}

function renderList(node: AdfNode, ordered: boolean): string {
  const lines: string[] = [];
  children(node).forEach((item, i) => {
    if (item.type !== "listItem") return;
    const marker = ordered ? `${i + 1}. ` : "- ";
    const blocks = children(item).map(renderBlock).filter((b) => b.length > 0);
    const [first = "", ...rest] = blocks.join("\n").split("\n");
    lines.push(marker + first);
    for (const line of rest) lines.push(indent(line, 2));
  });
  return lines.join("\n");
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(children(node));
    case "heading": {
      const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
      return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${renderInline(children(node))}`;
    }
    case "bulletList":
      return renderList(node, false);
    case "orderedList":
      return renderList(node, true);
    case "codeBlock": {
      const lang = attrString(node, "language") ?? "";
      return `\`\`\`${lang}\n${renderInline(children(node))}\n\`\`\``;
    }
    case "blockquote":
      return children(node)
        .map(renderBlock)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "rule":
      return "---";
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return attrString(node, "alt") ?? "[attachment]";
    case "table":
      return children(node).map(renderTableRow).join("\n");
    default:
      // panel/expand/nestedExpand/taskList/taskItem/unknown → recurse into content.
      return children(node).map(renderBlock).filter((b) => b.length > 0).join("\n\n");
  }
}

function renderTableRow(row: AdfNode): string {
  return children(row)
    .map((cell) => renderInline(children(cell)).replace(/\n/g, " ").trim())
    .join(" | ");
}

export function adfToMarkdown(doc: unknown): string | undefined {
  const node = asNode(doc);
  if (!node || node.type !== "doc") return undefined;
  const out = children(node)
    .map(renderBlock)
    .filter((b) => b.length > 0)
    .join("\n\n")
    .trim();
  return out.length > 0 ? out : undefined;
}

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** Text run for a block: intra-block newlines become hardBreak nodes. Empty text
 *  yields no content at all — ADF rejects a text node with an empty string. */
function textContent(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    if (line.length > 0) out.push({ type: "text", text: line });
  });
  return out;
}

function paragraph(text: string): AdfNode {
  const content = textContent(text);
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

function listItem(text: string): AdfNode {
  return { type: "listItem", content: [paragraph(text)] };
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const FENCE_RE = /^```(\S*)\s*$/;

/**
 * Markdown → ADF, block level only (the Cloud REST API takes descriptions as ADF
 * documents, never markdown). Paragraphs, ATX headings, fenced code blocks and
 * bullet/ordered lists are structural; inline marks (bold, links, inline code)
 * are deliberately left as literal text — round-tripping them is not worth the
 * parser, and Jira renders the raw characters legibly.
 */
export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    content.push(paragraph(paragraphLines.join("\n")));
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const text = code.join("\n");
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
      });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        ...(heading[2].length > 0 ? { content: [{ type: "text", text: heading[2] }] } : {}),
      });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = bullet ? null : ORDERED_RE.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "bulletList" : "orderedList";
      const re = bullet ? BULLET_RE : ORDERED_RE;
      const items: AdfNode[] = [listItem((bullet ?? ordered!)[1])];
      while (i + 1 < lines.length) {
        const next = re.exec(lines[i + 1]);
        if (!next) break;
        items.push(listItem(next[1]));
        i++;
      }
      content.push({ type, content: items });
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();

  return { type: "doc", version: 1, content };
}
