import { describe, it, expect, vi } from "vitest";
import type { CriticObjection, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { AgentRuntime } from "../src/runtime";
import type { PlanIssueInput } from "../src/planner";
import {
  buildCriticPrompt,
  critiquePlan,
  runCritic,
  CriticError,
  PLAN_CRITIC_MAX_TURNS,
  type CriticPriorRound,
} from "../src/confidence";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: ["enhancement"],
  body: "The poller should retry on 429 with backoff.",
};

const PLAN: IssuePlan = {
  summary: "Add retry with backoff",
  files: [{ path: "src/poller.ts", reason: "poll loop" }],
  steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow"] }],
  acceptance: [],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

function fakeLLM(structuredReply: unknown): {
  llm: LLMProviderInterface;
  askStructured: ReturnType<typeof vi.fn>;
} {
  const askStructured = vi.fn(async (): Promise<unknown> => structuredReply);
  const llm = {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured,
  } as unknown as LLMProviderInterface;
  return { llm, askStructured };
}

const objection = (blocking: boolean) => ({
  kind: "risk" as const,
  detail: "could break backoff",
  blocking,
});

describe("runCritic / critiquePlan", () => {
  it("derives 1.0 from approve with no objections", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [] });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBe(1);
    expect(s.verdict).toBe("approve");
  });

  it("derives 0.6 from concerns and keeps objections", async () => {
    const { llm } = fakeLLM({ verdict: "concerns", objections: [objection(false)] });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBeCloseTo(0.6);
    expect(s.objections).toHaveLength(1);
  });

  it("penalizes blocking objections and floors at 0", async () => {
    const { llm } = fakeLLM({
      verdict: "reject",
      objections: [objection(true), objection(true), objection(true)],
    });
    const s = await critiquePlan(PLAN, ISSUE, llm);
    expect(s.score).toBe(0);
    expect(s.verdict).toBe("reject");
  });

  it("throws CriticError on a malformed verdict", async () => {
    const { llm } = fakeLLM({ verdict: "meh", objections: "none" });
    await expect(critiquePlan(PLAN, ISSUE, llm)).rejects.toThrow(CriticError);
  });

  it("sends the artifact, context and adversarial framing to askStructured", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    await critiquePlan(PLAN, ISSUE, llm);
    const [prompt, schema] = askStructured.mock.calls[0] as [string, Record<string, unknown>];
    expect(prompt).toContain("DEMOLISH");
    expect(prompt).toContain("src/poller.ts");
    expect(prompt).toContain("retry on 429");
    expect(prompt).toContain("issue #42");
    expect(schema).toHaveProperty("properties");
  });

  it("mounts on a diff without plan knowledge (the #10 contract)", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    await runCritic(
      {
        artifactKind: "diff",
        artifactLabel: "diff for PR #7",
        artifact: "--- a/x.ts\n+++ b/x.ts",
        context: "Issue #7: fix x",
      },
      llm,
    );
    const [prompt] = askStructured.mock.calls[0] as [string];
    expect(prompt).toContain("diff");
    expect(prompt).toContain("--- a/x.ts");
    expect(prompt).toContain("Issue #7: fix x");
  });

  // Runtime-first: the plan critic runs on the role's own CLI when it has one,
  // so a non-Claude default agent never spawns the claude binary for it.
  it("runs the plan critic on the runtime with no tools when one is present", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [] });
    const structured = vi.fn(async (): Promise<unknown> => ({ verdict: "approve", objections: [] }));
    const runtime = { id: "codex-cli", structured } as unknown as AgentRuntime;
    const s = await critiquePlan(PLAN, ISSUE, llm, { runtime });
    expect(s.verdict).toBe("approve");
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { tools: string; cwd?: string; sessionId?: string; maxTurns?: number },
    ];
    expect(prompt).toContain("DEMOLISH");
    expect(opts.tools).toBe("");
    expect(opts.cwd).toBeUndefined();
    expect(opts.sessionId).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();
  });

  it("keeps the tools-mode options on the repo-inspecting critic", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [] });
    const structured = vi.fn(async (): Promise<unknown> => ({ verdict: "approve", objections: [] }));
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await runCritic(
      {
        artifactKind: "diff",
        artifactLabel: "diff for PR #7",
        artifact: "--- a/x.ts",
        context: "Issue #7",
      },
      llm,
      { runtime, tools: "Read,Grep,Glob", cwd: "/wt", sessionId: "sess-1", maxTurns: PLAN_CRITIC_MAX_TURNS },
    );
    const [, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      { tools: string; cwd?: string; sessionId?: string; maxTurns?: number },
    ];
    expect(opts).toMatchObject({
      tools: "Read,Grep,Glob",
      cwd: "/wt",
      sessionId: "sess-1",
      maxTurns: PLAN_CRITIC_MAX_TURNS,
    });
  });

  it("includes the plan kind label in the prompt", () => {
    const prompt = buildCriticPrompt({
      artifactKind: "plan",
      artifactLabel: "plan for issue #1",
      artifact: "{}",
      context: "ctx",
    });
    expect(prompt).toContain("plan");
    expect(prompt).toContain("--- Plan ---");
  });
});

