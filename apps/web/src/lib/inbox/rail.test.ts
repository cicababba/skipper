import { describe, expect, it } from "vitest";
import type {
  LifecycleState,
  OrchestratorAccountState,
  TrackedItem,
} from "@skipper/shared";
import { ATTENTION_STATES } from "./model";
import { accountsSummary, attentionItems, attentionTone } from "./rail";

function item(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    sourceRef: { project: "octo/repo", key: "1" },
    codeHost: "github",
    key: "1",
    accountId: "acc",
    repo: { owner: "octo", name: "repo" },
    number: 1,
    title: "t",
    url: "https://github.com/octo/repo/issues/1",
    state: "triage",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    transitions: [],
    ...overrides,
  };
}

function account(overrides: Partial<OrchestratorAccountState>): OrchestratorAccountState {
  return {
    accountId: "acc",
    status: "idle",
    issues: [],
    pullRequests: [],
    ...overrides,
  };
}

describe("attentionItems", () => {
  it("includes every attention state and excludes the rest", () => {
    const attention = ATTENTION_STATES.map((state, i) => item({ id: `a${i}`, state }));
    const others: LifecycleState[] = [
      "triage",
      "planning",
      "queued",
      "coding",
      "agent-review",
      "pr-open",
      "in-review",
      "changes-requested",
      "merged",
      "closed",
    ];
    const nonAttention = others.map((state, i) => item({ id: `o${i}`, state }));
    const { shown, overflow } = attentionItems([...attention, ...nonAttention]);
    expect(new Set(shown.map((it) => it.state))).toEqual(new Set(ATTENTION_STATES));
    expect(overflow).toBe(0);
  });

  it("orders by severity failed > blocked > needs-input > plan-gate > human-review", () => {
    const items = [
      item({ id: "hr", state: "human-review" }),
      item({ id: "pg", state: "plan-gate" }),
      item({ id: "ni", state: "needs-input" }),
      item({ id: "bl", state: "blocked" }),
      item({ id: "fa", state: "failed" }),
    ];
    const { shown } = attentionItems(items);
    expect(shown.map((it) => it.id)).toEqual(["fa", "bl", "ni", "pg", "hr"]);
  });

  it("breaks severity ties by updatedAt ascending (longest-waiting first)", () => {
    const items = [
      item({ id: "new", state: "failed", updatedAt: "2026-07-03T00:00:00Z" }),
      item({ id: "old", state: "failed", updatedAt: "2026-07-01T00:00:00Z" }),
      item({ id: "mid", state: "failed", updatedAt: "2026-07-02T00:00:00Z" }),
    ];
    const { shown } = attentionItems(items);
    expect(shown.map((it) => it.id)).toEqual(["old", "mid", "new"]);
  });

  it("caps the list and reports the overflow count", () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      item({ id: `i${i}`, state: "blocked", updatedAt: `2026-07-0${i + 1}T00:00:00Z` }),
    );
    const { shown, overflow } = attentionItems(items);
    expect(shown).toHaveLength(5);
    expect(overflow).toBe(3);
  });

  it("reports zero overflow when the count is exactly at the cap", () => {
    const items = Array.from({ length: 5 }, (_, i) => item({ id: `i${i}`, state: "blocked" }));
    const { shown, overflow } = attentionItems(items);
    expect(shown).toHaveLength(5);
    expect(overflow).toBe(0);
  });

  it("honours a custom cap", () => {
    const items = Array.from({ length: 4 }, (_, i) => item({ id: `i${i}`, state: "blocked" }));
    const { shown, overflow } = attentionItems(items, 2);
    expect(shown).toHaveLength(2);
    expect(overflow).toBe(2);
  });

  it("returns an empty result when nothing needs attention", () => {
    const { shown, overflow } = attentionItems([item({ state: "coding" })]);
    expect(shown).toEqual([]);
    expect(overflow).toBe(0);
  });
});

describe("attentionTone", () => {
  it("maps failed to danger", () => {
    expect(attentionTone("failed")).toBe("danger");
  });

  it("maps needs-input and blocked to signal", () => {
    expect(attentionTone("needs-input")).toBe("signal");
    expect(attentionTone("blocked")).toBe("signal");
  });

  it("maps plan-gate and human-review to accent", () => {
    expect(attentionTone("plan-gate")).toBe("accent");
    expect(attentionTone("human-review")).toBe("accent");
  });
});

describe("accountsSummary", () => {
  it("counts error and auth-error accounts and picks the max lastSyncAt", () => {
    const summary = accountsSummary({
      a: account({ accountId: "a", status: "idle", lastSyncAt: 100 }),
      b: account({ accountId: "b", status: "error", lastSyncAt: 300 }),
      c: account({ accountId: "c", status: "auth-error", lastSyncAt: 200 }),
      d: account({ accountId: "d", status: "polling" }),
    });
    expect(summary.total).toBe(4);
    expect(summary.errors).toBe(2);
    expect(summary.lastSyncAt).toBe(300);
  });

  it("leaves lastSyncAt undefined when no account has synced", () => {
    const summary = accountsSummary({
      a: account({ accountId: "a", status: "idle" }),
      b: account({ accountId: "b", status: "polling" }),
    });
    expect(summary.total).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.lastSyncAt).toBeUndefined();
  });

  it("returns zeros for an empty record", () => {
    const summary = accountsSummary({});
    expect(summary).toEqual({ total: 0, errors: 0, lastSyncAt: undefined });
  });
});
