import { describe, it, expect } from "vitest";
import type { PlanChatMessage } from "@skipper/shared";
import { buildComposerFallbackPrompt, buildComposerResumePrompt } from "../src/composer";

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
