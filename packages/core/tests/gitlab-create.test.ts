import { describe, it, expect, vi, afterEach } from "vitest";
import { createGitLabIssue } from "../src/adapters/gitlab/create";
import type { CreateIssueParams } from "../src/adapters/types";

const token = async () => "tok";

function params(over: Partial<CreateIssueParams> = {}): CreateIssueParams {
  return { repo: { owner: "o", name: "r" }, title: "t", accountId: "acc-1", ...over };
}

function createdIssuePayload(over: Record<string, unknown> = {}) {
  return {
    id: 987,
    iid: 42,
    title: "t",
    description: "b",
    state: "opened",
    web_url: "https://gitlab.com/o/r/-/issues/42",
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    labels: ["bug"],
    assignees: [],
    author: { username: "cicababba" },
    references: { full: "o/r#42" },
    ...over,
  };
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

describe("createGitLabIssue", () => {
  it("POSTs only the title when body and labels are omitted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params(), token);

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("https://gitlab.com/api/v4/projects/o%2Fr/issues");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ title: "t" });
    expect(sent).not.toHaveProperty("description");
    expect(sent).not.toHaveProperty("labels");
    expect(sent).not.toHaveProperty("assignee_ids");
  });

  it("sends the body as description and labels comma-joined", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params({ body: "why", labels: ["bug", "web"] }), token);

    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: "t",
      description: "why",
      labels: "bug,web",
    });
  });

  it("encodes a nested-group project path", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params({ repo: { owner: "group/sub", name: "proj" } }), token);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/issues",
    );
  });

  it("resolves assignee usernames to ids before creating", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("/users?")
        ? jsonResponse(200, [{ id: 7, username: "CicaBabba" }])
        : jsonResponse(201, createdIssuePayload()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params({ assignees: ["cicababba"] }), token);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://gitlab.com/api/v4/users?username=cicababba",
    );
    const [, init] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "t", assignee_ids: [7] });
  });

  it("creates unassigned when the lookup matches nobody", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("/users?")
        ? jsonResponse(200, [{ id: 7, username: "someone-else" }])
        : jsonResponse(201, createdIssuePayload()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params({ assignees: ["cicababba"] }), token);

    const [, init] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("assignee_ids");
  });

  it("still creates the issue when the assignee lookup fails", async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).includes("/users?")
        ? jsonResponse(500, { message: "boom" })
        : jsonResponse(201, createdIssuePayload()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const issue = await createGitLabIssue(params({ assignees: ["cicababba"] }), token);

    const [, init] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "t" });
    expect(issue.id).toBe("gitlab:987");
  });

  it("returns the fully mapped Issue from the 201 payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(201, createdIssuePayload())),
    );

    const issue = await createGitLabIssue(params(), token);

    expect(issue).toEqual({
      id: "gitlab:987",
      kind: "issue",
      source: "gitlab",
      sourceRef: { project: "o/r", key: "42" },
      codeHost: "gitlab",
      accountId: "acc-1",
      repo: { owner: "o", name: "r" },
      key: "42",
      number: 42,
      title: "t",
      body: "b",
      labels: ["bug"],
      assignees: [],
      author: "cicababba",
      url: "https://gitlab.com/o/r/-/issues/42",
      createdAt: "2026-07-29T10:00:00Z",
      updatedAt: "2026-07-29T10:00:00Z",
      state: "open",
    });
  });

  it("respects a custom baseUrl (self-managed instance)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitLabIssue(params(), token, "https://git.corp/gitlab");

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://git.corp/gitlab/api/v4/projects/o%2Fr/issues",
    );
  });

  it("propagates an ApiError on 404 (unknown project)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { message: "404 Project Not Found" })),
    );
    await expect(createGitLabIssue(params(), token)).rejects.toMatchObject({ status: 404 });
  });
});
