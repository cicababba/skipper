import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchBitbucketDependencies } from "../src/adapters/bitbucket/dependencies";

function bbIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "bitbucket:100",
    kind: "issue",
    source: "bitbucket",
    sourceRef: { project: "acme/app", key: "5" },
    codeHost: "bitbucket",
    accountId: "a",
    repo: { owner: "acme", name: "app" },
    key: "5",
    number: 5,
    title: "t",
    labels: [],
    assignees: [],
    url: "https://bitbucket.org/acme/app/issues/5",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchBitbucketDependencies", () => {
  it("parses prerequisites from the body, own project and cross-project", async () => {
    const refs = await fetchBitbucketDependencies(
      bbIssue({ body: "depends on #3 and acme/other#8" }),
    );
    expect(refs).toEqual([
      { project: "acme/app", key: "3" },
      { project: "acme/other", key: "8" },
    ]);
  });

  it("drops self-references and dedupes", async () => {
    const refs = await fetchBitbucketDependencies(bbIssue({ body: "blocked by #5, #3 and #3" }));
    expect(refs).toEqual([{ project: "acme/app", key: "3" }]);
  });

  it("returns nothing without the phrase", async () => {
    expect(await fetchBitbucketDependencies(bbIssue({ body: "see #3" }))).toEqual([]);
  });

  it("issues no request — Bitbucket Cloud has no issue-link API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fetchBitbucketDependencies(bbIssue({ body: "blocked by #3" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
