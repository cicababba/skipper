import { describe, it, expect, vi } from "vitest";
import type { LLMProviderInterface } from "../src/llm";
import type { AgentRuntime } from "../src/runtime";
import {
  tryParseCoderReport,
  repairCoderReport,
  CoderReportParseError,
} from "../src/coder";

const valid = {
  done: [{ path: "src/a.ts", summary: "added a thing" }],
  deviations: ["renamed foo to bar"],
  verification: [{ command: "pnpm test", passed: true }],
  open: [],
};

describe("tryParseCoderReport", () => {
  it("parses a valid report", () => {
    const result = tryParseCoderReport(JSON.stringify(valid));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.done[0].path).toBe("src/a.ts");
      expect(result.report.deviations).toEqual(["renamed foo to bar"]);
      expect(result.report.verification[0].passed).toBe(true);
    }
  });

  it("parses a fenced report with prose around it", () => {
    const text = `Here is my report:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\ndone!`;
    const result = tryParseCoderReport(text);
    expect(result.ok).toBe(true);
  });

  it("fails a schema violation", () => {
    const result = tryParseCoderReport(JSON.stringify({ done: "not an array" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("normalizes 'None' placeholders to empty arrays", () => {
    const withNone = {
      ...valid,
      deviations: ["None"],
      open: ["none."],
    };
    const result = tryParseCoderReport(JSON.stringify(withNone));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.deviations).toEqual([]);
      expect(result.report.open).toEqual([]);
    }
  });
});

function fakeLLM(reply: unknown) {
  const askStructured = vi.fn(async () => reply);
  const structured = vi.fn(async () => reply);
  const llm: LLMProviderInterface = {
    name: "fake",
    ask: vi.fn(),
    askStructured,
  } as unknown as LLMProviderInterface;
  const runtime = { id: "codex-cli", structured } as unknown as AgentRuntime;
  return { llm, runtime, structured, askStructured };
}

describe("repairCoderReport", () => {
  it("returns the repaired report when the repair round produces valid JSON", async () => {
    const { llm } = fakeLLM(valid);
    const report = await repairCoderReport(undefined, llm, "garbage in", "parse error");
    expect(report.done[0].path).toBe("src/a.ts");
  });

  it("throws CoderReportParseError when the repair is still invalid", async () => {
    const { llm } = fakeLLM({ done: "still wrong" });
    await expect(repairCoderReport(undefined, llm, "garbage", "err")).rejects.toBeInstanceOf(
      CoderReportParseError,
    );
  });

  it("carries the raw text and passes it into the repair prompt", async () => {
    const { llm, askStructured } = fakeLLM({ done: "wrong" });
    try {
      await repairCoderReport(undefined, llm, "the-raw-final-message", "err");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CoderReportParseError);
      expect((err as CoderReportParseError).raw).toBe("the-raw-final-message");
    }
    expect(askStructured.mock.calls[0][0]).toContain("the-raw-final-message");
  });

  it("repairs on the coder's runtime when it has one, never on the provider", async () => {
    const { llm, runtime, structured, askStructured } = fakeLLM(valid);
    const report = await repairCoderReport(runtime, llm, "garbage in", "parse error");
    expect(report.done[0].path).toBe("src/a.ts");
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { tools: string },
    ];
    expect(prompt).toContain("garbage in");
    expect(opts.tools).toBe("");
  });
});
