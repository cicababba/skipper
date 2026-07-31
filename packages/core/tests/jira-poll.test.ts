import { describe, it, expect, vi, afterEach } from "vitest";
import { pollJiraAccount } from "../src/adapters/jira/poll";
import { ApiError } from "../src/adapters/types";

const token = async () => "tok";
// issuelinks joined the field list in #299 — it carries the native "is blocked by"
// links, so dependencies need no extra request.
const FIELDS =
  "summary,description,labels,components,assignee,reporter,status,project,created,updated,issuelinks";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function urlOf(mock: ReturnType<typeof vi.fn>, call: number): URL {
  return new URL(String(mock.mock.calls[call][0]));
}

function adfDoc(value: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
  };
}

function cloudIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "10001",
    key: "PROJ-123",
    fields: {
      summary: "Fix the thing",
      description: adfDoc("body text"),
      labels: ["backend"],
      components: [{ name: "api" }],
      assignee: { key: "jdoe", name: "jdoe" },
      reporter: { accountId: "acc-1" },
      status: { statusCategory: { key: "indeterminate" } },
      project: { key: "PROJ" },
      created: "2026-07-10T09:00:00.000+0200",
      updated: "2026-07-17T10:30:00.000+0200",
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pollJiraAccount — Cloud full walk", () => {
  const base = { accountId: "acct", getToken: token, baseUrl: "https://acme.atlassian.net", cloudId: "cid" };

  it("walks nextPageToken pagination and returns a full-walk result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { issues: [cloudIssue()], nextPageToken: "tok2" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issues: [
            {
              ...cloudIssue(),
              id: "10002",
              key: "PROJ-124",
              fields: { ...cloudIssue().fields, updated: "2026-07-15T08:00:00.000Z" },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollJiraAccount(base);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = urlOf(fetchMock, 0);
    expect(first.origin + first.pathname).toBe(
      "https://api.atlassian.com/ex/jira/cid/rest/api/3/search/jql",
    );
    expect(first.searchParams.get("jql")).toBe(
      "assignee = currentUser() AND resolution = EMPTY ORDER BY updated DESC",
    );
    expect(first.searchParams.get("fields")).toBe(FIELDS);
    expect(first.searchParams.get("maxResults")).toBe("100");
    expect(urlOf(fetchMock, 1).searchParams.get("nextPageToken")).toBe("tok2");

    expect(result.mode).toBe("full");
    expect(result.pullRequests).toEqual([]);
    expect(result.issues).toHaveLength(2);
    // Cursor = max fields.updated (10001, +0200 → 08:30Z) normalized to UTC.
    expect(result.cursor.issues.updatedAfter).toBe("2026-07-17T08:30:00.000Z");
  });

  it("maps issue fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { issues: [cloudIssue()] })));
    const { issues } = await pollJiraAccount(base);
    const issue = issues[0];
    expect(issue.id).toBe("jira:10001");
    expect(issue.key).toBe("PROJ-123");
    expect(issue.sourceRef).toEqual({ project: "PROJ", key: "PROJ-123" });
    expect(issue.number).toBeUndefined();
    expect(issue.repo).toBeUndefined();
    expect(issue.codeHost).toBe("github");
    expect(issue.source).toBe("jira");
    expect(issue.labels).toEqual(["backend", "api"]);
    expect(issue.assignees).toEqual(["jdoe"]); // accountId absent → key fallback
    expect(issue.author).toBe("acc-1");
    expect(issue.body).toBe("body text");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/PROJ-123");
    expect(issue.createdAt).toBe("2026-07-10T07:00:00.000Z");
    expect(issue.updatedAt).toBe("2026-07-17T08:30:00.000Z");
    expect(issue.state).toBe("open");
  });

  it("marks done statusCategory as closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          issues: [cloudIssue({ status: { statusCategory: { key: "done" } } })],
        }),
      ),
    );
    const { issues } = await pollJiraAccount(base);
    expect(issues[0].state).toBe("closed");
  });
});

