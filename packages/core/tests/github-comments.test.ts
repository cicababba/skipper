import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchGitHubComments } from "../src/adapters/github/comments";

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

function commentPayload(login: string | null, body: string | null, createdAt: string) {
  return { user: login === null ? null : { login }, body, created_at: createdAt };
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

describe("fetchGitHubComments", () => {
  it("maps author, body and createdAt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, [
          commentPayload("alice", "first", "2026-07-01T01:00:00Z"),
          commentPayload("bob", "second", "2026-07-01T02:00:00Z"),
        ]),
      ),
    );
    const comments = await fetchGitHubComments(ghIssue(), token);
    expect(comments).toEqual([
      { author: "alice", body: "first", createdAt: "2026-07-01T01:00:00Z" },
      { author: "bob", body: "second", createdAt: "2026-07-01T02:00:00Z" },
    ]);
  });

  it("hits the issue comments endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await fetchGitHubComments(ghIssue(), token);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/repos/o/r/issues/5/comments");
  });

  it("follows Link pagination", async () => {
    const page2 = "https://api.github.com/repos/o/r/issues/5/comments?page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === page2) {
        return jsonResponse(200, [commentPayload("bob", "second", "2026-07-01T02:00:00Z")]);
      }
      return jsonResponse(200, [commentPayload("alice", "first", "2026-07-01T01:00:00Z")], {
        link: `<${page2}>; rel="next"`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchGitHubComments(ghIssue(), token);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("returns [] when repo is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchGitHubComments(ghIssue({ repo: undefined }), token);
    expect(comments).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when number is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchGitHubComments(ghIssue({ number: undefined }), token);
    expect(comments).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a null user to 'unknown'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, [commentPayload(null, "ghost note", "2026-07-01T01:00:00Z")])),
    );
    const comments = await fetchGitHubComments(ghIssue(), token);
    expect(comments[0].author).toBe("unknown");
  });

  it("propagates a 403 ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "rate limited" })));
    await expect(fetchGitHubComments(ghIssue(), token)).rejects.toMatchObject({ status: 403 });
  });
});
