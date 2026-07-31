import { describe, it, expect, vi } from "vitest";
import type { LLMProviderInterface } from "../src/llm/provider";
import type { AgentRuntime, RuntimeStructuredOptions } from "../src/runtime";
import { structuredCall } from "../src/runtime";

const SCHEMA = { type: "object" } as Record<string, unknown>;

function fakes(): {
  llm: LLMProviderInterface;
  runtime: AgentRuntime;
  structured: ReturnType<typeof vi.fn>;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const structured = vi.fn(async (): Promise<unknown> => ({ from: "runtime" }));
  const askStructured = vi.fn(async (): Promise<unknown> => ({ from: "llm" }));
  const llm = {
    name: "claude-cli",
    ask: vi.fn(),
    askStructured,
  } as unknown as LLMProviderInterface;
  const runtime = { id: "codex-cli", structured } as unknown as AgentRuntime;
  return { llm, runtime, structured, askStructured };
}

describe("structuredCall", () => {
  it("runs on the runtime with no tools when one is present", async () => {
    const { llm, runtime, structured, askStructured } = fakes();
    const out = await structuredCall<{ from: string }>(runtime, llm, "prompt", SCHEMA);
    expect(out).toEqual({ from: "runtime" });
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, schema, opts] = structured.mock.calls[0] as [
      string,
      Record<string, unknown>,
      RuntimeStructuredOptions,
    ];
    expect(prompt).toBe("prompt");
    expect(schema).toBe(SCHEMA);
    expect(opts.tools).toBe("");
    expect("signal" in opts).toBe(false);
  });

  it("threads the abort signal to the runtime", async () => {
    const { llm, runtime, structured } = fakes();
    const signal = new AbortController().signal;
    await structuredCall(runtime, llm, "prompt", SCHEMA, { signal });
    const [, , opts] = structured.mock.calls[0] as [string, Record<string, unknown>, RuntimeStructuredOptions];
    expect(opts.signal).toBe(signal);
  });

  it("falls back to the completions provider when there is no runtime", async () => {
    const { llm, structured, askStructured } = fakes();
    const out = await structuredCall<{ from: string }>(undefined, llm, "prompt", SCHEMA);
    expect(out).toEqual({ from: "llm" });
    expect(structured).not.toHaveBeenCalled();
    expect(askStructured).toHaveBeenCalledWith("prompt", SCHEMA, undefined);
  });

  it("threads the abort signal to the completions fallback", async () => {
    const { llm, askStructured } = fakes();
    const signal = new AbortController().signal;
    await structuredCall(undefined, llm, "prompt", SCHEMA, { signal });
    expect(askStructured).toHaveBeenCalledWith("prompt", SCHEMA, { signal });
  });
});
