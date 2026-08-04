import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfidenceReport, IssuePlan } from "@skipper/shared";
import type { LLMProviderInterface, LLMResponse } from "../src/llm/provider";
import type { GraphifyContext } from "../src/llm/graphify-mcp";
import type { PlanIssueInput } from "../src/planner";
import { computeConfidence, reachableBand, DEFAULT_CONFIDENCE_WEIGHTS } from "../src/confidence";

const ISSUE: PlanIssueInput = {
  key: "42",
  title: "Add retry to the poller",
  url: "https://github.com/o/r/issues/42",
  labels: [],
  body: "The poller should retry on 429 with backoff.\n\nAcceptance criteria:\n- [ ] retries",
};

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "nb-score-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "poller.ts"), "export function pollNow() {}\n", "utf-8");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function plan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "s",
    files: [{ path: "src/poller.ts", reason: "r" }],
    steps: [{ title: "t", detail: "d", files: ["src/poller.ts"], symbols: ["pollNow"] }],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
    ...overrides,
  };
}

const APPROVE = { verdict: "approve", objections: [] };
/** Clarity judgment (#309) deriving score 1.0 — the neutral answer for the
 *  gate-behaviour tests below, which are not about clarity. */
const CLEAR = { criteria: "verifiable", ambiguities: [], openQuestions: [], rationale: "clear" };
/** Judgment deriving 0.05: vague, with three decisions the plan made silently. */
const VAGUE = {
  criteria: "vague",
  ambiguities: ["levels", "default", "control"].map((detail) => ({
    detail,
    resolvableFromRepo: false,
    flaggedByPlan: false,
  })),
  openQuestions: [],
  rationale: "nothing here is checkable",
};

/** The critic and the clarity judge share one structured seam, so the fake
 *  dispatches on the schema each of them asks for (#309). */
function isClaritySchema(schema: unknown): boolean {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props !== undefined && "criteria" in props;
}

function fakeLLM(structuredReply: unknown, clarityReply: unknown = CLEAR): LLMProviderInterface {
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured: vi.fn(async (_prompt: string, schema: Record<string, unknown>) =>
      isClaritySchema(schema) ? clarityReply : structuredReply,
    ),
  } as unknown as LLMProviderInterface;
}

/** Provider that fails a single signal's structured call and answers the other. */
function failingLLM(which: "critic" | "clarity", detail: string): LLMProviderInterface {
  return {
    name: "claude-cli",
    ask: async (): Promise<LLMResponse> => ({ text: "" }),
    askStructured: vi.fn(async (_prompt: string, schema: Record<string, unknown>) => {
      const clarity = isClaritySchema(schema);
      if (clarity === (which === "clarity")) throw new Error(detail);
      return clarity ? CLEAR : APPROVE;
    }),
  } as unknown as LLMProviderInterface;
}

// #309 recalibration: groundedness drops to a low-weight guard backed by a veto,
// clarity rises to carry the semantic judgment it now makes.
describe("DEFAULT_CONFIDENCE_WEIGHTS", () => {
  it("splits 0.15/0.30/0.25/0.30 and sums to 1", () => {
    expect(DEFAULT_CONFIDENCE_WEIGHTS).toEqual({
      groundedness: 0.15,
      critic: 0.3,
      convergence: 0.25,
      clarity: 0.3,
    });
    const { groundedness, critic, convergence, clarity } = DEFAULT_CONFIDENCE_WEIGHTS;
    expect(groundedness + critic + convergence + clarity).toBeCloseTo(1);
  });
});