describe("pollJiraAccount — Cloud delta", () => {
  const base = { accountId: "acct", getToken: token, baseUrl: "https://acme.atlassian.net", cloudId: "cid" };

  it("uses a relative -Nm window (10 min + 120s overlap → 12m) and drops resolution", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cursor = {
      version: 1 as const,
      issues: { updatedAfter: new Date(now.getTime() - 10 * 60_000).toISOString() },
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, { issues: [cloudIssue()] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollJiraAccount({ ...base, cursor });
    expect(result.mode).toBe("delta");
    expect(urlOf(fetchMock, 0).searchParams.get("jql")).toBe(
      "assignee = currentUser() AND updated >= -12m ORDER BY updated DESC",
    );
  });

  it("keeps the previous updatedAfter on an empty delta", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const prev = new Date(now.getTime() - 5 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { issues: [] })));

    const result = await pollJiraAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: prev } },
    });
    expect(result.cursor.issues.updatedAfter).toBe(prev);
  });

  it("full-walks a stale cursor (30 days)", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const stale = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    const fetchMock = vi.fn(async () => jsonResponse(200, { issues: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollJiraAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: stale } },
    });
    expect(result.mode).toBe("full");
    expect(urlOf(fetchMock, 0).searchParams.get("jql")).toContain("resolution = EMPTY");
  });

  it("full-walks a malformed cursor object", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { issues: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollJiraAccount({
      ...base,
      cursor: { version: 2, issues: {} } as never,
    });
    expect(result.mode).toBe("full");
  });

  it("recovers a 400-rejected cursor with a full walk", async () => {
    const now = new Date("2026-07-17T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { message: "bad jql" }))
      .mockResolvedValueOnce(jsonResponse(200, { issues: [cloudIssue()] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollJiraAccount({
      ...base,
      cursor: { version: 1, issues: { updatedAfter: new Date(now.getTime() - 60_000).toISOString() } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe("full");
    expect(urlOf(fetchMock, 1).searchParams.get("jql")).toContain("resolution = EMPTY");
  });

  it("rethrows a 400 without a cursor in play", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { message: "bad jql" })));
    const err = await pollJiraAccount(base).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it("surfaces retry-after on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { message: "slow" }, { "retry-after": "30" })),
    );
    const err = await pollJiraAccount(base).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
  });
});

describe("pollJiraAccount — Data Center", () => {
  const base = { accountId: "acct", getToken: token, baseUrl: "https://jira.corp" };

  it("walks startAt/total pagination and passes string descriptions through", async () => {
    const dcIssue = (id: string, key: string, updated: string) => ({
      id,
      key,
      fields: {
        summary: "DC issue",
        description: "plain text desc",
        labels: [],
        components: [],
        assignee: { key: "dcuser", name: "dcuser" },
        reporter: { name: "reporter" },
        status: { statusCategory: { key: "new" } },
        project: { key: "DC" },
        created: "2026-07-10T09:00:00.000Z",
        updated,
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issues: [dcIssue("1", "DC-1", "2026-07-16T00:00:00.000Z")],
          startAt: 0,
          total: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          issues: [dcIssue("2", "DC-2", "2026-07-15T00:00:00.000Z")],
          startAt: 1,
          total: 2,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollJiraAccount(base);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = urlOf(fetchMock, 0);
    expect(first.origin + first.pathname).toBe("https://jira.corp/rest/api/2/search");
    expect(first.searchParams.get("startAt")).toBe("0");
    expect(first.searchParams.get("maxResults")).toBe("50");
    expect(urlOf(fetchMock, 1).searchParams.get("startAt")).toBe("1");
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0].body).toBe("plain text desc");
    expect(result.issues[0].assignees).toEqual(["dcuser"]);
    expect(result.issues[0].url).toBe("https://jira.corp/browse/DC-1");
  });
});
