import { describe, expect, it } from "vitest";
import type {
  ConfidenceReport,
  PlanChatMessage,
  StoredPlan,
  TrackedItem,
  TransitionEvent,
} from "@skipper/shared";
import { buildTimeline, formatDuration, type TimelineArtifact } from "./timeline";

function tx(at: string, to: TransitionEvent["to"], from: TransitionEvent["from"]): TransitionEvent {
  return { at, from, to, actor: "system" };
}

function item(transitions: TransitionEvent[], overrides: Partial<TrackedItem> = {}): TrackedItem {
  return {
    id: "github:1",
    state: transitions.at(-1)?.to ?? "triage",
    transitions,
    updatedAt: transitions.at(-1)?.at ?? "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as TrackedItem;
}

function report(composite: number): ConfidenceReport {
  return { composite } as ConfidenceReport;
}

function storedPlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    version: 2,
    itemId: "github:1",
    repo: { owner: "octo", name: "repo" },
    generatedAt: "2026-07-01T00:01:00.000Z",
    model: "claude",
    plan: { summary: "s", files: [], steps: [], acceptance: [], risks: [], openQuestions: [], estimatedSize: "s" },
    ...overrides,
  } as StoredPlan;
}

const NOW = Date.parse("2026-07-01T01:00:00.000Z");

