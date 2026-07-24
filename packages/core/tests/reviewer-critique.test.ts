import { describe, it, expect, vi } from "vitest";
import type { LLMProviderInterface } from "../src/llm";
import type { AgentRuntime } from "../src/runtime";
import { critiqueDiff, truncateDiff, DIFF_CHAR_BUDGET } from "../src/reviewer";

const issue = {
  key: "42",
  title: "Add dark mode",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "Please add dark mode.",
};

const approveReply = { verdict: "approve", objections: [] };

function fakeLLM(reply: unknown = approveReply) {
  const askStructured = vi.fn(async () => reply);
  const llm: LLMProviderInterface = {
    name: "fake",
    ask: vi.fn(),
    askStructured,
  } as unknown as LLMProviderInterface;
  return { llm, askStructured };
}

/** The tools-enabled (repo-inspecting) critic runs through runtime.structured (#238). */
function fakeRuntime(reply: unknown = approveReply) {
  const structured = vi.fn(async () => reply);
  const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
  return { runtime, structured };
}

describe("truncateDiff", () => {
  it("leaves an under-budget diff untouched", () => {
    const result = truncateDiff("small diff");
    expect(result).toEqual({ text: "small diff", truncated: false });
  });

  it("cuts at the budget with a marker", () => {
    const big = "x".repeat(DIFF_CHAR_BUDGET + 500);
    const result = truncateDiff(big);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(
      `[diff truncated — showing first ${DIFF_CHAR_BUDGET} of ${big.length} characters]`,
    );
    expect(result.text.length).toBeLessThan(big.length);
  });
});

describe("critiqueDiff", () => {
  it("mounts on the critic with artifactKind diff and the acceptance block", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff(
      {
        diff: "diff --git a/x b/x\n+1",
        issue,
        acceptance: [
          { criterion: "toggle persists", addressedBy: "localStorage" },
          { criterion: "no FOUC", addressedBy: "inline script" },
        ],
      },
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("DEMOLISH the diff");
    expect(prompt).toContain("working-tree diff for issue #42: Add dark mode");
    expect(prompt).toContain("Acceptance criteria:\n- toggle persists\n- no FOUC");
    expect(prompt).toContain("diff --git a/x b/x");
  });

  it("falls back to an explicit no-criteria line", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm);
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "(No explicit acceptance criteria — review strictly against the issue body.)",
    );
  });

  it("passes the verdict through with the derived score", async () => {
    const { llm } = fakeLLM({
      verdict: "reject",
      objections: [{ kind: "acceptance-gap", detail: "toggle does not persist", blocking: true }],
    });
    const signal = await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm);
    expect(signal.verdict).toBe("reject");
    expect(signal.score).toBeCloseTo(0.1);
    expect(signal.objections[0].blocking).toBe(true);
  });

  it("truncates a huge diff in the prompt", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "y".repeat(DIFF_CHAR_BUDGET + 10), issue, acceptance: [] }, llm);
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("[diff truncated");
  });

  // #111 + #226: the reviewer persists a per-round session; the bundled cwd+id must
  // reach askStructured, and a session also unlocks the read-only inspection toolset.
  it("forwards the session as runtime.structured opts (cwd, sessionId, inspection tools)", async () => {
    const { llm } = fakeLLM();
    const { runtime, structured } = fakeRuntime();
    await critiqueDiff(
      { diff: "+1", issue, acceptance: [], session: { id: "sid-1", cwd: "/wt/issue-1" } },
      llm,
      runtime,
    );
    expect(structured.mock.calls[0][2]).toEqual({
      cwd: "/wt/issue-1",
      sessionId: "sid-1",
      tools: "Read,Grep,Glob",
      maxTurns: 8,
    });
  });

  // #226: with a session the reviewer can inspect the tree — the prompt tells it to.
  it("adds the inspect-repo instruction when a session is present", async () => {
    const { llm } = fakeLLM();
    const { runtime, structured } = fakeRuntime();
    await critiqueDiff(
      { diff: "+1", issue, acceptance: [], session: { id: "sid-1", cwd: "/wt/issue-1" } },
      llm,
      runtime,
    );
    const prompt = structured.mock.calls[0][0] as string;
    expect(prompt).toContain("You have Read, Grep and Glob over the working tree.");
  });

  it("passes no opts and no inspect-repo instruction when session is absent", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm);
    expect(askStructured.mock.calls[0][2]).toBeUndefined();
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).not.toContain("You have Read, Grep and Glob over the working tree.");
  });

  // #226: the planner's verified facts ground the reviewer against its own guesses.
  it("renders the planner's verified-facts block when planContext is set", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff(
      {
        diff: "+1",
        issue,
        acceptance: [],
        planContext: ["src/theme.ts:3 uses a ThemeContext", "no shadcn tokens in this repo"],
      },
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "Verified repo facts from the planner (trust these over your own assumptions):",
    );
    expect(prompt).toContain("- src/theme.ts:3 uses a ThemeContext");
    expect(prompt).toContain("- no shadcn tokens in this repo");
  });

  it("omits the verified-facts block when planContext is absent or empty", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [], planContext: [] }, llm);
    expect(askStructured.mock.calls[0][0] as string).not.toContain(
      "Verified repo facts from the planner",
    );

    const { llm: llm2, askStructured: ask2 } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm2);
    expect(ask2.mock.calls[0][0] as string).not.toContain("Verified repo facts from the planner");
  });

  // #146: the coder report threads deviations + verification into the critic
  // context, but never gates the verdict.
  it("renders declared deviations and verification lines from the report", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff(
      {
        diff: "+1",
        issue,
        acceptance: [],
        report: {
          done: [{ path: "src/a.ts", summary: "did it" }],
          deviations: ["skipped the cache layer"],
          verification: [
            { command: "pnpm test", passed: true },
            { command: "pnpm lint", passed: false, detail: "2 errors" },
          ],
          open: [],
        },
      },
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("Coder-declared deviations from the plan:");
    expect(prompt).toContain("- skipped the cache layer");
    expect(prompt).toContain("Verification commands the coder ran:");
    expect(prompt).toContain("- [PASS] pnpm test");
    expect(prompt).toContain("- [FAIL] pnpm lint — 2 errors");
  });

  it("flags empty deviations as undeclared-drift context", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff(
      {
        diff: "+1",
        issue,
        acceptance: [],
        report: { done: [], deviations: [], verification: [], open: [] },
      },
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("declared NO deviations from the plan");
    expect(prompt).not.toContain("Verification commands the coder ran:");
  });

  it("includes none of the report blocks when no report is passed", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm);
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).not.toContain("deviations from the plan");
    expect(prompt).not.toContain("Verification commands the coder ran:");
  });

  // #205: the prior round threads into runCritic, switching on the continuity path.
  it("threads a prior round into the critic prompt and returns mapped resolutions", async () => {
    const { llm, askStructured } = fakeLLM({
      verdict: "approve",
      objections: [],
      resolved: ["P1"],
    });
    const signal = await critiqueDiff(
      {
        diff: "+1",
        issue,
        acceptance: [],
        prior: {
          objections: [{ kind: "risk", detail: "the prior blocker", blocking: true }],
          deliveredToCoder: true,
        },
      },
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("--- Previous review round ---");
    expect(prompt).toContain("P1. [risk] (blocking) the prior blocker");
    expect(signal.resolved).toEqual([{ kind: "risk", detail: "the prior blocker", blocking: true }]);
  });
});
