import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_SETTINGS,
  type OrchestratorManifest,
} from "@skipper/core";
import {
  latestPlanningTransitionAt,
  latestCodingTransitionAt,
  type AgentReview,
  type ConfidenceReport,
  type GateMode,
  type LifecycleState,
  type TrackedItem,
  type TransitionEvent,
} from "@skipper/shared";
import { makeManifestWriters, type ManifestWriterDeps } from "./manifest-writers";

function txn(from: LifecycleState | null, to: LifecycleState, at: string): TransitionEvent {
  return { at, from, to, actor: from === null ? "reconcile" : "planner", reason: undefined };
}

function mkItem(
  id: string,
  state: LifecycleState,
  transitions: TransitionEvent[],
  extra: Partial<TrackedItem> = {},
): TrackedItem {
  return {
    id,
    source: "github",
    sourceRef: { project: "owner/repo", key: id },
    codeHost: "github",
    accountId: "acct",
    repo: { owner: "owner", name: "repo" },
    key: id,
    number: Number(id),
    title: `issue ${id}`,
    url: `https://github.com/owner/repo/issues/${id}`,
    state,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    transitions,
    ...extra,
  };
}

/** A planning item whose latest planning-entry token is a known timestamp. */
function planningItem(id: string, extra: Partial<TrackedItem> = {}): TrackedItem {
  return mkItem(
    id,
    "planning",
    [txn(null, "triage", "2026-07-13T00:00:00.000Z"), txn("triage", "planning", "2026-07-13T01:00:00.000Z")],
    extra,
  );
}

/** A coding item whose latest coding-entry token is a known timestamp. */
function codingItem(id: string, extra: Partial<TrackedItem> = {}): TrackedItem {
  return mkItem(
    id,
    "coding",
    [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "queued", "2026-07-13T01:00:00.000Z"),
      txn("queued", "coding", "2026-07-13T02:00:00.000Z"),
    ],
    extra,
  );
}

function report(composite: number, divergent?: boolean): ConfidenceReport {
  return {
    version: 1,
    composite,
    weights: { convergence: 0, critic: 1, clarity: 0 },
    signals: divergent === undefined
      ? {}
      : {
          convergence: {
            score: 0.5,
            planCount: 2,
            fileJaccard: 0.5,
            sizeAgreement: 0.5,
            stepCountAgreement: 0.5,
            divergent,
            sharedFiles: [],
            disputedFiles: [],
          },
        },
    errors: [],
    computedAt: "2026-07-13T01:30:00.000Z",
  };
}

function vetoed(composite: number): ConfidenceReport {
  return {
    ...report(composite),
    veto: {
      signal: "groundedness",
      detail: "2 cited files and 1 symbol are absent from the repo",
    },
  };
}

interface Harness {
  manifest: OrchestratorManifest;
  deps: ManifestWriterDeps;
  writers: ReturnType<typeof makeManifestWriters>;
  saves: number;
  broadcasts: number;
  pokes: { planner: number; coder: number; reviewer: number; shepherd: number };
  archived: Array<{ itemId: string; plan: TrackedItem["plan"] }>;
  cancels: {
    planning: string[];
    coding: string[];
    planChat: string[];
    rescore: string[];
    agentChat: Array<{ kind: "coder" | "reviewer"; id: string }>;
  };
  parks: Array<{ itemId: string; worktree: { path: string; branch: string } }>;
}

