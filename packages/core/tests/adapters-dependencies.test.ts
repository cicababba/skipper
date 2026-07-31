import { describe, it, expect } from "vitest";
import { dedupeRefs, parseBodyDependencies } from "../src/adapters/dependencies";

describe("parseBodyDependencies — hash style", () => {
  it("parses a single 'Blocked by #N'", () => {
    expect(parseBodyDependencies("Blocked by #3", "o/r", "hash")).toEqual([
      { project: "o/r", key: "3" },
    ]);
  });

  it("parses a comma/and separated list with a cross-repo ref", () => {
    expect(parseBodyDependencies("depends on #4, #5 and o2/r2#6", "o/r", "hash")).toEqual([
      { project: "o/r", key: "4" },
      { project: "o/r", key: "5" },
      { project: "o2/r2", key: "6" },
    ]);
  });

  it("is case-insensitive", () => {
    expect(parseBodyDependencies("BLOCKED BY #8", "o/r", "hash")).toEqual([
      { project: "o/r", key: "8" },
    ]);
  });

  it("ignores a bare ref with no phrase", () => {
    expect(parseBodyDependencies("see #7 for context", "o/r", "hash")).toEqual([]);
  });

  it("does not swallow prose after the ref", () => {
    expect(parseBodyDependencies("blocked by #3 see #4", "o/r", "hash")).toEqual([
      { project: "o/r", key: "3" },
    ]);
  });

  it("returns nothing for an empty body", () => {
    expect(parseBodyDependencies(undefined, "o/r", "hash")).toEqual([]);
  });
});

describe("parseBodyDependencies — jira style", () => {
  it("parses a single 'blocked by PROJ-123' and derives the project from the key prefix", () => {
    expect(parseBodyDependencies("blocked by PROJ-123", "OTHER", "jira")).toEqual([
      { project: "PROJ", key: "PROJ-123" },
    ]);
  });

  it("parses a comma/and separated list across projects", () => {
    expect(parseBodyDependencies("depends on PROJ-1, PROJ-2 and OPS-9", "PROJ", "jira")).toEqual([
      { project: "PROJ", key: "PROJ-1" },
      { project: "PROJ", key: "PROJ-2" },
      { project: "OPS", key: "OPS-9" },
    ]);
  });

  it("matches the phrase case-insensitively", () => {
    expect(parseBodyDependencies("BLOCKED BY PROJ-5", "PROJ", "jira")).toEqual([
      { project: "PROJ", key: "PROJ-5" },
    ]);
  });

  it("ignores a lowercase key — Jira keys are uppercase", () => {
    expect(parseBodyDependencies("blocked by proj-5", "PROJ", "jira")).toEqual([]);
  });

  it("ignores a bare key with no phrase", () => {
    expect(parseBodyDependencies("see PROJ-7 for context", "PROJ", "jira")).toEqual([]);
  });

  it("does not swallow prose after the key", () => {
    expect(parseBodyDependencies("blocked by PROJ-3 see PROJ-4", "PROJ", "jira")).toEqual([
      { project: "PROJ", key: "PROJ-3" },
    ]);
  });

  it("does not pick up hash refs", () => {
    expect(parseBodyDependencies("blocked by #3", "PROJ", "jira")).toEqual([]);
  });
});

describe("dedupeRefs", () => {
  it("drops self-references and duplicates, preserving first-seen order", () => {
    const refs = [
      { project: "o/r", key: "5" },
      { project: "o/r", key: "1" },
      { project: "o/r", key: "2" },
      { project: "o/r", key: "1" },
    ];
    expect(dedupeRefs(refs, { project: "o/r", key: "5" })).toEqual([
      { project: "o/r", key: "1" },
      { project: "o/r", key: "2" },
    ]);
  });

  it("compares the project case-insensitively", () => {
    expect(dedupeRefs([{ project: "O/R", key: "5" }], { project: "o/r", key: "5" })).toEqual([]);
  });
});
