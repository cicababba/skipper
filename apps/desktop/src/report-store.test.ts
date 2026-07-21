import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredCoderReport } from "@skipper/shared";
import { readStoredCoderReport, reportFileName, writeStoredCoderReport } from "./report-store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nb-report-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeReport(itemId: string, summary = "did it"): StoredCoderReport {
  return {
    version: 1,
    itemId,
    repo: { owner: "octo", name: "repo" },
    issueKey: "1",
    issueNumber: 1,
    generatedAt: "2026-07-20T00:00:00.000Z",
    model: "opus",
    report: {
      done: [{ path: "src/a.ts", summary }],
      deviations: [],
      verification: [{ command: "pnpm test", passed: true }],
      open: [],
    },
  };
}

describe("reportFileName", () => {
  it("sanitizes the item id and adds the .report.json suffix", () => {
    expect(reportFileName("github:1")).toBe("github_1.report.json");
  });
});

describe("report-store round trip", () => {
  it("writes and reads a stored report", async () => {
    const ref = reportFileName("github:1");
    await writeStoredCoderReport(dir, ref, makeReport("github:1"));
    const stored = await readStoredCoderReport(dir, ref);
    expect(stored?.itemId).toBe("github:1");
    expect(stored?.report.done[0].path).toBe("src/a.ts");
  });

  it("overwrites an existing report", async () => {
    const ref = reportFileName("github:1");
    await writeStoredCoderReport(dir, ref, makeReport("github:1", "first"));
    await writeStoredCoderReport(dir, ref, makeReport("github:1", "second"));
    const stored = await readStoredCoderReport(dir, ref);
    expect(stored?.report.done[0].summary).toBe("second");
  });

  it("returns null for a missing file", async () => {
    expect(await readStoredCoderReport(dir, "nope.report.json")).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    await writeFile(join(dir, "bad.report.json"), "{not json", "utf-8");
    expect(await readStoredCoderReport(dir, "bad.report.json")).toBeNull();
  });

  it("returns null for an unknown version", async () => {
    await writeFile(join(dir, "v9.report.json"), JSON.stringify({ version: 9 }), "utf-8");
    expect(await readStoredCoderReport(dir, "v9.report.json")).toBeNull();
  });
});
