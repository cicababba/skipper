import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ConfidenceReport, IssuePlan, StoredPlan } from "@skipper/shared";
import { DecisionRail } from "./decision-rail";

const basePlan: IssuePlan = {
  summary: "s",
  files: [],
  steps: [],
  acceptance: [],
  risks: [],
  openQuestions: [],
  estimatedSize: "m",
};

function makeReport(partial: Partial<ConfidenceReport> = {}): ConfidenceReport {
  return {
    version: 1,
    composite: 0.8,
    weights: { groundedness: 0.4, convergence: 0.2, critic: 0.3, clarity: 0.1 },
    signals: {},
    errors: [],
    computedAt: "2026-07-21T10:00:00.000Z",
    ...partial,
  };
}

function makeStored(confidence?: ConfidenceReport, extra?: Partial<StoredPlan>): StoredPlan {
  return {
    version: 2,
    itemId: "item-1",
    repo: { host: "github", owner: "o", name: "r" },
    generatedAt: "2026-07-21T10:00:00.000Z",
    model: "claude",
    plan: basePlan,
    confidence,
    ...extra,
  } as StoredPlan;
}

const cleanGroundedness = {
  score: 0.9,
  filesChecked: 3,
  filesFound: 3,
  symbolsChecked: 2,
  symbolsFound: 2,
  missingFiles: [] as string[],
  missingSymbols: [] as string[],
  newFiles: [] as string[],
};
const approveCritic = { score: 0.9, verdict: "approve" as const, objections: [] };

function renderRail(overrides: Partial<React.ComponentProps<typeof DecisionRail>> = {}) {
  const props: React.ComponentProps<typeof DecisionRail> = {
    itemId: "item-1",
    stored: makeStored(makeReport()),
    plan: basePlan,
    gate: false,
    rescoring: false,
    prevComposite: null,
    editBusy: false,
    actionsDisabled: false,
    busyAction: null,
    actionError: null,
    saving: false,
    dirtyFiles: null,
    onCleanWorktree: () => {},
    onAction: () => {},
    onSizeChange: () => {},
    ...overrides,
  };
  return render(<DecisionRail {...props} />);
}

const fullReportToggle = () => screen.queryByRole("button", { name: /Full report/ });

afterEach(() => {
  localStorage.clear();
});

describe("DecisionRail — rescore delta", () => {
  it("shows no delta line when there is no prior composite", () => {
    renderRail({ stored: makeStored(makeReport({ composite: 0.78 })), prevComposite: null });
    expect(screen.queryByText(/from 7\d%|from 8\d%/)).toBeNull();
  });

  it("renders an ↑ delta from the prior percentage when the score rose", () => {
    renderRail({ stored: makeStored(makeReport({ composite: 0.78 })), prevComposite: 0.74 });
    expect(screen.getByText("↑ from 74%")).toBeTruthy();
  });

  it("renders a ↓ delta when the score dropped", () => {
    renderRail({ stored: makeStored(makeReport({ composite: 0.78 })), prevComposite: 0.8 });
    expect(screen.getByText("↓ from 80%")).toBeTruthy();
  });

  it("shows no delta when the composite is unchanged", () => {
    renderRail({ stored: makeStored(makeReport({ composite: 0.78 })), prevComposite: 0.78 });
    expect(screen.queryByText(/↑ from|↓ from/)).toBeNull();
  });

  it("shows the rescoring spinner and no delta while rescoring", () => {
    renderRail({
      stored: makeStored(makeReport({ composite: 0.78 })),
      prevComposite: 0.74,
      rescoring: true,
    });
    expect(screen.getByText("Rescoring confidence…")).toBeTruthy();
    expect(screen.queryByText(/↑ from|↓ from/)).toBeNull();
  });
});