// #226: ground objections in what is shown, raise a blocking flag only for a
// concrete failure, and re-verify priors against the current context.
describe("critic grounding & blocking bar (#226)", () => {
  const base = {
    artifactKind: "diff" as const,
    artifactLabel: "diff for PR #7",
    artifact: "--- a/x.ts\n+++ b/x.ts",
    context: "Issue #7: fix x",
  };

  it("instructs the critic to ground objections and gate blocking on a concrete failure", () => {
    const prompt = buildCriticPrompt(base);
    expect(prompt).toContain("Ground every objection in what is verifiable");
    expect(prompt).toContain("must be raised as a non-blocking question, never as blocking");
    expect(prompt).toContain("Mark blocking only when the objection names the concrete failure");
    expect(prompt).toContain('"Suspicious styling" or a convention hunch does not clear that bar');
  });

  it("adds the re-verify sentence on a continuity round", () => {
    const prompt = buildCriticPrompt({
      ...base,
      prior: { objections: [{ kind: "risk", detail: "P-one", blocking: true }], deliveredToCoder: true },
    });
    expect(prompt).toContain("Re-verify each persisting objection against the current artifact");
    expect(prompt).toContain("drop a prior the provided context refutes rather than escalating it");
  });

  it("adds the inspect-repo instruction only when canInspectRepo is set", () => {
    expect(buildCriticPrompt(base)).not.toContain(
      "You can read, search and list files across the working tree.",
    );
    expect(buildCriticPrompt({ ...base, canInspectRepo: true })).toContain(
      "You can read, search and list files across the working tree.",
    );
  });

  // The critic runs on the role's own runtime (#280), so its wording may name no
  // CLI's tools.
  it("names no claude tool", () => {
    expect(buildCriticPrompt({ ...base, canInspectRepo: true })).not.toMatch(
      /\bRead\b|\bGrep\b|\bGlob\b|\bBash\b/,
    );
  });
});

