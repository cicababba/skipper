import { describe, it, expect, vi, afterEach } from "vitest";
import { sessionRuntimeOf } from "@skipper/shared";
import { ClaudeCLIProvider } from "../src/llm/claude-cli";
import { CodexCli } from "../src/llm/codex-cli";
import { CopilotCli } from "../src/llm/copilot-cli";
import { GeminiCli } from "../src/llm/gemini-cli";
import {
  createRuntime,
  ClaudeCliRuntime,
  CLAUDE_CLI_CAPABILITIES,
  CodexCliRuntime,
  CODEX_CLI_CAPABILITIES,
  CopilotCliRuntime,
  COPILOT_CLI_CAPABILITIES,
  GeminiCliRuntime,
  GEMINI_CLI_CAPABILITIES,
} from "../src/runtime";
import { runCodingAgent } from "../src/coder/run";
import { runCodexCodingAgent } from "../src/coder/codex-run";
import { runCopilotCodingAgent } from "../src/coder/copilot-run";
import { runGeminiCodingAgent } from "../src/coder/gemini-run";

// The coding run is a direct import; mock the module so runCoding delegation can
// be asserted without spawning claude. agent()/structured() delegate to the
// wrapped ClaudeCLIProvider, spied on its prototype (also never spawns).
vi.mock("../src/coder/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/coder/run")>();
  return { ...actual, runCodingAgent: vi.fn() };
});

vi.mock("../src/coder/codex-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/coder/codex-run")>();
  return { ...actual, runCodexCodingAgent: vi.fn() };
});

vi.mock("../src/coder/copilot-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/coder/copilot-run")>();
  return { ...actual, runCopilotCodingAgent: vi.fn() };
});

vi.mock("../src/coder/gemini-run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/coder/gemini-run")>();
  return { ...actual, runGeminiCodingAgent: vi.fn() };
});

describe("createRuntime (#238)", () => {
  it("builds a ClaudeCliRuntime with the claude-cli capability matrix", () => {
    const rt = createRuntime({ provider: "claude-cli", model: "sonnet", maxTurns: 5 });
    expect(rt).toBeInstanceOf(ClaudeCliRuntime);
    expect(rt!.id).toBe("claude-cli");
    expect(rt!.capabilities).toEqual(CLAUDE_CLI_CAPABILITIES);
    expect(CLAUDE_CLI_CAPABILITIES).toEqual({
      streaming: true,
      resume: true,
      confinement: "rules",
      mcp: true,
    });
  });

  it("returns undefined for a completions-only provider (openai)", () => {
    expect(createRuntime({ provider: "openai", model: "gpt-4o", maxTurns: 5 })).toBeUndefined();
  });

  it("keeps the provider's own runtime when runtime is omitted or claude-cli (#239)", () => {
    expect(createRuntime({ provider: "claude-cli", model: "sonnet", maxTurns: 5 })).toBeInstanceOf(
      ClaudeCliRuntime,
    );
    expect(
      createRuntime({ provider: "claude-cli", model: "sonnet", maxTurns: 5, runtime: "claude-cli" }),
    ).toBeInstanceOf(ClaudeCliRuntime);
  });
});

describe("createRuntime with runtime: codex-cli (#239)", () => {
  it("builds a CodexCliRuntime with the sandbox capability matrix", () => {
    const rt = createRuntime({
      provider: "claude-cli",
      model: "gpt-5-codex",
      maxTurns: 5,
      runtime: "codex-cli",
    });
    expect(rt).toBeInstanceOf(CodexCliRuntime);
    expect(rt!.id).toBe("codex-cli");
    expect(rt!.capabilities).toEqual(CODEX_CLI_CAPABILITIES);
    expect(CODEX_CLI_CAPABILITIES).toEqual({
      streaming: true,
      resume: true,
      confinement: "sandbox",
      mcp: true,
    });
  });

  // Codex is an agent runtime, not a completions backend (#239 D2): the runtime
  // selection wins over the provider, which still governs the non-agentic calls.
  it("selects codex regardless of the completions provider", () => {
    const rt = createRuntime({
      provider: "openai",
      model: "gpt-5-codex",
      maxTurns: 5,
      runtime: "codex-cli",
    });
    expect(rt).toBeInstanceOf(CodexCliRuntime);
  });
});

