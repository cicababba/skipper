import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { LifecycleState, TrackedItem } from "@skipper/shared";
import { StateBadge } from "./state-badge";

// The badge only reads item.state and the last transition's reason; a minimal
// item keeps the fixture honest about what the mapping actually depends on.
function itemInState(state: LifecycleState): TrackedItem {
  return { state, transitions: [] } as unknown as TrackedItem;
}

function badgeClass(state: LifecycleState): string {
  const { container } = render(<StateBadge item={itemInState(state)} />);
  return (container.firstChild as HTMLElement).className;
}

// The design contract: every LifecycleState maps to exactly one of five
// temperatures. Muted is the quiet default; info is agent activity; signal is
// reserved for the four human-gate states; success/merged/danger are terminal-ish
// GitHub-aligned semantics.
const MUTED = "bg-card text-muted border-border";
const INFO = "bg-info-bg text-info border-info/25";
const SIGNAL = "bg-signal-bg text-signal border-signal/25";
const SUCCESS = "bg-success-bg text-success border-success/25";
const MERGED = "bg-merged-bg text-merged border-merged/25";
const DANGER = "bg-danger-bg text-danger border-danger/25";

const EXPECTED: Record<LifecycleState, string> = {
  triage: MUTED,
  queued: MUTED,
  closed: MUTED,
  planning: INFO,
  coding: INFO,
  "agent-review": INFO,
  "plan-gate": SIGNAL,
  "human-review": SIGNAL,
  "needs-input": SIGNAL,
  "changes-requested": SIGNAL,
  "pr-open": SUCCESS,
  "in-review": SUCCESS,
  merged: MERGED,
  failed: DANGER,
  blocked: DANGER,
};

const ALL_STATES = Object.keys(EXPECTED) as LifecycleState[];

// The four states where the human is on the hook — the only ones that may wear
// signal orange. Encoding this set explicitly guards the "buoy is never
// decorative" rule from both directions.
const SIGNAL_STATES: LifecycleState[] = [
  "plan-gate",
  "human-review",
  "needs-input",
  "changes-requested",
];

describe("StateBadge — three-temperature mapping", () => {
  for (const state of ALL_STATES) {
    it(`maps ${state} to its temperature triplet`, () => {
      const cls = badgeClass(state);
      for (const token of EXPECTED[state].split(" ")) {
        expect(cls).toContain(token);
      }
    });
  }
});

describe("StateBadge — signal is reserved for human-gate states", () => {
  it("uses signal classes on exactly the four human-gate states", () => {
    const signalled = ALL_STATES.filter((state) => badgeClass(state).includes("text-signal"));
    expect(signalled.sort()).toEqual([...SIGNAL_STATES].sort());
  });

  it("never leaks any signal token onto a non-gate state", () => {
    for (const state of ALL_STATES) {
      if (SIGNAL_STATES.includes(state)) continue;
      const cls = badgeClass(state);
      expect(cls).not.toContain("signal");
    }
  });
});

describe("StateBadge — temperature groups are disjoint", () => {
  it("gives muted states no color-token classes", () => {
    for (const state of ["triage", "queued", "closed"] as LifecycleState[]) {
      const cls = badgeClass(state);
      for (const token of ["info", "signal", "success", "merged", "danger"]) {
        expect(cls).not.toContain(token);
      }
    }
  });

  it("keeps merged on its own violet token, distinct from success", () => {
    const cls = badgeClass("merged");
    expect(cls).toContain("text-merged");
    expect(cls).not.toContain("success");
  });

  it("maps both failure states to danger and nothing else", () => {
    for (const state of ["failed", "blocked"] as LifecycleState[]) {
      const cls = badgeClass(state);
      expect(cls).toContain("text-danger");
      expect(cls).not.toContain("signal");
      expect(cls).not.toContain("warning");
    }
  });
});