function makeHarness(opts: { autoCoding?: GateMode; items?: TrackedItem[] } = {}): Harness {
  const manifest: OrchestratorManifest = {
    version: 3,
    settings: { ...DEFAULT_ORCHESTRATOR_SETTINGS },
    items: {},
    parked: {},
    repoSettings: {},
    projectMappings: {},
  };
  for (const it of opts.items ?? []) manifest.items[it.id] = it;

  const h: Harness = {
    manifest,
    saves: 0,
    broadcasts: 0,
    pokes: { planner: 0, coder: 0, reviewer: 0, shepherd: 0 },
    archived: [],
    cancels: { planning: [], coding: [], planChat: [], rescore: [], agentChat: [] },
    parks: [],
    deps: undefined as unknown as ManifestWriterDeps,
    writers: undefined as unknown as ReturnType<typeof makeManifestWriters>,
  };
  h.deps = {
    ensureManifest: async () => manifest,
    saveManifest: async () => {
      h.saves++;
    },
    broadcast: () => {
      h.broadcasts++;
    },
    pokePlanner: () => {
      h.pokes.planner++;
    },
    pokeCoder: () => {
      h.pokes.coder++;
    },
    pokeReviewer: () => {
      h.pokes.reviewer++;
    },
    pokeShepherd: () => {
      h.pokes.shepherd++;
    },
    getRepoAutoCoding: () => opts.autoCoding ?? "auto",
    archivePlan: async (itemId, plan) => {
      h.archived.push({ itemId, plan });
      return plan?.ref ? { ...plan, ref: `${plan.ref}.archived` } : plan;
    },
    cancelPlanningRun: (id) => {
      h.cancels.planning.push(id);
    },
    cancelCodingRun: (id) => {
      h.cancels.coding.push(id);
    },
    cancelPlanChat: (id) => {
      h.cancels.planChat.push(id);
    },
    cancelRescore: (id) => {
      h.cancels.rescore.push(id);
    },
    cancelAgentChat: (kind, id) => {
      h.cancels.agentChat.push({ kind, id });
    },
    discardParkedWorktree: (item, worktree) => {
      h.parks.push({ itemId: item.id, worktree });
    },
  };
  h.writers = makeManifestWriters(h.deps);
  return h;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("completePlan gate matrix", () => {
  it("high composite + autoCoding auto → queued", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "auto", items: [item] });
    await h.writers.completePlan("1", "plan-ref", report(0.9), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].state).toBe("queued");
    expect(h.manifest.items["1"].plan).toEqual({ ref: "plan-ref", confidence: 0.9 });
    expect(h.saves).toBe(1);
    expect(h.pokes.coder).toBe(1);
  });

  it("autoCoding off → plan-gate even at high composite", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "off", items: [item] });
    await h.writers.completePlan("1", "r", report(0.99), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].state).toBe("plan-gate");
  });

  it("below the low floor → needs-input, resumeTo planning, regardless of mode", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "on", items: [item] });
    await h.writers.completePlan("1", "r", report(0.1), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].state).toBe("needs-input");
    expect(h.manifest.items["1"].resumeTo).toBe("planning");
  });

  it("no confidence → plan-gate, conservative reason", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "on", items: [item] });
    await h.writers.completePlan("1", "r", undefined, latestPlanningTransitionAt(item));
    const next = h.manifest.items["1"];
    expect(next.state).toBe("plan-gate");
    expect(next.plan?.confidence).toBeUndefined();
    expect(next.transitions.at(-1)?.reason).toBe("plan generated (confidence unavailable)");
  });

  it("divergent plans append the ambiguity suffix to the reason", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "off", items: [item] });
    await h.writers.completePlan("1", "r", report(0.7, true), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].transitions.at(-1)?.reason).toBe(
      "confidence 0.70 — plans diverge, issue may be ambiguous",
    );
  });

  // #309: the veto is checked before resolveGate precisely so that autoCoding
  // "on" — which otherwise floors every scored plan at queued — cannot override it.
  it("veto → needs-input with resumeTo planning, even under autoCoding on", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "on", items: [item] });
    await h.writers.completePlan("1", "r", vetoed(0.95), latestPlanningTransitionAt(item));
    const next = h.manifest.items["1"];
    expect(next.state).toBe("needs-input");
    expect(next.resumeTo).toBe("planning");
    expect(next.transitions.at(-1)?.reason).toBe(
      "confidence 0.95 — groundedness veto: 2 cited files and 1 symbol are absent from the repo",
    );
    expect(next.plan).toEqual({ ref: "r", confidence: 0.95 });
  });

  it("veto → needs-input under autoCoding auto too", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "auto", items: [item] });
    await h.writers.completePlan("1", "r", vetoed(0.95), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].state).toBe("needs-input");
  });

  it("strips a stale rescoring flag from the plan", async () => {
    const item = planningItem("1", { plan: { rescoring: true } });
    const h = makeHarness({ autoCoding: "off", items: [item] });
    await h.writers.completePlan("1", "r", report(0.7), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].plan).toEqual({ ref: "r", confidence: 0.7 });
    expect("rescoring" in (h.manifest.items["1"].plan ?? {})).toBe(false);
  });
});