// #205: a continuity round classifies its objections against the prior round.
describe("runCritic continuity (#205)", () => {
  const priorObjections: CriticObjection[] = [
    { kind: "risk", detail: "P-one detail", blocking: true },
    { kind: "acceptance-gap", detail: "P-two detail", blocking: false },
    { kind: "other", detail: "P-three detail", blocking: false },
  ];

  const diffInput = (prior?: CriticPriorRound) => ({
    artifactKind: "diff" as const,
    artifactLabel: "diff for PR #7",
    artifact: "--- a/x.ts\n+++ b/x.ts",
    context: "Issue #7: fix x",
    ...(prior ? { prior } : {}),
  });

  it("hands the continuity schema to askStructured only when a prior is set", async () => {
    const { llm: base, askStructured: baseAsk } = fakeLLM({ verdict: "approve", objections: [] });
    await runCritic(diffInput(), base);
    const baseSchema = baseAsk.mock.calls[0][1] as { properties: Record<string, unknown> };
    expect(baseSchema.properties).not.toHaveProperty("resolved");

    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [], resolved: [] });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm);
    const schema = askStructured.mock.calls[0][1] as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("resolved");
  });

  it("renders the P-labelled priors plus the status/resolved instructions", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [], resolved: [] });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm);
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("--- Previous review round ---");
    expect(prompt).toContain("P1. [risk] (blocking) P-one detail");
    expect(prompt).toContain("P2. [acceptance-gap] P-two detail");
    expect(prompt).toContain('status: "persisting"');
    expect(prompt).toContain('In "resolved", list the labels');
  });

  it("switches the priors phrasing on deliveredToCoder", async () => {
    const { llm: handed, askStructured: handedAsk } = fakeLLM({
      verdict: "approve",
      objections: [],
      resolved: [],
    });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), handed);
    expect(handedAsk.mock.calls[0][0] as string).toContain("specifically instructed to address");

    const { llm: notHanded, askStructured: notHandedAsk } = fakeLLM({
      verdict: "approve",
      objections: [],
      resolved: [],
    });
    await runCritic(diffInput({ objections: priorObjections, deliveredToCoder: false }), notHanded);
    expect(notHandedAsk.mock.calls[0][0] as string).toContain("NOT explicitly handed to the coder");
  });

  it("maps resolved labels tolerantly: first digit, 1-based, bounded, deduped", async () => {
    const { llm } = fakeLLM({
      verdict: "concerns",
      objections: [],
      resolved: ["P1", "p2", "3.", "P99", "P1", "nonsense"],
    });
    const signal = await runCritic(
      diffInput({ objections: priorObjections, deliveredToCoder: true }),
      llm,
    );
    // P99 (out of bounds) and "nonsense" (no digit) dropped; duplicate P1 deduped.
    expect(signal.resolved).toEqual([priorObjections[0], priorObjections[1], priorObjections[2]]);
  });

  it("keeps the objection status through to the signal", async () => {
    const { llm } = fakeLLM({
      verdict: "reject",
      objections: [{ kind: "risk", detail: "still here", blocking: true, status: "persisting" }],
      resolved: [],
    });
    const signal = await runCritic(
      diffInput({ objections: priorObjections, deliveredToCoder: true }),
      llm,
    );
    expect(signal.objections[0]).toMatchObject({ status: "persisting" });
    expect(signal.resolved).toEqual([]);
  });

  it("throws CriticError on a malformed continuity reply", async () => {
    const { llm } = fakeLLM({ verdict: "approve", objections: [], resolved: "not-an-array" });
    await expect(
      runCritic(diffInput({ objections: priorObjections, deliveredToCoder: true }), llm),
    ).rejects.toThrow(CriticError);
  });

  // #308: a prior doubt must stay a doubt in the next round — otherwise the
  // continuity prompt re-presents it as an established fact.
  it("renders (unverified) on the prior P-lines and accepts the field on the reply", async () => {
    const { llm, askStructured } = fakeLLM({
      verdict: "concerns",
      objections: [
        { kind: "risk", detail: "still unsure", blocking: false, status: "persisting", unverified: true },
      ],
      resolved: [],
    });
    const signal = await runCritic(
      diffInput({
        objections: [
          { kind: "risk", detail: "P-one detail", blocking: true },
          { kind: "underspecified", detail: "P-two detail", blocking: false, unverified: true },
        ],
        deliveredToCoder: true,
      }),
      llm,
    );
    const prompt = askStructured.mock.calls[0][0] as string;
    expect(prompt).toContain("P1. [risk] (blocking) P-one detail");
    expect(prompt).toContain("P2. [underspecified] (unverified) P-two detail");
    // The continuity schema inherits `unverified` via .extend — it survives the parse.
    expect(signal.objections[0]).toMatchObject({ status: "persisting", unverified: true });
    expect(signal.score).toBeCloseTo(0.85);
  });

  it("renders both markers on a prior that is blocking and unverified", async () => {
    const { llm, askStructured } = fakeLLM({ verdict: "approve", objections: [], resolved: [] });
    await runCritic(
      diffInput({
        objections: [{ kind: "risk", detail: "P-one detail", blocking: true, unverified: true }],
        deliveredToCoder: false,
      }),
      llm,
    );
    expect(askStructured.mock.calls[0][0] as string).toContain(
      "P1. [risk] (blocking) (unverified) P-one detail",
    );
  });
});

