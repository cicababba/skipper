import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { closeGitHubIssue } from "../src/adapters/github/close";

const token = async () => "tok";

function ghIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "github:100",
    kind: "issue",
    source: "github",
    sourceRef: { project: "o/r", key: "5" },
    codeHost: "github",
    accountId: "a",
    repo: { owner: "o", name: "r" },
    key: "5",
    number: 5,
    title: "t",
    labels: [],
    assignees: [],
    url: "https://github.com/o/r/issues/5",
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

describe("closeGitHubIssue", () => {
  it("PATCHes the issue closed as completed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 1, state: "closed" }));
    vi.stubGlobal("fetch", fetchMock);

    await closeGitHubIssue(ghIssue(), token);

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/o/r/issues/5");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ state: "closed", state_reason: "completed" });
  });

  it("respects a custom baseUrl (GitHub Enterprise)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await closeGitHubIssue(ghIssue(), token, "https://ghe.corp/api/v3");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://ghe.corp/api/v3/repos/o/r/issues/5");
  });

  it("throws without a repo, before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(closeGitHubIssue(ghIssue({ repo: undefined }), token)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws without a number, before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(closeGitHubIssue(ghIssue({ number: undefined }), token)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an ApiError on 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    await expect(closeGitHubIssue(ghIssue(), token)).rejects.toMatchObject({ status: 500 });
  });

  it("propagates a 403 when the App lacks Issues: write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "Resource not accessible by integration" })),
    );
    await expect(closeGitHubIssue(ghIssue(), token)).rejects.toMatchObject({ status: 403 });
  });
});
