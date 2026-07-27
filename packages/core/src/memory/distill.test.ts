import { describe, expect, it, vi } from "vitest";
import type { ReviewRound } from "@skipper/shared";
import type { AgentRuntime } from "../runtime/types";
import {
  DISTILL_DIFF_BUDGET,
  DISTILL_REVIEW_BUDGET,
  LESSON_SCHEMA,
  buildDistillPrompt,
  distillLesson,
  formatLesson,
  type DistillInput,
} from "./distill";

// Lesson distillation (#256) is one single-shot structured call: the prompt is
// the whole contract, so the budgets and the null-on-junk guard are what these
// tests pin down. No real runtime — structured() is faked.

function round(n: number, detail: string, at = "2026-07-01T00:00:00.000Z"): ReviewRound {
  return {
    round: n,
    outcome: "reject",
    objections: [{ kind: "risk", detail, blocking: true }],
    at,
  };
}

function fakeRuntime(reply: unknown) {
  const structured = vi.fn(async () => reply);
  return { runtime: { structured } as unknown as AgentRuntime, structured };
}

const INPUT: DistillInput = {
  title: "fix oauth token refresh",
  planSummary: "swap the expiry comparison",
  planSteps: ["read the token clock", "invert the comparison"],
  diff: "diff --git a/src/auth/oauth.ts",
  reviewRounds: [round(1, "the refresh window is off by an hour")],
};

describe("buildDistillPrompt", () => {
  it("carries the title, plan gist, steps, review rounds and diff", () => {
    const prompt = buildDistillPrompt(INPUT);
    expect(prompt).toContain("fix oauth token refresh");
    expect(prompt).toContain("swap the expiry comparison");
    expect(prompt).toContain("- read the token clock");
    expect(prompt).toContain("- invert the comparison");
    expect(prompt).toContain("the refresh window is off by an hour");
    expect(prompt).toContain("diff --git a/src/auth/oauth.ts");
  });

  it("asks for the three lesson fields and forbids prose outside the JSON", () => {
    const prompt = buildDistillPrompt({ title: "t" });
    expect(prompt).toContain("problem:");
    expect(prompt).toContain("insight:");
    expect(prompt).toContain("gotchas:");
    expect(prompt).toContain("No prose outside the JSON.");
  });

  it("omits the sections a record has nothing for", () => {
    const prompt = buildDistillPrompt({ title: "bare record" });
    expect(prompt).not.toContain("Plan summary:");
    expect(prompt).not.toContain("Plan steps:");
    expect(prompt).not.toContain("Agent review rounds:");
    expect(prompt).not.toContain("Merged diff:");
  });

  it("truncates a diff past the single-shot budget and says so", () => {
    const diff = "x".repeat(DISTILL_DIFF_BUDGET + 5_000);
    const prompt = buildDistillPrompt({ title: "t", diff });
    expect(prompt).toContain("[truncated");
    expect(prompt.length).toBeLessThan(diff.length);
  });

  it("leaves a diff inside the budget untouched", () => {
    const diff = "y".repeat(1_000);
    expect(buildDistillPrompt({ title: "t", diff })).toContain(diff);
    expect(buildDistillPrompt({ title: "t", diff })).not.toContain("[truncated");
  });

  it("drops the oldest review rounds first — the late ones hold the lessons", () => {
    const filler = "z".repeat(DISTILL_REVIEW_BUDGET / 2);
    const rounds = [round(1, `oldest ${filler}`), round(2, `middle ${filler}`), round(3, "newest")];
    const prompt = buildDistillPrompt({ title: "t", reviewRounds: rounds });
    expect(prompt).toContain("newest");
    expect(prompt).not.toContain("oldest");
  });

  it("keeps the surviving rounds in oldest-first reading order", () => {
    const rounds = [round(1, "first objection"), round(2, "second objection")];
    const prompt = buildDistillPrompt({ title: "t", reviewRounds: rounds });
    expect(prompt.indexOf("first objection")).toBeLessThan(prompt.indexOf("second objection"));
  });

  it("renders a round's outcome, reason and resolved objections", () => {
    const prompt = buildDistillPrompt({
      title: "t",
      reviewRounds: [
        {
          round: 2,
          outcome: "approve",
          reason: "objections addressed",
          resolvedObjections: [{ kind: "risk", detail: "the off-by-one", blocking: true }],
          at: "2026-07-02T00:00:00.000Z",
        },
      ],
    });
    expect(prompt).toContain("Round 2: approve — objections addressed");
    expect(prompt).toContain("resolved: the off-by-one");
  });
});

describe("LESSON_SCHEMA", () => {
  it("requires problem and insight, leaving gotchas optional", () => {
    expect(LESSON_SCHEMA.required).toEqual(["problem", "insight"]);
    expect(Object.keys(LESSON_SCHEMA.properties)).toEqual(["problem", "insight", "gotchas"]);
  });
});

describe("formatLesson", () => {
  it("renders problem, insight and a gotcha list", () => {
    expect(
      formatLesson({ problem: "p", insight: "i", gotchas: ["one", "two"] }),
    ).toBe("Problem: p\nInsight: i\nGotchas:\n- one\n- two");
  });

  it("omits the gotchas block when there are none", () => {
    expect(formatLesson({ problem: "p", insight: "i" })).toBe("Problem: p\nInsight: i");
    expect(formatLesson({ problem: "p", insight: "i", gotchas: [] })).toBe("Problem: p\nInsight: i");
  });

  it("trims the fields and drops blank gotchas", () => {
    expect(formatLesson({ problem: "  p  ", insight: "\ti\n", gotchas: ["  a ", "   "] })).toBe(
      "Problem: p\nInsight: i\nGotchas:\n- a",
    );
  });
});

describe("distillLesson", () => {
  it("formats a complete reply and asks for a single-turn, tool-less call", async () => {
    const { runtime, structured } = fakeRuntime({ problem: "p", insight: "i", gotchas: ["g"] });
    expect(await distillLesson(runtime, INPUT)).toBe("Problem: p\nInsight: i\nGotchas:\n- g");
    expect(structured).toHaveBeenCalledTimes(1);
    const [prompt, schema, opts] = structured.mock.calls[0] as unknown as [
      string,
      unknown,
      { tools: string },
    ];
    expect(prompt).toBe(buildDistillPrompt(INPUT));
    expect(schema).toBe(LESSON_SCHEMA);
    // Empty-but-present tools is the supported single-turn path — omitting the
    // field entirely is a type error the runtime cannot repair.
    expect(opts).toEqual({ tools: "" });
  });

  it("returns null when a required field is missing or blank", async () => {
    for (const reply of [
      { insight: "i" },
      { problem: "p" },
      { problem: "   ", insight: "i" },
      { problem: "p", insight: "" },
      {},
      null,
    ]) {
      const { runtime } = fakeRuntime(reply);
      expect(await distillLesson(runtime, INPUT)).toBeNull();
    }
  });

  it("propagates a runtime failure to the caller", async () => {
    const runtime = {
      structured: vi.fn(async () => {
        throw new Error("cli exploded");
      }),
    } as unknown as AgentRuntime;
    await expect(distillLesson(runtime, INPUT)).rejects.toThrow("cli exploded");
  });
});