// #308: an objection the critic admits it could not check is an open question,
// not a demonstrated defect. Same objection count, different score.
describe("critic score: unverified objections (#308)", () => {
  const obj = (over: Partial<CriticObjection> = {}): CriticObjection => ({
    kind: "risk",
    detail: "pnpm typecheck may not exist in the root package.json",
    blocking: false,
    ...over,
  });

  const scoreFor = async (verdict: string, objections: CriticObjection[]): Promise<number> => {
    const { llm } = fakeLLM({ verdict, objections });
    return (await critiquePlan(PLAN, ISSUE, llm)).score;
  };

  it("rebates concerns to 0.85 when every objection is unverified", async () => {
    await expect(
      scoreFor("concerns", [obj({ unverified: true }), obj({ unverified: true })]),
    ).resolves.toBeCloseTo(0.85);
  });

  // The assertion the issue asks for: identical count, different provenance.
  it("stays at 0.6 for the same objection count when one is demonstrated", async () => {
    await expect(
      scoreFor("concerns", [obj({ unverified: true }), obj({ unverified: false })]),
    ).resolves.toBeCloseTo(0.6);
  });

  it("treats an absent unverified field as demonstrated (already-persisted reports)", async () => {
    await expect(scoreFor("concerns", [obj(), obj()])).resolves.toBeCloseTo(0.6);
    await expect(scoreFor("concerns", [obj({ unverified: true }), obj()])).resolves.toBeCloseTo(0.6);
  });

  it("keeps the full blocking penalty on an unverified blocking objection", async () => {
    await expect(
      scoreFor("concerns", [obj({ blocking: true, unverified: true })]),
    ).resolves.toBeCloseTo(0.5);
    await expect(
      scoreFor("concerns", [obj({ blocking: true, unverified: true }), obj({ unverified: true })]),
    ).resolves.toBeCloseTo(0.5);
  });

  it("leaves approve and reject untouched however the objections are flagged", async () => {
    await expect(scoreFor("approve", [])).resolves.toBe(1);
    await expect(scoreFor("approve", [obj({ unverified: true })])).resolves.toBeCloseTo(1);
    await expect(scoreFor("reject", [obj({ unverified: true })])).resolves.toBeCloseTo(0.2);
  });

  it("does not rebate concerns with zero objections", async () => {
    await expect(scoreFor("concerns", [])).resolves.toBeCloseTo(0.6);
  });

  it("carries the flag through to the signal", async () => {
    const { llm } = fakeLLM({
      verdict: "concerns",
      objections: [obj({ unverified: true }), obj({ unverified: false })],
    });
    const signal = await critiquePlan(PLAN, ISSUE, llm);
    expect(signal.objections.map((o) => o.unverified)).toEqual([true, false]);
  });

  it("asks the critic to declare the provenance of every objection", () => {
    const prompt = buildCriticPrompt({
      artifactKind: "plan",
      artifactLabel: "plan for issue #1",
      artifact: "{}",
      context: "ctx",
    });
    expect(prompt).toContain("Declare the provenance of every objection");
    expect(prompt).toContain('Set "unverified": true when it rests on a repo fact you did not');
    expect(prompt).toContain("An unverified objection is an open question, so it is never blocking");
  });
});

