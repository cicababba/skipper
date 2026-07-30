import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBitbucketIssueComments } from "../src/adapters/bitbucket/comments";
import type { Issue } from "@skipper/shared";

const token = async () => "tok";
const API = "https://api.bitbucket.org/2.0";

function issue(over: Partial<Issue> = {}): Issue {
  return {
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
    labels: [],
    assignees: [],
    url: "https://bitbucket.org/acme/rocket/issues/3",
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-17T10:30:00.000Z",
    state: "open",
    ...over,
  };
}

function comment(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    content: { raw: "first" },
    user: { nickname: "ada" },
    created_on: "2026-07-11T09:00:00.000000+00:00",
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

describe("fetchBitbucketIssueComments", () => {
  it("requests the issue's comments sorted by creation date", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { values: [comment()] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchBitbucketIssueComments(issue(), token);

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe(`${API}/repositories/acme/rocket/issues/3/comments`);
    expect(url.searchParams.get("sort")).toBe("created_on");
    expect(out).toEqual([
      { author: "ada", body: "first", createdAt: "2026-07-11T09:00:00.000Z" },
    ]);
  });

  it("drains pagination", async () => {
    const next = `${API}/repositories/acme/rocket/issues/3/comments?page=2`;
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url) === next
        ? jsonResponse(200, { values: [comment({ id: 2, content: { raw: "second" } })] })
        : jsonResponse(200, { values: [comment()], next }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchBitbucketIssueComments(issue(), token);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.map((c) => c.body)).toEqual(["first", "second"]);
  });

  it("skips deleted and empty comments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          values: [
            comment(),
            comment({ id: 2, deleted: true, content: { raw: "gone" } }),
            comment({ id: 3, content: { raw: "   " } }),
            comment({ id: 4, content: undefined }),
          ],
        }),
      ),
    );

    const out = await fetchBitbucketIssueComments(issue(), token);
    expect(out.map((c) => c.body)).toEqual(["first"]);
  });

  it("falls the author back through display_name, uuid, then unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          values: [
            comment({ id: 1, user: { display_name: "Ada L" } }),
            comment({ id: 2, user: { uuid: "{u}" } }),
            comment({ id: 3, user: undefined }),
          ],
        }),
      ),
    );

    const out = await fetchBitbucketIssueComments(issue(), token);
    expect(out.map((c) => c.author)).toEqual(["Ada L", "{u}", "unknown"]);
  });

  it("derives the repo from sourceRef when the issue carries none", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { values: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchBitbucketIssueComments(issue({ repo: undefined }), token);

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `${API}/repositories/acme/rocket/issues/3/comments`,
    );
  });
});
