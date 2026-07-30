import { describe, it, expect, vi, afterEach } from "vitest";
import { createBitbucketIssue } from "../src/adapters/bitbucket/create";
import type { CreateIssueParams } from "../src/adapters/types";

const token = async () => "tok";
const API = "https://api.bitbucket.org/2.0";

function params(over: Partial<CreateIssueParams> = {}): CreateIssueParams {
  return { repo: { owner: "acme", name: "rocket" }, title: "t", accountId: "acc-1", ...over };
}

function createdIssuePayload(over: Record<string, unknown> = {}) {
  return {
    id: 3,
    title: "t",
    content: { raw: "why" },
    state: "new",
    reporter: { nickname: "ada" },
    assignee: null,
    repository: { full_name: "acme/rocket" },
    links: { html: { href: "https://bitbucket.org/acme/rocket/issues/3/t" } },
    created_on: "2026-07-29T10:00:00.000000+00:00",
    updated_on: "2026-07-29T10:00:00.000000+00:00",
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

describe("createBitbucketIssue", () => {
  it("POSTs title and kind, omitting the content when there is no body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createBitbucketIssue(params(), token);

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(String(url)).toBe(`${API}/repositories/acme/rocket/issues`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ title: "t", kind: "task" });
  });

  it("sends the body as markdown content", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, createdIssuePayload()));
    vi.stubGlobal("fetch", fetchMock);

    await createBitbucketIssue(params({ body: "why" }), token);

    const [, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      title: "t",
      kind: "task",
      content: { raw: "why", markup: "markdown" },
    });
  });

  it("turns a 404 into an actionable disabled-tracker message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: { message: "Repository not found" } })),
    );

    await expect(createBitbucketIssue(params(), token)).rejects.toThrow(
      "the Bitbucket issue tracker is disabled for acme/rocket — enable it in the repository settings",
    );
  });

  it("propagates other envelope errors (403 without issue:write)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: { message: "Access denied" } })),
    );

    await expect(createBitbucketIssue(params(), token)).rejects.toMatchObject({ status: 403 });
  });

  it("returns the created issue fully mapped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(201, createdIssuePayload())),
    );

    const issue = await createBitbucketIssue(params({ body: "why" }), token);

    expect(issue).toEqual({
      id: "bitbucket:acme/rocket#3",
      kind: "issue",
      source: "bitbucket",
      sourceRef: { project: "acme/rocket", key: "3" },
      codeHost: "bitbucket",
      accountId: "acc-1",
      repo: { owner: "acme", name: "rocket" },
      key: "3",
      number: 3,
      title: "t",
      body: "why",
      labels: [],
      assignees: [],
      author: "ada",
      url: "https://bitbucket.org/acme/rocket/issues/3/t",
      createdAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:00:00.000Z",
      state: "open",
    });
  });

  it("qualifies the id from the request repo when the response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(201, createdIssuePayload({ repository: undefined }))),
    );

    const issue = await createBitbucketIssue(params(), token);

    expect(issue.id).toBe("bitbucket:acme/rocket#3");
    expect(issue.repo).toEqual({ owner: "acme", name: "rocket" });
  });
});
