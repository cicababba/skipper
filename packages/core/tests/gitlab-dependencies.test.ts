import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchGitLabDependencies } from "../src/adapters/gitlab/dependencies";

function glIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "gitlab:100",
    kind: "issue",
    source: "gitlab",
    sourceRef: { project: "group/app", key: "5" },
    codeHost: "gitlab",
    accountId: "a",
    repo: { owner: "group", name: "app" },
    key: "5",
    number: 5,
    title: "t",
    labels: [],
    assignees: [],
    url: "https://gitlab.com/group/app/-/issues/5",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGitLabDependencies", () => {
  it("parses prerequisites from the body, own project and cross-project", async () => {
    const refs = await fetchGitLabDependencies(
      glIssue({ body: "blocked by #3 and group/other#8" }),
    );
    expect(refs).toEqual([
      { project: "group/app", key: "3" },
      { project: "group/other", key: "8" },
    ]);
  });

  it("drops self-references and dedupes", async () => {
    const refs = await fetchGitLabDependencies(glIssue({ body: "blocked by #5, #3 and #3" }));
    expect(refs).toEqual([{ project: "group/app", key: "3" }]);
  });

  it("returns nothing without the phrase", async () => {
    expect(await fetchGitLabDependencies(glIssue({ body: "see #3" }))).toEqual([]);
  });

  it("issues no request — native issue links are a GitLab Premium feature", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fetchGitLabDependencies(glIssue({ body: "blocked by #3" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