describe("buildTimeline", () => {
  it("marks the admission transition as tracked and keeps one entry per transition", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
      tx("2026-07-01T00:02:00.000Z", "plan-gate", "planning"),
    ];
    const entries = buildTimeline(item(transitions), storedPlan({ confidence: report(0.8) }), [], NOW);
    expect(entries).toHaveLength(3);
    expect(entries[0].tracked).toBe(true);
    expect(entries[0].state).toBe("triage");
    expect(entries.slice(1).every((e) => !e.tracked)).toBe(true);
  });

  it("embeds the planner console on the last planning run only", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
      tx("2026-07-01T00:02:00.000Z", "plan-gate", "planning"),
      tx("2026-07-01T00:03:00.000Z", "planning", "plan-gate"),
    ];
    const entries = buildTimeline(item(transitions), storedPlan({ confidence: report(0.8) }), [], NOW);
    const planners = entries.filter(
      (e): e is typeof e & { artifact: Extract<TimelineArtifact, { kind: "planner-console" }> } =>
        e.artifact?.kind === "planner-console",
    );
    expect(planners).toHaveLength(2);
    expect(planners[0].artifact.latestRun).toBe(false);
    expect(planners[1].artifact.latestRun).toBe(true);
    expect(planners[1].artifact.model).toBe("claude");
    expect(planners[1].artifact.confidencePct).toBe(0.8);
  });

  it("uses the first revision snapshot for the generation confidence", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
      tx("2026-07-01T00:02:00.000Z", "plan-gate", "planning"),
    ];
    const plan = storedPlan({
      confidence: report(0.9),
      revisions: [{ plan: storedPlan().plan, at: "2026-07-01T00:01:30.000Z", source: "chat-apply", confidence: report(0.5) }],
    });
    const entries = buildTimeline(item(transitions), plan, [], NOW);
    const planner = entries.find((e) => e.artifact?.kind === "planner-console");
    expect(planner?.artifact?.kind === "planner-console" && planner.artifact.confidencePct).toBe(0.5);
  });

  it("interleaves plan-revision entries with message count and delta", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
      tx("2026-07-01T00:02:00.000Z", "plan-gate", "planning"),
    ];
    const messages: PlanChatMessage[] = [
      { role: "user", text: "a", at: "2026-07-01T00:01:10.000Z" },
      { role: "assistant", text: "b", at: "2026-07-01T00:01:20.000Z" },
      { role: "user", text: "c", at: "2026-07-01T00:02:30.000Z" },
    ];
    const plan = storedPlan({
      confidence: report(0.8),
      revisions: [{ plan: storedPlan().plan, at: "2026-07-01T00:01:30.000Z", source: "chat-apply", confidence: report(0.6) }],
    });
    const entries = buildTimeline(item(transitions), plan, messages, NOW);
    const rev = entries.find((e) => e.artifact?.kind === "plan-revision");
    expect(rev?.artifact?.kind).toBe("plan-revision");
    if (rev?.artifact?.kind === "plan-revision") {
      expect(rev.artifact.messageCount).toBe(2);
      expect(rev.artifact.beforePct).toBe(0.6);
      expect(rev.artifact.afterPct).toBe(0.8);
    }
    // Sorted by time: the revision at 00:01:30 sits between planning and plan-gate.
    const kinds = entries.map((e) => e.artifact?.kind ?? e.state);
    expect(kinds).toEqual(["triage", "planner-console", "plan-revision", "plan-gate"]);
  });

  it("does not count an applied marker toward the through-revision message count (#201)", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
      tx("2026-07-01T00:02:00.000Z", "plan-gate", "planning"),
    ];
    const messages: PlanChatMessage[] = [
      { role: "user", text: "a", at: "2026-07-01T00:01:10.000Z" },
      { role: "assistant", text: "b", at: "2026-07-01T00:01:20.000Z" },
      { kind: "applied", changeCount: 3, at: "2026-07-01T00:01:25.000Z" },
    ];
    const plan = storedPlan({
      confidence: report(0.8),
      revisions: [{ plan: storedPlan().plan, at: "2026-07-01T00:01:30.000Z", source: "chat-apply", confidence: report(0.6) }],
    });
    const entries = buildTimeline(item(transitions), plan, messages, NOW);
    const rev = entries.find((e) => e.artifact?.kind === "plan-revision");
    expect(rev?.artifact?.kind).toBe("plan-revision");
    if (rev?.artifact?.kind === "plan-revision") {
      expect(rev.artifact.messageCount).toBe(2);
    }
  });

  it("renders failed rounds as pointers and the last round as the reviewer console", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "coding", "queued"),
      tx("2026-07-01T00:02:00.000Z", "agent-review", "coding"),
      tx("2026-07-01T00:03:00.000Z", "coding", "agent-review"),
      tx("2026-07-01T00:04:00.000Z", "agent-review", "coding"),
    ];
    const entries = buildTimeline(item(transitions), null, [], NOW);
    const reviews = entries.filter(
      (e) => e.artifact?.kind === "review-round" || e.artifact?.kind === "reviewer-console",
    );
    expect(reviews[0].artifact).toEqual({ kind: "review-round", round: 1, failed: true });
    expect(reviews[1].artifact).toEqual({ kind: "reviewer-console", latestRun: true });
  });

  it("computes durations from the next entry, clamping the last to now", () => {
    const transitions = [
      tx("2026-07-01T00:00:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
    ];
    const entries = buildTimeline(item(transitions), null, [], NOW);
    expect(entries[0].durationMs).toBe(60_000);
    expect(entries[1].durationMs).toBe(NOW - Date.parse("2026-07-01T00:01:00.000Z"));
    expect(entries[1].current).toBe(true);
    expect(entries[1].live).toBe(true);
    expect(entries[0].current).toBe(false);
  });

  it("clamps a zero-length gap (identical timestamps) to zero", () => {
    const transitions = [
      tx("2026-07-01T00:01:00.000Z", "triage", null),
      tx("2026-07-01T00:01:00.000Z", "planning", "triage"),
    ];
    const entries = buildTimeline(item(transitions), null, [], NOW);
    expect(entries[0].state).toBe("triage");
    expect(entries[0].durationMs).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats across units", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration((2 * 24 + 3) * 60 * 60_000)).toBe("2d 3h");
    expect(formatDuration(2 * 24 * 60 * 60_000)).toBe("2d");
    expect(formatDuration(-5)).toBe("0s");
  });
});