describe("createRuntime with runtime: copilot-cli (#242)", () => {
  it("builds a CopilotCliRuntime with the rules capability matrix", () => {
    const rt = createRuntime({
      provider: "claude-cli",
      model: "",
      maxTurns: 5,
      runtime: "copilot-cli",
    });
    expect(rt).toBeInstanceOf(CopilotCliRuntime);
    expect(rt!.id).toBe("copilot-cli");
    expect(rt!.capabilities).toEqual(COPILOT_CLI_CAPABILITIES);
    // "rules", not "sandbox": copilot verifies paths in-process and honours tool
    // deny rules, but runs no OS sandbox (#242 D1).
    expect(COPILOT_CLI_CAPABILITIES).toEqual({
      streaming: true,
      resume: true,
      confinement: "rules",
      mcp: true,
    });
  });

  it("selects copilot regardless of the completions provider", () => {
    expect(
      createRuntime({ provider: "openai", model: "", maxTurns: 5, runtime: "copilot-cli" }),
    ).toBeInstanceOf(CopilotCliRuntime);
  });
});

describe("createRuntime with runtime: gemini-cli (#243)", () => {
  it("builds a GeminiCliRuntime that declares no confinement", () => {
    const rt = createRuntime({
      provider: "claude-cli",
      model: "",
      maxTurns: 5,
      runtime: "gemini-cli",
    });
    expect(rt).toBeInstanceOf(GeminiCliRuntime);
    expect(rt!.id).toBe("gemini-cli");
    expect(rt!.capabilities).toEqual(GEMINI_CLI_CAPABILITIES);
    // "none", not "rules": gemini's approval mode denies a whole tool but cannot
    // path-scope a write, and its native sandbox needs docker/podman (#243 D4).
    // The worktree tripwire stays the real guard.
    expect(GEMINI_CLI_CAPABILITIES).toEqual({
      streaming: true,
      resume: true,
      confinement: "none",
      mcp: true,
    });
  });

  it("selects gemini regardless of the completions provider", () => {
    expect(
      createRuntime({ provider: "openai", model: "", maxTurns: 5, runtime: "gemini-cli" }),
    ).toBeInstanceOf(GeminiCliRuntime);
  });
});

describe("GeminiCliRuntime delegation (#243)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agent() delegates to the wrapped GeminiCli with the same args", async () => {
    const reply = { text: "planned" };
    const spy = vi.spyOn(GeminiCli.prototype, "agent").mockResolvedValue(reply);
    const opts = { cwd: "/repo", maxTurns: 12 };
    const out = await new GeminiCliRuntime("gemini-2.5-pro").agent("do it", opts);
    expect(spy).toHaveBeenCalledWith("do it", opts);
    expect(out).toBe(reply);
  });

  it("structured() delegates to the wrapped GeminiCli with the same args", async () => {
    const schema = { type: "object" };
    const spy = vi.spyOn(GeminiCli.prototype, "structured").mockResolvedValue({ ok: true } as never);
    const opts = { tools: "Read,Grep,Glob", cwd: "/repo", maxTurns: 8 };
    const out = await new GeminiCliRuntime("gemini-2.5-pro").structured(
      "critique the diff",
      schema,
      opts,
    );
    expect(spy).toHaveBeenCalledWith("critique the diff", schema, opts);
    expect(out).toEqual({ ok: true });
  });

  it("runCoding() delegates to runGeminiCodingAgent, forwarding the options", async () => {
    const result = { ok: true, summary: "done", sessionId: "sess-gemini" };
    vi.mocked(runGeminiCodingAgent).mockResolvedValue(result as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "gemini-2.5-pro", onEvent: () => {} };
    const out = await new GeminiCliRuntime("gemini-2.5-pro").runCoding(opts as never);
    expect(runGeminiCodingAgent).toHaveBeenCalledWith(opts);
    expect(out).toBe(result);
    expect(runCodingAgent).not.toHaveBeenCalled();
    expect(runCodexCodingAgent).not.toHaveBeenCalled();
    expect(runCopilotCodingAgent).not.toHaveBeenCalled();
  });

  // #240: role models are Claude aliases (#59), and a driver hands its role model
  // to every runtime unconditionally — so the guard lives here.
  it("runCoding() overrides the caller's model with its own", async () => {
    vi.mocked(runGeminiCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "sonnet", onEvent: () => {} };
    await new GeminiCliRuntime("gemini-2.5-pro").runCoding(opts as never);
    expect(runGeminiCodingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-2.5-pro", prompt: "code it", cwd: "/wt" }),
    );
  });

  // buildLlm constructs the gemini runtime with an empty model, so the run falls
  // through to gemini's own configured default instead of a Claude alias.
  it("runCoding() passes no model when the runtime was built without one", async () => {
    vi.mocked(runGeminiCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "opus", onEvent: () => {} };
    await new GeminiCliRuntime("").runCoding(opts as never);
    expect(runGeminiCodingAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "" }));
    await new GeminiCliRuntime().runCoding(opts as never);
    expect(runGeminiCodingAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });
});