describe("DecisionRail — Full report anomaly gating", () => {
  it("hides the Full report toggle when nothing is anomalous", () => {
    renderRail({
      stored: makeStored(
        makeReport({
          signals: {
            groundedness: cleanGroundedness,
            convergence: {
              score: 0.8,
              planCount: 3,
              fileJaccard: 0.9,
              sizeAgreement: 1,
              stepCountAgreement: 1,
              divergent: false,
              sharedFiles: [],
              disputedFiles: [],
            },
            critic: approveCritic,
            clarity: {
              score: 0.8,
              criteria: "verifiable",
              ambiguities: [],
              openQuestions: [],
              rationale: "the issue states checkable outcomes",
            },
          },
        }),
      ),
    });
    expect(fullReportToggle()).toBeNull();
  });

  it("lists groundedness misses truncated at five with a +N remainder", () => {
    const { container } = renderRail({
      stored: makeStored(
        makeReport({
          signals: {
            groundedness: {
              ...cleanGroundedness,
              score: 0.4,
              missingFiles: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"],
            },
            critic: approveCritic,
          },
        }),
      ),
    });
    fireEvent.click(fullReportToggle()!);
    const text = container.textContent ?? "";
    expect(text).toContain("Missing:");
    expect(text).toContain("+2 more");
    expect(text).not.toContain("f6");
    expect(text).not.toContain("f7");
  });

  it("renders every critic objection with kind, BLOCKING tag, and full detail", () => {
    const { container } = renderRail({
      stored: makeStored(
        makeReport({
          signals: {
            groundedness: cleanGroundedness,
            critic: {
              score: 0.2,
              verdict: "reject",
              objections: [
                { kind: "missing-step", detail: "no rollback path", blocking: true },
                { kind: "risk", detail: "perf regression", blocking: false },
              ],
            },
          },
        }),
      ),
    });
    fireEvent.click(fullReportToggle()!);
    const text = container.textContent ?? "";
    expect(text).toContain("reject");
    expect(text).toContain("missing-step");
    expect(text).toContain("blocking");
    expect(text).toContain("no rollback path");
    // A non-blocking objection is still shown.
    expect(text).toContain("risk");
    expect(text).toContain("perf regression");
  });

  // #308: the badge tells the user which objections the critic could not check.
  it("badges an unverified objection and leaves a demonstrated one bare", () => {
    const { container } = renderRail({
      stored: makeStored(
        makeReport({
          signals: {
            groundedness: cleanGroundedness,
            critic: {
              score: 0.85,
              verdict: "concerns",
              objections: [
                { kind: "risk", detail: "pnpm typecheck may not exist", blocking: false, unverified: true },
                { kind: "other", detail: "arity mismatch in the assertion", blocking: false },
              ],
            },
          },
        }),
      ),
    });
    fireEvent.click(fullReportToggle()!);
    expect(screen.getAllByText("unverified")).toHaveLength(1);
    const text = container.textContent ?? "";
    expect(text).toContain("pnpm typecheck may not exist");
    expect(text).toContain("arity mismatch in the assertion");
  });

  it("shows no unverified badge when every objection is demonstrated", () => {
    renderRail({
      stored: makeStored(
        makeReport({
          signals: {
            groundedness: cleanGroundedness,
            critic: {
              score: 0.6,
              verdict: "concerns",
              objections: [
                { kind: "risk", detail: "d1", blocking: false, unverified: false },
                { kind: "other", detail: "d2", blocking: false },
              ],
            },
          },
        }),
      ),
    });
    fireEvent.click(fullReportToggle()!);
    expect(screen.queryByText("unverified")).toBeNull();
  });

  it("shows the skip detail line for a convergence-skipped report", () => {
    const { container } = renderRail({
      stored: makeStored(
        makeReport({
          signals: { groundedness: cleanGroundedness, critic: approveCritic },
          convergenceSkipped: { reason: "decisive", detail: "composite decisive already" },
        }),
      ),
    });
    fireEvent.click(fullReportToggle()!);
    expect(container.textContent ?? "").toContain("composite decisive already");
  });
});

describe("DecisionRail — dirty worktree (#204)", () => {
  const dirtyToggle = () => screen.queryByRole("button", { name: /Worktree has/ });
  const cleanButton = () => screen.queryByRole("button", { name: "Clean worktree" });

  it("shows no indicator when dirtyFiles is null", () => {
    renderRail({ dirtyFiles: null });
    expect(dirtyToggle()).toBeNull();
    expect(cleanButton()).toBeNull();
  });

  it("shows no indicator when dirtyFiles is empty", () => {
    renderRail({ dirtyFiles: [] });
    expect(dirtyToggle()).toBeNull();
    expect(cleanButton()).toBeNull();
  });

  it("renders the count label when the worktree is dirty", () => {
    renderRail({ dirtyFiles: ["src/a.ts", "src/b.ts"] });
    expect(screen.getByText("Worktree has 2 uncommitted files")).toBeTruthy();
  });

  it("reveals the path list on chevron click, hidden until then", () => {
    renderRail({ dirtyFiles: ["src/a.ts", "src/b.ts"] });
    expect(screen.queryByText("src/a.ts")).toBeNull();
    fireEvent.click(dirtyToggle()!);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("fires onCleanWorktree when the Clean worktree button is clicked", () => {
    const onCleanWorktree = vi.fn();
    renderRail({ dirtyFiles: ["src/a.ts"], onCleanWorktree });
    fireEvent.click(cleanButton()!);
    expect(onCleanWorktree).toHaveBeenCalledTimes(1);
  });
});
