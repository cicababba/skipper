import { describe, expect, it } from "vitest";
import { inbox } from "@/lib/i18n/inbox";
import { toastContentFor } from "./transition-toast-content";
import type { TransitionToast } from "./transition-toasts";

const t = { inbox: inbox.en };
const LABEL = "#1 fix the topbar";
const PR_URL = "https://github.com/octo/repo/pull/7";

describe("toastContentFor", () => {
  it("shows a plan at the gate with its confidence and routes to the item", () => {
    const content = toastContentFor(
      { kind: "plan-gate", itemId: "github:1", label: LABEL, confidence: 0.816 },
      t,
    );
    expect(content).toEqual({
      variant: "info",
      title: "Plan ready for review",
      message: "#1 fix the topbar · confidence 82%",
      actionLabel: "Open item",
    });
  });

  it("falls back to the bare label when the plan has no confidence", () => {
    const content = toastContentFor({ kind: "plan-gate", itemId: "github:1", label: LABEL }, t);
    expect(content.message).toBe(LABEL);
  });

  it("shows a diff waiting for review", () => {
    const content = toastContentFor({ kind: "human-review", itemId: "github:1", label: LABEL }, t);
    expect(content).toEqual({
      variant: "info",
      title: "Changes ready for review",
      message: LABEL,
      actionLabel: "Open item",
    });
  });

  it("auto-dismisses a newly opened PR", () => {
    const content = toastContentFor(
      { kind: "pr-open", itemId: "github:1", label: LABEL, prUrl: PR_URL, repush: false },
      t,
    );
    expect(content).toEqual({
      variant: "success",
      title: "PR opened",
      message: LABEL,
      actionLabel: "View PR",
      durationMs: 5000,
    });
  });

  it("titles a repush as an update", () => {
    const content = toastContentFor(
      { kind: "pr-open", itemId: "github:1", label: LABEL, prUrl: PR_URL, repush: true },
      t,
    );
    expect(content.title).toBe("PR updated");
  });

  it("shows the needs-input reason and stays sticky", () => {
    const content = toastContentFor(
      { kind: "needs-input", itemId: "github:1", label: LABEL, reason: "the coder run failed" },
      t,
    );
    expect(content).toEqual({
      variant: "error",
      title: "Needs your input",
      message: "#1 fix the topbar — the coder run failed",
      actionLabel: "Open item",
    });
  });

  it("drops the separator when there is no reason", () => {
    const content = toastContentFor({ kind: "needs-input", itemId: "github:1", label: LABEL }, t);
    expect(content.message).toBe(LABEL);
  });

  it("shows requested changes as a sticky error", () => {
    const content = toastContentFor(
      { kind: "changes-requested", itemId: "github:1", label: LABEL, prUrl: PR_URL },
      t,
    );
    expect(content).toEqual({
      variant: "error",
      title: "Changes requested",
      message: LABEL,
      actionLabel: "View PR",
    });
  });

  it("shows a CI failure as a sticky error", () => {
    const content = toastContentFor(
      { kind: "ci-failed", itemId: "github:1", label: LABEL, prUrl: PR_URL },
      t,
    );
    expect(content).toEqual({
      variant: "error",
      title: "CI failed",
      message: LABEL,
      actionLabel: "View PR",
    });
  });

  it("auto-dismisses a merge", () => {
    const content = toastContentFor(
      { kind: "merged", itemId: "github:1", label: LABEL, prUrl: PR_URL },
      t,
    );
    expect(content).toEqual({
      variant: "success",
      title: "PR merged",
      message: LABEL,
      actionLabel: "View PR",
      durationMs: 5000,
    });
  });

  it("only auto-dismisses the two good-news kinds", () => {
    const events: TransitionToast[] = [
      { kind: "plan-gate", itemId: "i", label: LABEL },
      { kind: "human-review", itemId: "i", label: LABEL },
      { kind: "pr-open", itemId: "i", label: LABEL, prUrl: PR_URL, repush: false },
      { kind: "needs-input", itemId: "i", label: LABEL },
      { kind: "changes-requested", itemId: "i", label: LABEL, prUrl: PR_URL },
      { kind: "ci-failed", itemId: "i", label: LABEL, prUrl: PR_URL },
      { kind: "merged", itemId: "i", label: LABEL, prUrl: PR_URL },
    ];
    const timed = events
      .filter((event) => toastContentFor(event, t).durationMs !== undefined)
      .map((event) => event.kind);
    expect(timed).toEqual(["pr-open", "merged"]);
  });

  it("renders every kind in every locale", () => {
    const events: TransitionToast[] = [
      { kind: "plan-gate", itemId: "i", label: LABEL, confidence: 0.5 },
      { kind: "human-review", itemId: "i", label: LABEL },
      { kind: "pr-open", itemId: "i", label: LABEL, prUrl: PR_URL, repush: true },
      { kind: "needs-input", itemId: "i", label: LABEL, reason: "why" },
      { kind: "changes-requested", itemId: "i", label: LABEL, prUrl: PR_URL },
      { kind: "ci-failed", itemId: "i", label: LABEL, prUrl: PR_URL },
      { kind: "merged", itemId: "i", label: LABEL, prUrl: PR_URL },
    ];
    for (const dict of [inbox.en, inbox.it, inbox.fr, inbox.es]) {
      for (const event of events) {
        const content = toastContentFor(event, { inbox: dict });
        expect(content.title.length).toBeGreaterThan(0);
        expect(content.actionLabel.length).toBeGreaterThan(0);
        expect(content.message).toContain(LABEL);
      }
    }
  });
});
