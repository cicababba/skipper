import { describe, it, expect } from "vitest";
import type { PlanChatMessage } from "@skipper/shared";
import {
  buildComposerFallbackPrompt,
  buildComposerResumePrompt,
  buildComposerSystemPrompt,
} from "../src/composer";

// The attachment block (#281): the turn points the runtime at files saved under
// <userData> with wording that names no tool, so every CLI's own file reader
// applies. Both builders carry it — a resume sends only the delta prompt.

const IMAGE = "/data/composer/attachments/chat-1/screenshot.png";
const PDF = "/data/composer/attachments/chat-1/spec.pdf";
const TEXT = "/data/composer/attachments/chat-1/notes.md";

/** The block sits between the draft and the final `User:` line. */
function attachmentSection(prompt: string): string[] {
  return prompt.split("\n").filter((line) => line.startsWith("Attached "));
}

describe.each([
  ["resume", (attachments?: string[]) => buildComposerResumePrompt({ message: "look", attachments })],
  [
    "fallback",
    (attachments?: string[]) =>
      buildComposerFallbackPrompt({ message: "look", history: [], attachments }),
  ],
] as const)("composer attachment block — %s builder", (_name, build) => {
  it("names the kind per extension and emits one line per path", () => {
    const prompt = build([IMAGE, PDF, TEXT]);
    expect(attachmentSection(prompt)).toEqual([
      `Attached image: ${IMAGE} — read this file before answering.`,
      `Attached PDF: ${PDF} — read this file before answering.`,
      `Attached file: ${TEXT} — read this file before answering.`,
    ]);
  });

  it("recognises every image extension, case-insensitively", () => {
    const images = [".png", ".jpg", ".jpeg", ".webp", ".gif"].map((ext) => `/a/shot${ext}`);
    const prompt = build([...images, "/a/SHOT.PNG"]);
    expect(attachmentSection(prompt).every((line) => line.startsWith("Attached image:"))).toBe(true);
  });

  it("places the block before the final User line", () => {
    const lines = build([IMAGE]).split("\n");
    expect(lines.at(-1)).toBe("User: look");
    expect(lines.findIndex((l) => l.startsWith("Attached "))).toBeLessThan(lines.length - 1);
  });

  it("names no tool — the wording stays runtime-neutral", () => {
    const prompt = build([IMAGE]);
    expect(prompt).not.toMatch(/Read tool|view_image|read_file/);
  });

  it("emits nothing when there are no attachments", () => {
    expect(attachmentSection(build())).toEqual([]);
    expect(attachmentSection(build([]))).toEqual([]);
    expect(build([])).toBe(build());
  });
});

// Git-history grounding (#280): the system prompt is shared by every runtime, so
// it may name no CLI's tools, and it must point the composer at the history when
// the request is about code that already exists.
describe("buildComposerSystemPrompt (#280)", () => {
  const prompt = buildComposerSystemPrompt({});

  it("names no claude tool", () => {
    expect(prompt).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
  });

  it("asks for git log and git blame, conditionally", () => {
    expect(prompt).toContain("git log");
    expect(prompt).toContain("git log -- <path>");
    expect(prompt).toContain("git blame");
    expect(prompt).toMatch(/existing behavior, a regression, or code that already exists/);
  });

  it("asks for commit subjects as convention evidence and for cited references", () => {
    expect(prompt).toMatch(/commit subjects/);
    expect(prompt).toMatch(/commits, issues and pull requests[\s\S]*by sha or number/);
  });

  it("carries the no-shell fallback", () => {
    expect(prompt).toMatch(/Skip the history silently when you have no shell tool available/);
  });

  it("keeps the do-not-modify prohibition", () => {
    expect(prompt).toContain("Do NOT modify any file, including via your shell.");
  });

  it("survives the repo-conventions and graph sections", () => {
    const withExtras = buildComposerSystemPrompt({
      repoInstructions: "Use tabs.",
      graphify: {
        mcp: { mcpBinPath: "/tools/bin/graphify-mcp", graphPath: "/graphs/g.json" },
        indexedSha: "abc1234",
      },
    });
    expect(withExtras).toContain("git blame");
    expect(withExtras).toContain("Use tabs.");
    expect(withExtras).not.toMatch(/\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/);
  });
});

// A degraded fresh run re-seeds from the transcript, so past attachments have to
// survive as text or the discussion loses them.
describe("renderHistory attachments (#281)", () => {
  const history: PlanChatMessage[] = [
    {
      role: "user",
      text: "why is the header cut off?",
      at: "2026-07-29T00:00:00.000Z",
      attachments: [
        { name: "screenshot.png", path: IMAGE },
        { name: "spec.pdf", path: PDF },
      ],
    },
    { role: "assistant", text: "the topbar overflows", at: "2026-07-29T00:00:01.000Z" },
  ];

  it("marks each attached path under its user turn", () => {
    const prompt = buildComposerFallbackPrompt({ message: "go on", history });
    expect(prompt).toContain(
      `User: why is the header cut off?\n[Attached file: ${IMAGE}]\n[Attached file: ${PDF}]`,
    );
  });

  it("leaves turns without attachments untouched", () => {
    const prompt = buildComposerFallbackPrompt({ message: "go on", history });
    expect(prompt).toContain("Assistant: the topbar overflows");
    expect(prompt.match(/\[Attached file: /g)).toHaveLength(2);
  });
});