describe("CopilotCliRuntime delegation (#242)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agent() delegates to the wrapped CopilotCli with the same args", async () => {
    const reply = { text: "planned" };
    const spy = vi.spyOn(CopilotCli.prototype, "agent").mockResolvedValue(reply);
    const opts = { cwd: "/repo", maxTurns: 12 };
    const out = await new CopilotCliRuntime("claude-sonnet-4.5").agent("do it", opts);
    expect(spy).toHaveBeenCalledWith("do it", opts);
    expect(out).toBe(reply);
  });

  it("structured() delegates to the wrapped CopilotCli with the same args", async () => {
    const schema = { type: "object" };
    const spy = vi.spyOn(CopilotCli.prototype, "structured").mockResolvedValue({ ok: true } as never);
    const opts = { tools: "Read,Grep,Glob", cwd: "/repo", maxTurns: 8 };
    const out = await new CopilotCliRuntime("claude-sonnet-4.5").structured(
      "critique the diff",
      schema,
      opts,
    );
    expect(spy).toHaveBeenCalledWith("critique the diff", schema, opts);
    expect(out).toEqual({ ok: true });
  });

  it("runCoding() delegates to runCopilotCodingAgent, forwarding the options", async () => {
    const result = { ok: true, summary: "done", sessionId: "sess-copilot" };
    vi.mocked(runCopilotCodingAgent).mockResolvedValue(result as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "claude-sonnet-4.5", onEvent: () => {} };
    const out = await new CopilotCliRuntime("claude-sonnet-4.5").runCoding(opts as never);
    expect(runCopilotCodingAgent).toHaveBeenCalledWith(opts);
    expect(out).toBe(result);
    expect(runCodingAgent).not.toHaveBeenCalled();
    expect(runCodexCodingAgent).not.toHaveBeenCalled();
  });

  // #240: role models are Claude aliases (#59), and a driver hands its role model
  // to every runtime unconditionally — so the guard lives here.
  it("runCoding() overrides the caller's model with its own", async () => {
    vi.mocked(runCopilotCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "sonnet", onEvent: () => {} };
    await new CopilotCliRuntime("gpt-5").runCoding(opts as never);
    expect(runCopilotCodingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5", prompt: "code it", cwd: "/wt" }),
    );
  });

  // buildLlm constructs the copilot runtime with an empty model, so the run falls
  // through to copilot's own configured default instead of a Claude alias.
  it("runCoding() passes no model when the runtime was built without one", async () => {
    vi.mocked(runCopilotCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "opus", onEvent: () => {} };
    await new CopilotCliRuntime("").runCoding(opts as never);
    expect(runCopilotCodingAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "" }));
    await new CopilotCliRuntime().runCoding(opts as never);
    expect(runCopilotCodingAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });
});

