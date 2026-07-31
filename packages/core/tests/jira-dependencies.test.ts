import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchJiraDependencies } from "../src/adapters/jira/dependencies";

function jiraIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "jira:10001",
    kind: "issue",
    source: "jira",
    sourceRef: { project: "PROJ", key: "PROJ-7" },
    codeHost: "github",
    accountId: "a",
    key: "PROJ-7",
    title: "t",
    labels: [],
    assignees: [],
    url: "https://acme.atlassian.net/browse/PROJ-7",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJiraDependencies", () => {
  it("returns the native issue links from the polled issue", async () => {
    const refs = await fetchJiraDependencies(
      jiraIssue({ blockedBy: [{ project: "PROJ", key: "PROJ-3" }], body: "blocked by PROJ-99" }),
    );
    // Native non-empty wins — the body's PROJ-99 is ignored.
    expect(refs).toEqual([{ project: "PROJ", key: "PROJ-3" }]);
  });

  it("falls back to body parsing when there are no native links", async () => {
    const refs = await fetchJiraDependencies(jiraIssue({ body: "blocked by PROJ-3 and OPS-9" }));
    expect(refs).toEqual([
      { project: "PROJ", key: "PROJ-3" },
      { project: "OPS", key: "OPS-9" },
    ]);
  });

  it("drops self-references and dedupes", async () => {
    const refs = await fetchJiraDependencies(
      jiraIssue({
        blockedBy: [
          { project: "PROJ", key: "PROJ-7" },
          { project: "PROJ", key: "PROJ-3" },
          { project: "PROJ", key: "PROJ-3" },
        ],
      }),
    );
    expect(refs).toEqual([{ project: "PROJ", key: "PROJ-3" }]);
  });

  it("returns nothing when neither links nor body carry a prerequisite", async () => {
    expect(await fetchJiraDependencies(jiraIssue({ body: "see PROJ-4" }))).toEqual([]);
  });

  it("never issues a request — the poll payload already carries the links", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fetchJiraDependencies(jiraIssue({ body: "blocked by PROJ-3" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