describe("computeConfidence", () => {
  it("runs all signals and weights them", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.signals.groundedness?.score).toBeCloseTo(1);
    expect(report.signals.convergence?.score).toBeCloseTo(1);
    expect(report.signals.critic?.score).toBe(1);
    expect(report.signals.clarity).toBeDefined();
    expect(report.errors).toEqual([]);
    const w = report.weights;
    expect(w.groundedness + w.convergence + w.critic + w.clarity).toBeCloseTo(1);
    expect(report.composite).toBeGreaterThan(0.9);
  });

  it("omits convergence and renormalizes when all extra runs fail", async () => {
    const generatePlan = vi.fn(async () => {
      throw new Error("cli exploded");
    });
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.signals.convergence).toBeUndefined();
    expect(report.errors).toEqual(["convergence: 2/2 extra plan runs failed"]);
    expect(report.weights.convergence).toBe(0);
    const w = report.weights;
    expect(w.groundedness + w.critic + w.clarity).toBeCloseTo(1);
    expect(w.groundedness).toBeGreaterThan(DEFAULT_CONFIDENCE_WEIGHTS.groundedness);
  });

  it("captures a critic failure in errors and scores the rest", async () => {
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: failingLLM("critic", "no cli"),
      extraPlanRuns: 0,
    });
    expect(report.signals.critic).toBeUndefined();
    expect(report.errors).toEqual(["critic: no cli"]);
    expect(report.signals.groundedness).toBeDefined();
    expect(report.signals.clarity).toBeDefined();
    expect(report.composite).toBeGreaterThan(0);
  });

  it("captures a clarity failure in errors and renormalizes over the rest (#309)", async () => {
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: failingLLM("clarity", "no cli"),
      extraPlanRuns: 0,
    });
    expect(report.signals.clarity).toBeUndefined();
    expect(report.errors).toEqual(["clarity: no cli"]);
    expect(report.signals.critic).toBeDefined();
    expect(report.weights.clarity).toBe(0);
    expect(report.weights.groundedness + report.weights.critic).toBeCloseTo(1);
  });

  it("skips convergence entirely when extraPlanRuns is 0", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 0,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.signals.convergence).toBeUndefined();
    expect(report.convergenceSkipped?.reason).toBe("disabled");
    expect(report.errors).toEqual([]);
  });

  it("counts partial extra-run failures but still scores convergence", async () => {
    let calls = 0;
    const generatePlan = vi.fn(async () => {
      if (calls++ === 0) throw new Error("flaky");
      return plan();
    });
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.signals.convergence?.planCount).toBe(2);
    expect(report.errors).toEqual(["convergence: 1/2 extra plan runs failed"]);
  });
});

describe("reachableBand", () => {
  it("bounds the composite over every convergence value in [0,1]", () => {
    const band = reachableBand({
      groundedness: { score: 1 },
      critic: { score: 1 },
      clarity: { score: 1 },
    } as ConfidenceReport["signals"]);
    expect(band.min).toBeCloseTo(0.75); // convergence = 0
    expect(band.max).toBeCloseTo(1); // convergence = 1
  });

  it("spans the full range when no other signal scored", () => {
    const band = reachableBand({});
    expect(band.min).toBe(0);
    expect(band.max).toBe(1);
  });

  it("contains the absent-convergence composite, so a decisive band is honest", () => {
    const signals = {
      groundedness: { score: 0.8 },
      critic: { score: 0.6 },
      clarity: { score: 0.4 },
    } as ConfidenceReport["signals"];
    const band = reachableBand(signals);
    const raw = 0.15 * 0.8 + 0.3 * 0.6 + 0.3 * 0.4;
    const renormalized = raw / (0.15 + 0.3 + 0.3);
    expect(renormalized).toBeGreaterThanOrEqual(band.min);
    expect(renormalized).toBeLessThanOrEqual(band.max);
  });
});

describe("computeConfidence — adaptive convergence (#50)", () => {
  it("skips the extra runs when no convergence value can move the gate", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Band for perfect signals is [0.75, 1]; both ends resolve to queued here.
      thresholds: { high: 0.6, low: 0.3 },
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.signals.convergence).toBeUndefined();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain("queued");
    expect(report.weights.convergence).toBe(0);
    const w = report.weights;
    expect(w.groundedness + w.critic + w.clarity).toBeCloseTo(1);
  });

  it("skips when the plan is decisively bad, without paying for more plans", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan({
        // Coverage 0.65: one of two files missing, the symbol found — bad enough
        // to pin the gate, not bad enough for the veto.
        files: [
          { path: "src/poller.ts", reason: "r" },
          { path: "src/ghost.ts", reason: "r" },
        ],
        openQuestions: ["a?", "b?", "c?"],
      }),
      issue: { ...ISSUE, body: undefined },
      repoPath: repo,
      llm: fakeLLM({ verdict: "reject", objections: [] }, VAGUE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.veto).toBeUndefined();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain("needs-input");
  });

  it("still pays for the runs under default thresholds, where the high band is reachable", async () => {
    // Groundedness+critic+clarity carry 0.75 total, so perfect cheap signals
    // bottom out at 0.75 — below the 0.85 gate. Convergence can still decide.
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.convergenceSkipped).toBeUndefined();
    expect(report.signals.convergence?.score).toBeCloseTo(1);
  });

  // #62: the skip is computed for the gate that will actually run. Under on/off the
  // queued/plan-gate choice is pinned, so a band that only clears the low floor is
  // already decisive — no reason to pay for two more agentic plan runs.
  it.each([
    ["on", "queued"],
    ["off", "plan-gate"],
  ] as const)("skips the extra runs when autoCoding is %s", async (autoCoding, target) => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Default thresholds: the [0.75, 1] band straddles high, so auto would pay.
      autoCoding,
      deps: { generatePlan },
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain(target);
  });

  it("still pays under on when the band straddles the low floor", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      // Band [0.75, 1] straddles low, so needs-input is still reachable — and the
      // floor outranks the mode.
      thresholds: { high: 0.99, low: 0.8 },
      autoCoding: "on",
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    expect(report.convergenceSkipped).toBeUndefined();
  });

  it("throws instead of returning a report when repoPath does not exist (#157)", async () => {
    const generatePlan = vi.fn(async () => plan());
    await expect(
      computeConfidence({
        plan: plan(),
        issue: ISSUE,
        repoPath: join(repo, "does-not-exist"),
        llm: fakeLLM(APPROVE),
        extraPlanRuns: 2,
        deps: { generatePlan },
      }),
    ).rejects.toThrow();
    expect(generatePlan).not.toHaveBeenCalled();
  });
});