describe("CodexCliRuntime delegation (#239)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agent() delegates to the wrapped CodexCli with the same args", async () => {
    const reply = { text: "planned" };
    const spy = vi.spyOn(CodexCli.prototype, "agent").mockResolvedValue(reply);
    const opts = { cwd: "/repo", maxTurns: 12 };
    const out = await new CodexCliRuntime("gpt-5-codex").agent("do it", opts);
    expect(spy).toHaveBeenCalledWith("do it", opts);
    expect(out).toBe(reply);
  });

  it("structured() delegates to the wrapped CodexCli with the same args", async () => {
    const schema = { type: "object" };
    const spy = vi.spyOn(CodexCli.prototype, "structured").mockResolvedValue({ ok: true } as never);
    const opts = { tools: "Read,Grep,Glob", cwd: "/repo", maxTurns: 8 };
    const out = await new CodexCliRuntime("gpt-5-codex").structured("critique the diff", schema, opts);
    expect(spy).toHaveBeenCalledWith("critique the diff", schema, opts);
    expect(out).toEqual({ ok: true });
  });

  it("runCoding() delegates to runCodexCodingAgent, forwarding the options", async () => {
    const result = { ok: true, summary: "done", sessionId: "thread-1" };
    vi.mocked(runCodexCodingAgent).mockResolvedValue(result as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "gpt-5-codex", onEvent: () => {} };
    const out = await new CodexCliRuntime("gpt-5-codex").runCoding(opts as never);
    expect(runCodexCodingAgent).toHaveBeenCalledWith(opts);
    expect(out).toBe(result);
    expect(runCodingAgent).not.toHaveBeenCalled();
  });

  // #240: role models are Claude aliases (#59). A driver hands its role model to
  // every runtime unconditionally, so the guard has to live here — otherwise a
  // codex role run would ship `codex --model sonnet` and fail.
  it("runCoding() overrides the caller's model with its own", async () => {
    vi.mocked(runCodexCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "sonnet", onEvent: () => {} };
    await new CodexCliRuntime("gpt-5-codex").runCoding(opts as never);
    expect(runCodexCodingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5-codex", prompt: "code it", cwd: "/wt" }),
    );
  });

  // buildLlm constructs the codex runtime with an empty model, so the run falls
  // through to codex's own configured default instead of a Claude alias.
  it("runCoding() passes no model when the runtime was built without one", async () => {
    vi.mocked(runCodexCodingAgent).mockResolvedValue({ ok: true } as never);
    const opts = { prompt: "code it", cwd: "/wt", model: "opus", onEvent: () => {} };
    await new CodexCliRuntime("").runCoding(opts as never);
    expect(runCodexCodingAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "" }));
    await new CodexCliRuntime().runCoding(opts as never);
    expect(runCodexCodingAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: undefined }),
    );
  });
});

describe("ClaudeCliRuntime delegation (#238)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("agent() delegates to the wrapped ClaudeCLIProvider with the same args", async () => {
    const reply = { text: "planned" };
    const spy = vi.spyOn(ClaudeCLIProvider.prototype, "agent").mockResolvedValue(reply);
    const rt = new ClaudeCliRuntime("sonnet", 5);
    const opts = { cwd: "/repo", maxTurns: 12 };
    const out = await rt.agent("do it", opts);
    expect(spy).toHaveBeenCalledWith("do it", opts);
    expect(out).toBe(reply);
  });

  it("structured() delegates to the provider's askStructured with the same args", async () => {
    const schema = { type: "object" };
    const spy = vi
      .spyOn(ClaudeCLIProvider.prototype, "askStructured")
      .mockResolvedValue({ ok: true } as never);
    const rt = new ClaudeCliRuntime("sonnet", 5);
    const opts = { tools: "Read,Grep,Glob", cwd: "/repo", maxTurns: 8 };
    const out = await rt.structured("critique the diff", schema, opts);
    expect(spy).toHaveBeenCalledWith("critique the diff", schema, opts);
    expect(out).toEqual({ ok: true });
  });

  it("runCoding() delegates to runCodingAgent, forwarding the options", async () => {
    const result = { ok: true, summary: "done", sessionId: "sess-1" };
    vi.mocked(runCodingAgent).mockResolvedValue(result as never);
    const rt = new ClaudeCliRuntime("sonnet", 5);
    const opts = { prompt: "code it", cwd: "/wt", model: "haiku", onEvent: () => {} };
    const out = await rt.runCoding(opts as never);
    expect(runCodingAgent).toHaveBeenCalledWith(opts);
    expect(out).toBe(result);
  });
});

describe("sessionRuntimeOf (#238)", () => {
  it("defaults to claude-cli for undefined, null, or a stampless record", () => {
    expect(sessionRuntimeOf(undefined)).toBe("claude-cli");
    expect(sessionRuntimeOf(null)).toBe("claude-cli");
    expect(sessionRuntimeOf({})).toBe("claude-cli");
  });

  it("returns an explicit sessionRuntime as-is", () => {
    expect(sessionRuntimeOf({ sessionRuntime: "claude-cli" })).toBe("claude-cli");
    expect(sessionRuntimeOf({ sessionRuntime: "codex-cli" })).toBe("codex-cli");
    expect(sessionRuntimeOf({ sessionRuntime: "copilot-cli" })).toBe("copilot-cli");
    expect(sessionRuntimeOf({ sessionRuntime: "gemini-cli" })).toBe("gemini-cli");
  });
});
