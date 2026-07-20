import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchGitLabComments } from "../src/adapters/gitlab/comments";

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

function notePayload(username: string, body: string, createdAt: string, system = false) {
  return { author: { username }, body, created_at: createdAt, system };
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

describe("fetchGitLabComments", () => {
  it("skips system notes and maps the rest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, [
          notePayload("alice", "real comment", "2026-07-01T01:00:00Z"),
          notePayload("bot", "changed the description", "2026-07-01T01:30:00Z", true),
          notePayload("bob", "another", "2026-07-01T02:00:00Z"),
        ]),
      ),
    );
    const comments = await fetchGitLabComments(glIssue(), token);
    expect(comments).toEqual([
      { author: "alice", body: "real comment", createdAt: "2026-07-01T01:00:00Z" },
      { author: "bob", body: "another", createdAt: "2026-07-01T02:00:00Z" },
    ]);
  });

  it("URL-encodes a nested project path and sorts ascending by created", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await fetchGitLabComments(glIssue({ sourceRef: { project: "group/sub/project", key: "5" } }), token);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/projects/group%2Fsub%2Fproject/issues/5/notes");
    expect(url).toContain("sort=asc");
    expect(url).toContain("order_by=created_at");
  });

  it("follows Link pagination", async () => {
    const page2 = "https://gitlab.com/api/v4/projects/group%2Fproject/issues/5/notes?page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === page2) {
        return jsonResponse(200, [notePayload("bob", "second", "2026-07-01T02:00:00Z")]);
      }
      return jsonResponse(200, [notePayload("alice", "first", "2026-07-01T01:00:00Z")], {
        link: `<${page2}>; rel="next"`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchGitLabComments(glIssue(), token);
    expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("returns [] when number is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchGitLabComments(glIssue({ number: undefined }), token);
    expect(comments).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