// #309: a plan citing files and symbols that are not in the repo is not gradeable.
// The veto rides on the report and forces needs-input downstream, so the extra
// plan runs are pointless — but scoring must still return a report, not throw.
describe("computeConfidence — groundedness veto (#309)", () => {
  const ghostPlan = () =>
    plan({
      files: [{ path: "src/ghost.ts", reason: "r" }],
      steps: [{ title: "t", detail: "d", files: ["src/ghost.ts"], symbols: ["noSuchSymbol"] }],
    });

  it("sets the veto and skips the extra runs without throwing", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: ghostPlan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.veto).toEqual({
      signal: "groundedness",
      detail: "1 cited file and 1 symbol are absent from the repo",
    });
    expect(generatePlan).not.toHaveBeenCalled();
    expect(report.convergenceSkipped?.reason).toBe("decisive");
    expect(report.convergenceSkipped?.detail).toContain("groundedness veto");
    expect(report.signals.groundedness?.coverage).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("vetoes even when every other signal is perfect and autoCoding is on", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: ghostPlan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      autoCoding: "on",
      deps: { generatePlan },
    });
    expect(report.veto?.signal).toBe("groundedness");
    expect(generatePlan).not.toHaveBeenCalled();
  });

  it("leaves the veto unset above the coverage floor", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    expect(report.veto).toBeUndefined();
    expect(generatePlan).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit skipConvergence reason over the veto's", async () => {
    const generatePlan = vi.fn(async () => plan());
    const report = await computeConfidence({
      plan: ghostPlan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      skipConvergence: { reason: "rescore", detail: "plan revised via chat" },
      deps: { generatePlan },
    });
    expect(report.veto?.signal).toBe("groundedness");
    expect(report.convergenceSkipped?.reason).toBe("rescore");
  });
});

describe("computeConfidence — Graphify threading (#233)", () => {
  const GRAPHIFY: GraphifyContext = {
    mcp: {
      mcpBinPath: "/data/tools/bin/graphify-mcp",
      graphPath: "/data/graphs/o_r/graphify-out/graph.json",
    },
    indexedSha: "abc1234def",
  };

  it("threads the graphify context into every convergence extra run", async () => {
    const generatePlan = vi.fn(async () => plan());
    await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      graphify: GRAPHIFY,
      deps: { generatePlan },
    });
    expect(generatePlan).toHaveBeenCalledTimes(2);
    for (const call of generatePlan.mock.calls) {
      expect((call[0] as { graphify?: GraphifyContext }).graphify).toBe(GRAPHIFY);
    }
  });

  it("passes no graphify key to the extra runs when absent", async () => {
    const generatePlan = vi.fn(async () => plan());
    await computeConfidence({
      plan: plan(),
      issue: ISSUE,
      repoPath: repo,
      llm: fakeLLM(APPROVE),
      extraPlanRuns: 2,
      deps: { generatePlan },
    });
    for (const call of generatePlan.mock.calls) {
      expect("graphify" in (call[0] as object)).toBe(false);
    }
  });
});
