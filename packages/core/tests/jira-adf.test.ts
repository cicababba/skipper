import { describe, it, expect } from "vitest";
import { adfToMarkdown } from "../src/adapters/jira/adf";

function doc(...content: unknown[]) {
  return { type: "doc", version: 1, content };
}

function paragraph(...content: unknown[]) {
  return { type: "paragraph", content };
}

function text(value: string, marks?: unknown[]) {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

describe("adfToMarkdown", () => {
  it("renders text marks", () => {
    const out = adfToMarkdown(
      doc(
        paragraph(
          text("strong", [{ type: "strong" }]),
          text(" "),
          text("em", [{ type: "em" }]),
          text(" "),
          text("code", [{ type: "code" }]),
          text(" "),
          text("gone", [{ type: "strike" }]),
          text(" "),
          text("site", [{ type: "link", attrs: { href: "https://x.dev" } }]),
        ),
      ),
    );
    expect(out).toBe("**strong** *em* `code` ~~gone~~ [site](https://x.dev)");
  });

  it("ignores unknown marks", () => {
    const out = adfToMarkdown(doc(paragraph(text("plain", [{ type: "underline" }]))));
    expect(out).toBe("plain");
  });

  it("renders headings by level", () => {
    const out = adfToMarkdown(
      doc({ type: "heading", attrs: { level: 3 }, content: [text("Title")] }),
    );
    expect(out).toBe("### Title");
  });

  it("renders nested lists with indentation", () => {
    const out = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("top")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph(text("nested"))] }],
              },
            ],
          },
        ],
      }),
    );
    expect(out).toBe("- top\n  - nested");
  });

  it("numbers ordered lists", () => {
    const out = adfToMarkdown(
      doc({
        type: "orderedList",
        content: [
          { type: "listItem", content: [paragraph(text("one"))] },
          { type: "listItem", content: [paragraph(text("two"))] },
        ],
      }),
    );
    expect(out).toBe("1. one\n2. two");
  });

  it("fences code blocks with language", () => {
    const out = adfToMarkdown(
      doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] }),
    );
    expect(out).toBe("```ts\nconst x = 1;\n```");
  });

  it("prefixes blockquote lines", () => {
    const out = adfToMarkdown(doc({ type: "blockquote", content: [paragraph(text("quoted"))] }));
    expect(out).toBe("> quoted");
  });

  it("renders a rule and hard break", () => {
    expect(adfToMarkdown(doc({ type: "rule" }))).toBe("---");
    expect(
      adfToMarkdown(doc(paragraph(text("a"), { type: "hardBreak" }, text("b")))),
    ).toBe("a\nb");
  });

  it("renders mention, emoji, inline card, media", () => {
    expect(
      adfToMarkdown(doc(paragraph({ type: "mention", attrs: { text: "@Jane" } }))),
    ).toBe("@Jane");
    expect(
      adfToMarkdown(doc(paragraph({ type: "emoji", attrs: { shortName: ":smile:" } }))),
    ).toBe(":smile:");
    expect(
      adfToMarkdown(doc(paragraph({ type: "inlineCard", attrs: { url: "https://c.dev" } }))),
    ).toBe("https://c.dev");
    expect(adfToMarkdown(doc({ type: "mediaSingle", content: [{ type: "media" }] }))).toBe(
      "[attachment]",
    );
  });

  it("joins table cells per row", () => {
    const out = adfToMarkdown(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(text("a"))] },
              { type: "tableCell", content: [paragraph(text("b"))] },
            ],
          },
        ],
      }),
    );
    expect(out).toBe("a | b");
  });

  it("recurses into unknown container nodes", () => {
    const out = adfToMarkdown(
      doc({ type: "panel", content: [paragraph(text("inside panel"))] }),
    );
    expect(out).toBe("inside panel");
  });

  it("returns undefined for empty or invalid docs", () => {
    expect(adfToMarkdown(doc())).toBeUndefined();
    expect(adfToMarkdown(doc(paragraph()))).toBeUndefined();
    expect(adfToMarkdown(null)).toBeUndefined();
    expect(adfToMarkdown("not adf")).toBeUndefined();
    expect(adfToMarkdown({ type: "paragraph" })).toBeUndefined();
  });
});
