import { describe, expect, it } from "vitest";
import type { CoderReport, StoredCoderReport } from "@skipper/shared";
import { coderReportMarkdown } from "./coder-report-markdown";

function report(over: Partial<CoderReport> = {}): CoderReport {
  return { done: [], deviations: [], verification: [], open: [], ...over };
}

function stored(over: Partial<CoderReport> = {}): StoredCoderReport {
  return {
    version: 1,
    itemId: "github:1",
    repo: { owner: "acme", name: "widget" },
    generatedAt: "2026-07-23T11:00:00.000Z",
    model: "claude-opus",
    report: report(over),
  };
}

describe("coderReportMarkdown", () => {
  it("omits empty deviations and open sections", () => {
    const md = coderReportMarkdown(
      stored({
        done: [{ path: "src/a.ts", summary: "added it" }],
        verification: [{ command: "pnpm test", passed: true }],
      }),
    );
    expect(md).toContain("# Coder report");
    expect(md).toContain("- **Generated:** 2026-07-23T11:00:00.000Z");
    expect(md).toContain("## Done\n\n- `src/a.ts` — added it");
    expect(md).not.toContain("## Deviations");
    expect(md).not.toContain("## Open");
  });

  it("renders verification as a task list with pass/fail checkboxes and detail", () => {
    const md = coderReportMarkdown(
      stored({
        verification: [
          { command: "pnpm test", passed: true },
          { command: "pnpm lint", passed: false, detail: "2 errors" },
        ],
      }),
    );
    expect(md).toContain("- [x] `pnpm test`");
    expect(md).toContain("- [ ] `pnpm lint` — 2 errors");
  });

  it("renders every section when populated", () => {
    const md = coderReportMarkdown(
      stored({
        done: [{ path: "a.ts", summary: "s" }],
        deviations: ["skipped x"],
        verification: [{ command: "pnpm build", passed: true }],
        open: ["question y"],
      }),
    );
    expect(md).toContain("## Done");
    expect(md).toContain("## Deviations\n\n- skipped x");
    expect(md).toContain("## Verification");
    expect(md).toContain("## Open\n\n- question y");
  });
});