describe("completePlan stale-run guard", () => {
  it("refuses when the item already left planning (stale by state)", async () => {
    const item = mkItem("1", "plan-gate", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "planning", "2026-07-13T01:00:00.000Z"),
      txn("planning", "plan-gate", "2026-07-13T02:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    await h.writers.completePlan("1", "r", report(0.9), "2026-07-13T01:00:00.000Z");
    expect(console.warn).toHaveBeenCalledWith("stale plan completion refused for 1");
    expect(h.manifest.items["1"].state).toBe("plan-gate");
    expect(h.saves).toBe(0);
    expect(h.broadcasts).toBe(0);
    expect(h.pokes.coder).toBe(0);
  });

  it("refuses when a newer planning transition superseded the token (stale by token)", async () => {
    const item = planningItem("1");
    const h = makeHarness({ items: [item] });
    await h.writers.completePlan("1", "r", report(0.9), "2026-07-13T00:59:00.000Z");
    expect(console.warn).toHaveBeenCalled();
    expect(h.manifest.items["1"].state).toBe("planning");
    expect(h.saves).toBe(0);
  });

  it("accepts a matching token", async () => {
    const item = planningItem("1");
    const h = makeHarness({ autoCoding: "off", items: [item] });
    await h.writers.completePlan("1", "r", report(0.9), latestPlanningTransitionAt(item));
    expect(h.manifest.items["1"].state).toBe("plan-gate");
    expect(h.saves).toBe(1);
  });

  it("throws on an unknown item", async () => {
    const h = makeHarness();
    await expect(h.writers.completePlan("nope", "r", report(0.9), undefined)).rejects.toThrow(
      "unknown item nope",
    );
  });
});

describe("completeCoding", () => {
  it("sets coderReport, transitions to agent-review, pokes the reviewer", async () => {
    const item = codingItem("1");
    const h = makeHarness({ items: [item] });
    await h.writers.completeCoding("1", "report-ref", "done", latestCodingTransitionAt(item));
    const next = h.manifest.items["1"];
    expect(next.state).toBe("agent-review");
    expect(next.coderReport).toEqual({ ref: "report-ref" });
    expect(h.saves).toBe(1);
    expect(h.pokes.reviewer).toBe(1);
  });

  it("undefined reportRef deletes a prior coderReport", async () => {
    const item = codingItem("1", { coderReport: { ref: "old" } });
    const h = makeHarness({ items: [item] });
    await h.writers.completeCoding("1", undefined, "degraded", latestCodingTransitionAt(item));
    expect(h.manifest.items["1"].coderReport).toBeUndefined();
    expect(h.manifest.items["1"].state).toBe("agent-review");
  });

  it("refuses a stale run by state", async () => {
    const item = mkItem("1", "agent-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "coding", "2026-07-13T02:00:00.000Z"),
      txn("coding", "agent-review", "2026-07-13T03:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    await h.writers.completeCoding("1", "r", "done", "2026-07-13T02:00:00.000Z");
    expect(console.warn).toHaveBeenCalledWith("stale coding completion refused for 1");
    expect(h.saves).toBe(0);
    expect(h.pokes.reviewer).toBe(0);
  });

  it("refuses a stale run by token", async () => {
    const item = codingItem("1");
    const h = makeHarness({ items: [item] });
    await h.writers.completeCoding("1", "r", "done", "2026-07-13T01:59:00.000Z");
    expect(console.warn).toHaveBeenCalled();
    expect(h.manifest.items["1"].state).toBe("coding");
    expect(h.saves).toBe(0);
  });
});

describe("completeReview / completePrOpen / completeReentry / completeMergedCleanup", () => {
  it("completeReview stores the review, transitions, pokes coder + shepherd once each", async () => {
    const item = mkItem("1", "agent-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "agent-review", "2026-07-13T03:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    const review: AgentReview = { rounds: 1, outcome: "approve", at: "2026-07-13T04:00:00.000Z" };
    await h.writers.completeReview("1", review, "human-review", "approved");
    const next = h.manifest.items["1"];
    expect(next.state).toBe("human-review");
    expect(next.review).toEqual(review);
    expect(h.saves).toBe(1);
    expect(h.pokes.coder).toBe(1);
    expect(h.pokes.shepherd).toBe(1);
  });

  it("completeReview starts an item with no review history (#205)", async () => {
    const item = mkItem("1", "agent-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "agent-review", "2026-07-13T03:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    const review: AgentReview = { rounds: 1, outcome: "approve", at: "2026-07-13T04:00:00.000Z" };
    await h.writers.completeReview("1", review, "human-review", "approved");
    expect(h.manifest.items["1"].review?.history).toBeUndefined();
  });

  it("completeReview snapshots the prior record onto history, stripping transients (#205)", async () => {
    const prior: AgentReview = {
      rounds: 1,
      outcome: "reject",
      objections: [{ kind: "risk", detail: "boom", blocking: true }],
      pendingObjections: [{ kind: "risk", detail: "boom", blocking: true }],
      sessionId: "sess-1",
      at: "2026-07-13T04:00:00.000Z",
    };
    const item = mkItem(
      "1",
      "agent-review",
      [
        txn(null, "triage", "2026-07-13T00:00:00.000Z"),
        txn("triage", "agent-review", "2026-07-13T03:00:00.000Z"),
      ],
      { review: prior },
    );
    const h = makeHarness({ items: [item] });
    const next: AgentReview = { rounds: 2, outcome: "approve", at: "2026-07-13T05:00:00.000Z" };
    await h.writers.completeReview("1", next, "human-review", "approved");
    const review = h.manifest.items["1"].review;
    expect(review?.rounds).toBe(2);
    expect(review?.history).toHaveLength(1);
    expect(review?.history?.[0]).toMatchObject({ round: 1, outcome: "reject" });
    expect(review?.history?.[0]).not.toHaveProperty("pendingObjections");
    expect(review?.history?.[0]).not.toHaveProperty("sessionId");
  });

  it("completeReview stacks two priors oldest-first (#205)", async () => {
    const item = mkItem("1", "agent-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "agent-review", "2026-07-13T03:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    const backToReview = () => {
      h.manifest.items["1"] = { ...h.manifest.items["1"], state: "agent-review" };
    };
    await h.writers.completeReview(
      "1",
      { rounds: 1, outcome: "reject", at: "2026-07-13T04:00:00.000Z" },
      "coding",
      "r1",
    );
    backToReview();
    await h.writers.completeReview(
      "1",
      { rounds: 2, outcome: "reject", at: "2026-07-13T05:00:00.000Z" },
      "coding",
      "r2",
    );
    backToReview();
    await h.writers.completeReview(
      "1",
      { rounds: 3, outcome: "approve", at: "2026-07-13T06:00:00.000Z" },
      "human-review",
      "r3",
    );
    const review = h.manifest.items["1"].review;
    expect(review?.rounds).toBe(3);
    expect(review?.history?.map((r) => r.round)).toEqual([1, 2]);
    expect(review?.history?.map((r) => r.outcome)).toEqual(["reject", "reject"]);
  });

  it("completePrOpen sets pr + lastPushedSha, clears pending comments, no poke", async () => {
    const item = mkItem("1", "human-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "human-review", "2026-07-13T04:00:00.000Z"),
    ], { shepherd: { pendingReviewComments: [{ path: "a", line: 1, body: "x" } as never] } });
    const h = makeHarness({ items: [item] });
    const pr = { id: "PR1", number: 7, url: "https://gh/pr/7" };
    await h.writers.completePrOpen("1", pr, "sha123", "shepherd", "opened");
    const next = h.manifest.items["1"];
    expect(next.state).toBe("pr-open");
    expect(next.pr).toEqual(pr);
    expect(next.shepherd?.lastPushedSha).toBe("sha123");
    expect(next.shepherd?.pendingReviewComments).toBeUndefined();
    expect(h.saves).toBe(1);
  });

  it("completeReentry stores comments, moves to coding, pokes coder", async () => {
    const item = mkItem("1", "changes-requested", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "changes-requested", "2026-07-13T05:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    const comments = [{ path: "a", line: 1, body: "fix" } as never];
    await h.writers.completeReentry("1", comments, "changes");
    const next = h.manifest.items["1"];
    expect(next.state).toBe("coding");
    expect(next.shepherd?.pendingReviewComments).toEqual(comments);
    expect(h.saves).toBe(1);
    expect(h.pokes.coder).toBe(1);
    // The actor defaults to shepherd (the changes-requested re-entry).
    expect(next.transitions.at(-1)?.actor).toBe("shepherd");
  });

  it("completeReentry records an explicit actor on the transition (coder chat apply)", async () => {
    const item = mkItem("1", "human-review", [
      txn(null, "triage", "2026-07-13T00:00:00.000Z"),
      txn("triage", "human-review", "2026-07-13T04:00:00.000Z"),
    ]);
    const h = makeHarness({ items: [item] });
    const comments = [{ path: "a", body: "fix" } as never];
    await h.writers.completeReentry("1", comments, "coder chat apply", "user");
    const next = h.manifest.items["1"];
    expect(next.state).toBe("coding");
    expect(next.transitions.at(-1)?.actor).toBe("user");
  });

  it("completeMergedCleanup archives the plan, drops the worktree, no transition", async () => {
    const item = mkItem("1", "merged", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], {
      worktree: { path: "/wt", branch: "b" },
      plan: { ref: "plan-1" },
    });
    const h = makeHarness({ items: [item] });
    await h.writers.completeMergedCleanup("1", "mem-1");
    const next = h.manifest.items["1"];
    expect(next.state).toBe("merged");
    expect(next.worktree).toBeUndefined();
    expect(next.plan?.ref).toBe("plan-1.archived");
    expect(next.shepherd?.memoryRef).toBe("mem-1");
    expect(h.archived).toHaveLength(1);
    expect(h.saves).toBe(1);
  });
});

describe("set* persistence + soft-return asymmetry", () => {
  it("setWorktree persists the record without a transition", async () => {
    const item = codingItem("1");
    const h = makeHarness({ items: [item] });
    await h.writers.setWorktree("1", { path: "/wt", branch: "b", sessionId: "s" });
    expect(h.manifest.items["1"].worktree).toEqual({ path: "/wt", branch: "b", sessionId: "s" });
    expect(h.manifest.items["1"].state).toBe("coding");
    expect(h.saves).toBe(1);
  });

  it("setPlanSessionId persists the session under plan", async () => {
    const item = planningItem("1");
    const h = makeHarness({ items: [item] });
    await h.writers.setPlanSessionId("1", "sess-1");
    expect(h.manifest.items["1"].plan?.sessionId).toBe("sess-1");
  });

  it("setReviewSessionId seeds a stub review on round 1", async () => {
    const item = mkItem("1", "agent-review", [txn(null, "triage", "2026-07-13T00:00:00.000Z")]);
    const h = makeHarness({ items: [item] });
    await h.writers.setReviewSessionId("1", "rsess");
    const review = h.manifest.items["1"].review;
    expect(review?.sessionId).toBe("rsess");
    expect(review?.rounds).toBe(0);
    expect(review?.outcome).toBe("unavailable");
  });

  it("setReviewSessionId preserves an existing review's fields", async () => {
    const item = mkItem("1", "agent-review", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], {
      review: { rounds: 2, outcome: "concerns", at: "2026-07-13T04:00:00.000Z" },
    });
    const h = makeHarness({ items: [item] });
    await h.writers.setReviewSessionId("1", "rsess");
    expect(h.manifest.items["1"].review).toMatchObject({ rounds: 2, outcome: "concerns", sessionId: "rsess" });
  });

  it("setWorktree throws on an unknown item (hard throw)", async () => {
    const h = makeHarness();
    await expect(h.writers.setWorktree("x", { path: "/wt", branch: "b" })).rejects.toThrow(
      "unknown item x",
    );
  });

  it("setPlanRescoring soft-returns on an unknown item (no throw, no save)", async () => {
    const h = makeHarness();
    await expect(h.writers.setPlanRescoring("x")).resolves.toBeUndefined();
    expect(h.saves).toBe(0);
  });

  it("completeRescore soft-returns on an unknown item (no throw, no save)", async () => {
    const h = makeHarness();
    await expect(h.writers.completeRescore("x", 0.9)).resolves.toBeUndefined();
    expect(h.saves).toBe(0);
  });

  it("setPlanRescoring flags the plan", async () => {
    const item = mkItem("1", "plan-gate", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], {
      plan: { ref: "r" },
    });
    const h = makeHarness({ items: [item] });
    await h.writers.setPlanRescoring("1");
    expect(h.manifest.items["1"].plan?.rescoring).toBe(true);
  });
});

describe("completeRescore", () => {
  it("clears the rescoring flag and sets confidence when still at the gate", async () => {
    const item = mkItem("1", "plan-gate", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], {
      plan: { ref: "r", confidence: 0.5, rescoring: true },
    });
    const h = makeHarness({ items: [item] });
    await h.writers.completeRescore("1", 0.8);
    const plan = h.manifest.items["1"].plan;
    expect(plan?.confidence).toBe(0.8);
    expect(plan?.rescoring).toBeUndefined();
    expect(h.manifest.items["1"].state).toBe("plan-gate");
  });

  it("clears the flag but does NOT set confidence off the gate", async () => {
    const item = codingItem("1", { plan: { ref: "r", confidence: 0.5, rescoring: true } });
    const h = makeHarness({ items: [item] });
    await h.writers.completeRescore("1", 0.8);
    const plan = h.manifest.items["1"].plan;
    expect(plan?.confidence).toBe(0.5);
    expect(plan?.rescoring).toBeUndefined();
    expect(h.manifest.items["1"].state).toBe("coding");
  });

  it("clears the flag with no composite provided", async () => {
    const item = mkItem("1", "plan-gate", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], {
      plan: { ref: "r", confidence: 0.5, rescoring: true },
    });
    const h = makeHarness({ items: [item] });
    await h.writers.completeRescore("1");
    expect(h.manifest.items["1"].plan?.confidence).toBe(0.5);
    expect(h.manifest.items["1"].plan?.rescoring).toBeUndefined();
  });
});

function triageItem(id: string, extra: Partial<TrackedItem> = {}): TrackedItem {
  return mkItem(id, "triage", [txn(null, "triage", "2026-07-13T00:00:00.000Z")], extra);
}

describe("requestTransition", () => {
  it("persists the transition and returns the next item", async () => {
    const item = triageItem("1");
    const h = makeHarness({ items: [item] });
    const next = await h.writers.requestTransition("1", "planning", "user");
    expect(next.state).toBe("planning");
    expect(h.manifest.items["1"].state).toBe("planning");
    expect(h.saves).toBe(1);
    expect(h.broadcasts).toBe(1);
  });

  it("propagates IllegalTransitionError without a save", async () => {
    const item = triageItem("1");
    const h = makeHarness({ items: [item] });
    await expect(h.writers.requestTransition("1", "pr-open", "user")).rejects.toThrow(
      /illegal transition/,
    );
    expect(h.manifest.items["1"].state).toBe("triage");
    expect(h.saves).toBe(0);
    expect(h.broadcasts).toBe(0);
  });

  it("throws on an unknown item", async () => {
    const h = makeHarness();
    await expect(h.writers.requestTransition("x", "planning", "user")).rejects.toThrow(
      "unknown item x",
    );
  });

  it("a user leaving triage clears the holdAutoPlan hold", async () => {
    const item = triageItem("1", { holdAutoPlan: true });
    const h = makeHarness({ items: [item] });
    await h.writers.requestTransition("1", "planning", "user");
    expect(h.manifest.items["1"].holdAutoPlan).toBeUndefined();
  });

  describe("park matrix", () => {
    it("a user park from plan-gate clears the worktree and discards it", async () => {
      const item = mkItem("1", "plan-gate", [
        txn(null, "triage", "2026-07-13T00:00:00.000Z"),
        txn("triage", "plan-gate", "2026-07-13T02:00:00.000Z"),
      ], { worktree: { path: "/wt", branch: "b" } });
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "needs-input", "user");
      expect(h.manifest.items["1"].worktree).toBeUndefined();
      expect(h.parks).toEqual([{ itemId: "1", worktree: { path: "/wt", branch: "b" } }]);
    });

    it("a planner failure into needs-input does NOT park", async () => {
      const item = planningItem("1", { worktree: { path: "/wt", branch: "b" } });
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "needs-input", "planner");
      expect(h.manifest.items["1"].worktree).toEqual({ path: "/wt", branch: "b" });
      expect(h.parks).toEqual([]);
    });
  });

  describe("cancellation matrix", () => {
    it("a planner self-transition cancels nothing and does not poke the planner", async () => {
      const item = planningItem("1");
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "needs-input", "planner");
      expect(h.cancels.planning).toEqual([]);
      expect(h.pokes.planner).toBe(0);
    });

    it("a non-planner moving a live planning item cancels the run and pokes the planner", async () => {
      const item = planningItem("1");
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "plan-gate", "user");
      expect(h.cancels.planning).toEqual(["1"]);
      expect(h.pokes.planner).toBe(1);
    });

    it("leaving plan-gate cancels the plan chat and rescore", async () => {
      const item = mkItem("1", "plan-gate", [
        txn(null, "triage", "2026-07-13T00:00:00.000Z"),
        txn("triage", "plan-gate", "2026-07-13T02:00:00.000Z"),
      ]);
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "queued", "user");
      expect(h.cancels.planChat).toEqual(["1"]);
      expect(h.cancels.rescore).toEqual(["1"]);
    });

    it("entering coding cancels the coder agent chat", async () => {
      const item = mkItem("1", "queued", [
        txn(null, "triage", "2026-07-13T00:00:00.000Z"),
        txn("triage", "queued", "2026-07-13T01:00:00.000Z"),
      ]);
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "coding", "user");
      expect(h.cancels.agentChat).toEqual([{ kind: "coder", id: "1" }]);
    });

    it("entering agent-review cancels the reviewer agent chat", async () => {
      const item = codingItem("1");
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "agent-review", "user");
      expect(h.cancels.agentChat).toEqual([{ kind: "reviewer", id: "1" }]);
      // a user forcing a live coding item out cancels the coding run
      expect(h.cancels.coding).toEqual(["1"]);
    });

    it("a coder self-exit does not cancel the coding run or poke the coder", async () => {
      const item = codingItem("1");
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "agent-review", "coder");
      expect(h.cancels.coding).toEqual([]);
      expect(h.pokes.coder).toBe(0);
      // the reviewer is still poked and the reviewer agent chat cancelled
      expect(h.pokes.reviewer).toBe(1);
      expect(h.cancels.agentChat).toEqual([{ kind: "reviewer", id: "1" }]);
    });

    it("suppresses the own-actor poke (shepherd)", async () => {
      const item = mkItem("1", "human-review", [
        txn(null, "triage", "2026-07-13T00:00:00.000Z"),
        txn("triage", "human-review", "2026-07-13T04:00:00.000Z"),
      ]);
      const h = makeHarness({ items: [item] });
      await h.writers.requestTransition("1", "pr-open", "shepherd");
      expect(h.pokes.shepherd).toBe(0);
      expect(h.pokes.planner).toBe(1);
      expect(h.pokes.coder).toBe(1);
      expect(h.pokes.reviewer).toBe(1);
    });
  });
});
