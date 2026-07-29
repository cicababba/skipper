import { describe, it, expect, vi, afterEach } from "vitest";
import { createGitHubIssue } from "../src/adapters/github/create";
import type { CreateIssueParams } from "../src/adapters/types";

const token = async () => "tok";

function params(over: Partial<CreateIssueParams> = {}): CreateIssueParams {
  return { repo: { owner: "o", name: "r" }, title: "t", accountId: "acc-1", ...over };
}

function createdIssuePayload(over: Record<string, unknown> = {}) {
  return {
    id: 987,
    number: 42,
    title: "t",
    body: "b",
    state: "open",
    html_url: "https://github.com/o/r/issues/42",
    created_at: "2026-07-29T10:00:00Z",
    updated_at: "2026-07-29T10:00:00Z",
    labels: [{ name: "bug" }],
    assignees: [],
    user: { login: "cicababba" },
    repository_url: "https://api.github.com/repos/o/r",
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

describe("createGitHubIssue", () => {
  it("POSTs only the title when body and labels are omitted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubIssue(params(), token);

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe("https://api.github.com/repos/o/r/issues");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ title: "t" });
    expect(sent).not.toHaveProperty("body");
    expect(sent).not.toHaveProperty("labels");
    expect(sent).not.toHaveProperty("assignees");
  });

  // #136: self-assign rides the same optional-field treatment as body/labels.
  it("includes assignees when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubIssue(params({ assignees: ["cicababba"] }), token);

    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ title: "t", assignees: ["cicababba"] });
  });

  it("includes body and labels when provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubIssue(params({ body: "why", labels: ["bug", "web"] }), token);

    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: "t",
      body: "why",
      labels: ["bug", "web"],
    });
  });

  it("returns the fully mapped Issue from the 201 payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(201, createdIssuePayload())),
    );

    const issue = await createGitHubIssue(params(), token);

    expect(issue).toEqual({
      id: "github:987",
      kind: "issue",
      source: "github",
      sourceRef: { project: "o/r", key: "42" },
      codeHost: "github",
      accountId: "acc-1",
      repo: { owner: "o", name: "r" },
      key: "42",
      number: 42,
      title: "t",
      body: "b",
      labels: ["bug"],
      assignees: [],
      author: "cicababba",
      url: "https://github.com/o/r/issues/42",
      createdAt: "2026-07-29T10:00:00Z",
      updatedAt: "2026-07-29T10:00:00Z",
      state: "open",
    });
  });

  it("respects a custom baseUrl (GitHub Enterprise)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createGitHubIssue(params(), token, "https://ghe.corp/api/v3");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://ghe.corp/api/v3/repos/o/r/issues");
  });

  it("propagates an ApiError on 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { message: "boom" })),
    );
    await expect(createGitHubIssue(params(), token)).rejects.toMatchObject({ status: 500 });
  });

  it("propagates a 403 when the App lacks Issues: write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "Resource not accessible by integration" })),
    );
    await expect(createGitHubIssue(params(), token)).rejects.toMatchObject({ status: 403 });
  });
});
