import { describe, expect, it } from "vitest";
import type {
  AgentReview,
  IssuePlan,
  StoredCoderReport,
  StoredPlan,
  TrackedItem,
} from "@skipper/shared";
import { dossierMarkdown } from "./dossier-markdown";

function item(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "acme/widget", key: "42" },
    codeHost: "github",
    accountId: "acme",
    repo: { owner: "acme", name: "widget" },
    key: "42",
    title: "Fix the thing",
    url: "https://github.com/acme/widget/issues/42",
    state: "planning",
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:00:00.000Z",
    transitions: [],
    ...over,
  };
}

const plan: IssuePlan = {
  summary: "the plan",
  files: [],
  steps: [],
  acceptance: [],
  risks: [],
  openQuestions: [],
  estimatedSize: "s",
};

function storedPlan(over: Partial<StoredPlan> = {}): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: { owner: "acme", name: "widget" },
    generatedAt: "2026-07-23T10:00:00.000Z",
    model: "claude-opus",
    plan,
    ...over,
  };
}

const report: StoredCoderReport = {
  version: 1,
  itemId: "github:1",
  repo: { owner: "acme", name: "widget" },
  generatedAt: "2026-07-23T11:00:00.000Z",
  model: "claude-opus",
  report: { done: [{ path: "a.ts", summary: "s" }], deviations: [], verification: [], open: [] },
};

const review: AgentReview = {
  rounds: 1,
  outcome: "approve",
  at: "2026-07-23T12:00:00.000Z",
};

describe("dossierMarkdown", () => {
  it("renders only the header for a metadata-only item", () => {
    const md = dossierMarkdown({ item: item(), plan: null, report: null, diff: null });
    expect(md).toContain("# Fix the thing (#42)");
    expect(md).toContain("- **Repo:** acme/widget");
    expect(md).toContain("- **Issue:** https://github.com/acme/widget/issues/42");
    expect(md).toContain("- **State:** planning");
    expect(md).not.toContain("---");
    expect(md).not.toContain("## Issue");
    expect(md).not.toContain("# Plan");
    expect(md).not.toContain("# Coder report");
    expect(md).not.toContain("# Review");
    expect(md).not.toContain("# Diff");
    expect(md).not.toContain("Confidence");
  });

  it("composes every artifact in order separated by horizontal rules", () => {
    const md = dossierMarkdown({
      item: item({ body: "the issue body", review }),
      plan: storedPlan(),
      report,
      diff: "diff --git a b",
    });
    expect(md).toContain("\n\n---\n\n");
    const pos = (s: string) => md.indexOf(s);
    expect(pos("# Fix the thing (#42)")).toBeGreaterThan(-1);
    expect(pos("## Issue\n\nthe issue body")).toBeGreaterThan(pos("# Fix the thing (#42)"));
    expect(pos("# Plan")).toBeGreaterThan(pos("## Issue"));
    expect(pos("# Coder report")).toBeGreaterThan(pos("# Plan"));
    expect(pos("# Review")).toBeGreaterThan(pos("# Coder report"));
    expect(pos("# Diff")).toBeGreaterThan(pos("# Review"));
  });

  it("falls back to item.plan.confidence when the stored plan has none", () => {
    const md = dossierMarkdown({
      item: item({ plan: { confidence: 0.5, ref: "r" } }),
      plan: null,
      report: null,
      diff: null,
    });
    expect(md).toContain("- **Confidence:** 50%");
  });

  it("prefers the stored plan's confidence over item.plan.confidence", () => {
    const conf = {
      version: 1 as const,
      composite: 0.9,
      weights: { groundedness: 1, convergence: 0, critic: 0, clarity: 0 },
      signals: {},
      errors: [],
      computedAt: "2026-07-23T10:00:00.000Z",
    };
    const md = dossierMarkdown({
      item: item({ plan: { confidence: 0.5, ref: "r" } }),
      plan: storedPlan({ confidence: conf }),
      report: null,
      diff: null,
    });
    expect(md).toContain("- **Confidence:** 90%");
  });

  it("omits an empty-string diff", () => {
    const md = dossierMarkdown({
      item: item({ worktree: { path: "/w", branch: "b" } }),
      plan: null,
      report: null,
      diff: "",
    });
    expect(md).not.toContain("# Diff");
  });
});