// #308: with a runtime to host the call and a repo to read, the plan critic
// verifies its own repo-fact doubts instead of raising them.
describe("repo-inspecting plan critic (#308)", () => {
  const okReply = { verdict: "approve", objections: [] };
  const fakeRuntime = () => {
    const structured = vi.fn(async (): Promise<unknown> => okReply);
    return { structured, runtime: { id: "claude-cli", structured } as unknown as AgentRuntime };
  };
  type StructuredOpts = { tools: string; cwd?: string; sessionId?: string; maxTurns?: number };

  it("passes the read-only tool set, the repo cwd and a bounded turn budget", async () => {
    const { llm, askStructured } = fakeLLM(okReply);
    const { structured, runtime } = fakeRuntime();
    await critiquePlan(PLAN, ISSUE, llm, { runtime, repoPath: "/wt/issue-42" });
    expect(askStructured).not.toHaveBeenCalled();
    const [prompt, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      StructuredOpts,
    ];
    expect(opts).toMatchObject({
      tools: "Read,Grep,Glob",
      cwd: "/wt/issue-42",
      maxTurns: PLAN_CRITIC_MAX_TURNS,
    });
    // Ephemeral by design: the plan critic never resumes the planner's session.
    expect(opts.sessionId).toBeUndefined();
    expect(prompt).toContain("You can read, search and list files across the working tree.");
    expect(prompt).toContain("Spend the tool budget only on facts that would change an objection");
  });

  it("stays tool-less when the runtime is there but no repoPath is", async () => {
    const { llm } = fakeLLM(okReply);
    const { structured, runtime } = fakeRuntime();
    await critiquePlan(PLAN, ISSUE, llm, { runtime });
    const [prompt, , opts] = structured.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      StructuredOpts,
    ];
    expect(opts.tools).toBe("");
    expect(opts.cwd).toBeUndefined();
    expect(prompt).not.toContain("You can read, search and list files across the working tree.");
  });

  it("falls back to the completions provider when there is a repoPath but no runtime", async () => {
    const { llm, askStructured } = fakeLLM(okReply);
    await critiquePlan(PLAN, ISSUE, llm, { repoPath: "/wt/issue-42" });
    expect(askStructured).toHaveBeenCalledTimes(1);
    expect(askStructured.mock.calls[0][0] as string).not.toContain(
      "You can read, search and list files across the working tree.",
    );
  });
});

