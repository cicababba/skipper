import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import { fetchJiraComments } from "../src/adapters/jira/comments";

const token = async () => "tok";

function jiraIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "jira:100",
    kind: "issue",
    source: "jira",
    sourceRef: { project: "PROJ", key: "PROJ-1" },
    codeHost: "github",
    accountId: "a",
    key: "PROJ-1",
    title: "t",
    labels: [],
    assignees: [],
    url: "https://acme.atlassian.net/browse/PROJ-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...over,
  };
}

function adfDoc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJiraComments — Cloud", () => {
  it("routes via api.atlassian.com/rest/api/3, converts ADF, normalizes timestamps", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        comments: [
          {
            author: { displayName: "Alice", accountId: "acc-1" },
            body: adfDoc("hello from cloud"),
            created: "2026-07-17T10:30:00.000+0200",
          },
        ],
        startAt: 0,
        maxResults: 100,
        total: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchJiraComments(jiraIssue(), token, undefined, "cloud-123");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/PROJ-1/comment",
    );
    expect(comments).toEqual([
      { author: "Alice", body: "hello from cloud", createdAt: "2026-07-17T08:30:00.000Z" },
    ]);
  });

  it("paginates via startAt/total", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const startAt = new URL(String(url)).searchParams.get("startAt");
      if (startAt === "0") {
        return jsonResponse(200, {
          comments: [{ author: { displayName: "A" }, body: adfDoc("one"), created: "2026-07-01T01:00:00.000Z" }],
          total: 2,
        });
      }
      return jsonResponse(200, {
        comments: [{ author: { displayName: "B" }, body: adfDoc("two"), created: "2026-07-01T02:00:00.000Z" }],
        total: 2,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const comments = await fetchJiraComments(jiraIssue(), token, undefined, "cloud-123");
    expect(comments.map((c) => c.body)).toEqual(["one", "two"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchJiraComments — Data Center", () => {
  it("routes via <baseUrl>/rest/api/2 with a plain-string body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        comments: [
          { author: { name: "dc-user" }, body: "plain text comment", created: "2026-07-01T01:00:00.000+0000" },
        ],
        total: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchJiraComments(jiraIssue(), token, "https://jira.corp");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "https://jira.corp/rest/api/2/issue/PROJ-1/comment",
    );
    expect(comments).toEqual([
      { author: "dc-user", body: "plain text comment", createdAt: "2026-07-01T01:00:00.000Z" },
    ]);
  });
});

describe("fetchJiraComments — target resolution", () => {
  it("throws when neither cloudId nor baseUrl is provided", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchJiraComments(jiraIssue(), token)).rejects.toThrow(/cloudId|baseUrl/);
  });
});
