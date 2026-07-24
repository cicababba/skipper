import { describe, it, expect, vi } from "vitest";
import type { LLMProviderInterface } from "../src/llm";
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

  // #111: the reviewer persists a per-round session; the bundled cwd+id must
  // reach askStructured so the run lands on disk resumable from the worktree.
  it("forwards the session as askStructured opts (cwd + sessionId)", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff(
      { diff: "+1", issue, acceptance: [], session: { id: "sid-1", cwd: "/wt/issue-1" } },
      llm,
    );
    expect(askStructured.mock.calls[0][2]).toEqual({ cwd: "/wt/issue-1", sessionId: "sid-1" });
  });

  it("passes no opts when session is absent", async () => {
    const { llm, askStructured } = fakeLLM();
    await critiqueDiff({ diff: "+1", issue, acceptance: [] }, llm);
    expect(askStructured.mock.calls[0][2]).toBeUndefined();
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
