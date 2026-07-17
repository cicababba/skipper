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