// #314: the cold-start plan critic can exhaust its turn budget. Losing the whole
// 0.30-weight signal renormalizes the composite over three signals — strictly
// worse than the pre-#312 verdict whose repo-fact doubts stay unverified.
describe("tool-less degradation on a salvageable death (#314)", () => {
  const okReply = { verdict: "concerns", objections: [{ kind: "risk", detail: "d", blocking: false }] };
  type StructuredOpts = { tools: string; cwd?: string; sessionId?: string; maxTurns?: number };

  function maxTurnsDeath(): Error {
    const err = new Error("agent hit the max-turns limit after 21 turns");
    (err as Error & { subtype: string }).subtype = "error_max_turns";
    return err;
  }

  it("retries tool-less and returns a valid signal", async () => {
    const { llm } = fakeLLM(okReply);
    const structured = vi
      .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(maxTurnsDeath())
      .mockResolvedValueOnce(okReply);
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    const degraded: string[] = [];

    const s = await critiquePlan(PLAN, ISSUE, llm, {
      runtime,
      repoPath: "/wt/issue-42",
      onDegraded: (r) => degraded.push(r),
    });

    expect(s.verdict).toBe("concerns");
    expect(s.score).toBeCloseTo(0.6);
    expect(structured).toHaveBeenCalledTimes(2);

    // The retry drops the tools, the cwd and the budget — and the prompt stops
    // telling the critic to verify against a tree it can no longer read.
    const [firstPrompt, , firstOpts] = structured.mock.calls[0] as unknown as [string, unknown, StructuredOpts];
    const [retryPrompt, , retryOpts] = structured.mock.calls[1] as unknown as [string, unknown, StructuredOpts];
    expect(firstOpts).toMatchObject({ tools: "Read,Grep,Glob", maxTurns: PLAN_CRITIC_MAX_TURNS });
    expect(firstPrompt).toContain("You can read, search and list files across the working tree.");
    expect(retryOpts.tools).toBe("");
    expect(retryOpts.cwd).toBeUndefined();
    expect(retryOpts.maxTurns).toBeUndefined();
    expect(retryPrompt).not.toContain("You can read, search and list files across the working tree.");

    // Quiet, but not invisible.
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain("degraded to tool-less");
    expect(degraded[0]).toContain("max-turns");
  });

  it("degrades on the other salvageable deaths too", async () => {
    for (const subtype of ["error_hard_timeout", "error_inactivity"]) {
      const { llm } = fakeLLM(okReply);
      const err = new Error(`killed: ${subtype}`);
      (err as Error & { subtype: string }).subtype = subtype;
      const structured = vi
        .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(okReply);
      const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
      const s = await critiquePlan(PLAN, ISSUE, llm, { runtime, repoPath: "/wt/issue-42" });
      expect(s.verdict).toBe("concerns");
      expect(structured).toHaveBeenCalledTimes(2);
    }
  });

  // The fallback is opt-in per call site, never a property of runCritic. A diff
  // critic death already parks the item at human-review with a visible error
  // (apps/desktop/src/reviewer.ts) — a human reads the code either way, so
  // degrading there would trade review rigor for automation.
  it("still throws for a diff-critic-shaped call that did not opt in", async () => {
    const { llm } = fakeLLM(okReply);
    const structured = vi
      .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
      .mockRejectedValue(maxTurnsDeath());
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await expect(
      runCritic(
        {
          artifactKind: "diff",
          artifactLabel: "working-tree diff for issue #7",
          artifact: "--- a/x.ts",
          context: "Issue #7",
          canInspectRepo: true,
        },
        llm,
        { runtime, cwd: "/wt", sessionId: "sess-1", tools: "Read,Grep,Glob", maxTurns: 8 },
      ),
    ).rejects.toThrow("max-turns");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-salvageable error untouched", async () => {
    const { llm } = fakeLLM(okReply);
    const structured = vi
      .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
      .mockRejectedValue(new Error("claude: command not found"));
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await expect(
      critiquePlan(PLAN, ISSUE, llm, { runtime, repoPath: "/wt/issue-42" }),
    ).rejects.toThrow("claude: command not found");
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it("still throws CriticError when the tool-less retry returns an invalid verdict", async () => {
    const { llm } = fakeLLM(okReply);
    const structured = vi
      .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(maxTurnsDeath())
      .mockResolvedValueOnce({ verdict: "maybe" });
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await expect(
      critiquePlan(PLAN, ISSUE, llm, { runtime, repoPath: "/wt/issue-42" }),
    ).rejects.toBeInstanceOf(CriticError);
  });

  // An abort must never be swallowed into a fallback (#159).
  it("rejects instead of degrading when the caller aborted", async () => {
    const { llm } = fakeLLM(okReply);
    const controller = new AbortController();
    const structured = vi
      .fn<(p: string, s: unknown, o: unknown) => Promise<unknown>>()
      .mockImplementationOnce(async () => {
        controller.abort();
        throw maxTurnsDeath();
      });
    const runtime = { id: "claude-cli", structured } as unknown as AgentRuntime;
    await expect(
      critiquePlan(PLAN, ISSUE, llm, {
        runtime,
        repoPath: "/wt/issue-42",
        signal: controller.signal,
      }),
    ).rejects.toThrow("max-turns");
    expect(structured).toHaveBeenCalledTimes(1);
  });
});
