import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { closeGitLabIssue } from "../src/adapters/gitlab/close";

const token = async () => "tok";

function glIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "gitlab:100",
    kind: "issue",
    source: "gitlab",
    sourceRef: { project: "group/project", key: "5" },
    codeHost: "gitlab",
    accountId: "a",
    repo: { owner: "group", name: "project" },
    key: "5",
    number: 5,
    title: "t",
    labels: [],
    assignees: [],
    url: "https://gitlab.com/group/project/-/issues/5",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closeGitLabIssue", () => {
  it("PUTs state_event close against the encoded project path and iid", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { state: "closed" }));
    vi.stubGlobal("fetch", fetchMock);

    await closeGitLabIssue(glIssue({ sourceRef: { project: "group/sub/project", key: "5" } }), token);

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/issues/5");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ state_event: "close" });
  });

  it("targets a self-hosted instance baseUrl", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await closeGitLabIssue(glIssue(), token, "https://git.corp/gitlab");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://git.corp/gitlab/api/v4/projects/group%2Fproject/issues/5",
    );
  });

  it("throws without a number (iid), before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(closeGitLabIssue(glIssue({ number: undefined }), token)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws without a project, before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      closeGitLabIssue(glIssue({ sourceRef: { project: "", key: "5" } }), token),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an ApiError on 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    await expect(closeGitLabIssue(glIssue(), token)).rejects.toMatchObject({ status: 500 });
  });
});
