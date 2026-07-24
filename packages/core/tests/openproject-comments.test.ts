import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchOpenProjectComments } from "../src/adapters/openproject/comments";

const token = async () => "tok";

function opIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "openproject:42",
    kind: "issue",
    source: "openproject",
    sourceRef: { project: "5", key: "42" },
    codeHost: "github",
    accountId: "a",
    key: "42",
    title: "t",
    labels: [],
    assignees: [],
    url: "https://op.example.com/work_packages/42",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function activity(over: Record<string, unknown> = {}) {
  return {
    comment: { raw: "a real comment" },
    createdAt: "2026-07-17T10:30:00.000+02:00",
    _links: { user: { title: "Ada" } },
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenProjectComments", () => {
  it("builds the activities URL from issue.key and maps comment author/body/timestamp", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { total: 1, count: 1, _embedded: { elements: [activity()] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchOpenProjectComments(opIssue(), token, "https://op.example.com");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://op.example.com/api/v3/work_packages/42/activities",
    );
    expect(comments).toEqual([
      { author: "Ada", body: "a real comment", createdAt: "2026-07-17T08:30:00.000Z" },
    ]);
  });

  it("skips field-change journal entries with an empty or absent comment", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        total: 3,
        count: 3,
        _embedded: {
          elements: [
            activity({ comment: { raw: "" } }),
            activity({ comment: null }),
            activity({ comment: { raw: "keep me" }, _links: { user: { title: "Bob" } } }),
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchOpenProjectComments(opIssue(), token, "https://op.example.com");
    expect(comments).toEqual([
      { author: "Bob", body: "keep me", createdAt: "2026-07-17T08:30:00.000Z" },
    ]);
  });

  it("falls back to unknown when the user link has no title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, { total: 1, count: 1, _embedded: { elements: [activity({ _links: {} })] } }),
    ));
    const comments = await fetchOpenProjectComments(opIssue(), token, "https://op.example.com");
    expect(comments[0].author).toBe("unknown");
  });

  it("paginates when total exceeds the page count", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const offset = new URL(String(url)).searchParams.get("offset");
      if (offset === "1") {
        return jsonResponse(200, { total: 150, count: 1, _embedded: { elements: [activity({ comment: { raw: "one" } })] } });
      }
      return jsonResponse(200, { total: 150, count: 1, _embedded: { elements: [activity({ comment: { raw: "two" } })] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchOpenProjectComments(opIssue(), token, "https://op.example.com");
    expect(comments.map((c) => c.body)).toEqual(["one", "two"]);
    expect(fetchMock.mock.calls[0][0]).toContain("offset=1");
    expect(fetchMock.mock.calls[1][0]).toContain("offset=2");
  });

  it("throws when no baseUrl is provided", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchOpenProjectComments(opIssue(), token)).rejects.toThrow(/baseUrl/);
  });
});
