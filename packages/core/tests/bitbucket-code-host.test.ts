import { describe, it, expect, vi, afterEach } from "vitest";
import { bitbucketCodeHost } from "../src/adapters/bitbucket/code-host";
import { ApiError } from "../src/adapters/types";

const repo = { owner: "acme", name: "demo" };
const token = async () => "tok";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bitbucketCodeHost.createPr", () => {
  const params = { title: "t", body: "b", head: "feature/issue-12", base: "main", draft: true };

  it("posts the source/destination branch shape without a draft field and maps the id", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        id: 7,
        links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/7" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await bitbucketCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "bitbucket:7",
      number: 7,
      url: "https://bitbucket.org/acme/demo/pull-requests/7",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/repositories/acme/demo/pullrequests");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      title: "t",
      description: "b",
      source: { branch: { name: "feature/issue-12" } },
      destination: { branch: { name: "main" } },
    });
    expect(sent.draft).toBeUndefined();
  });

  it("adopts the open PR for this source branch on a duplicate 400", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "already exists" } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [
            { id: 4, links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/4" } } },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const created = await bitbucketCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "bitbucket:4",
      number: 4,
      url: "https://bitbucket.org/acme/demo/pull-requests/4",
      existing: true,
    });
    const q = new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("q");
    expect(q).toContain('source.branch.name = "feature/issue-12"');
    expect(q).toContain('state = "OPEN"');
  });

  it("escapes quotes and backslashes in the branch name for the lookup query", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "already exists" } }))
      .mockResolvedValueOnce(jsonResponse(200, { values: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await bitbucketCodeHost
      .createPr(repo, { ...params, head: 'weird"\\branch' }, token)
      .catch(() => undefined);
    const q = new URL(String(fetchMock.mock.calls[1][0])).searchParams.get("q");
    expect(q).toContain('source.branch.name = "weird\\"\\\\branch"');
  });

  it("rethrows the original 400 when no open PR matches the source branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad request" } }))
      .mockResolvedValueOnce(jsonResponse(200, { values: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await bitbucketCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
  });

  it("rethrows a 500 without a lookup", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: { message: "boom" } }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await bitbucketCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("bitbucketCodeHost.fetchReviews", () => {
  function stub(participants: unknown, comments: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/comments")
          ? jsonResponse(200, comments)
          : jsonResponse(200, participants),
      ),
    );
  }

  it("prefers changes_requested over an approval and maps inline comments", async () => {
    stub(
      {
        participants: [
          { state: "changes_requested", approved: false, user: { nickname: "rev" } },
          { state: "approved", approved: true, user: { nickname: "other" } },
        ],
      },
      {
        values: [
          {
            id: 1,
            content: { raw: "fix the null check" },
            user: { nickname: "rev" },
            inline: { path: "src/a.ts", to: 10 },
            links: { html: { href: "https://bitbucket.org/acme/demo/pull-requests/4#c1" } },
            created_on: "2026-07-01T00:00:00Z",
          },
          { id: 2, deleted: true, content: { raw: "gone" }, user: { nickname: "rev" } },
          { id: 3, pending: true, content: { raw: "draft" }, user: { nickname: "rev" } },
        ],
      },
    );
    const result = await bitbucketCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("changes-requested");
    expect(result.comments).toEqual([
      {
        author: "rev",
        path: "src/a.ts",
        line: 10,
        body: "fix the null check",
        url: "https://bitbucket.org/acme/demo/pull-requests/4#c1",
        submittedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("maps a lone approval to approved", async () => {
    stub({ participants: [{ approved: true, user: { nickname: "rev" } }] }, { values: [] });
    const result = await bitbucketCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("approved");
    expect(result.comments).toEqual([]);
  });

  it("maps no votes to review-required", async () => {
    stub({ participants: [] }, { values: [] });
    const result = await bitbucketCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("review-required");
  });

  it("excludes the PR author's own approval by nickname and by uuid", async () => {
    stub(
      { participants: [{ approved: true, user: { nickname: "me", uuid: "{me-uuid}" } }] },
      { values: [] },
    );
    expect((await bitbucketCodeHost.fetchReviews(repo, 4, token, "me")).decision).toBe(
      "review-required",
    );
    expect((await bitbucketCodeHost.fetchReviews(repo, 4, token, "{me-uuid}")).decision).toBe(
      "review-required",
    );
  });
});

describe("bitbucketCodeHost.fetchCiStatus", () => {
  function statuses(states: string[]): Response {
    return jsonResponse(200, { values: states.map((state) => ({ state })) });
  }

  it("maps a lone SUCCESSFUL to passing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statuses(["SUCCESSFUL"])));
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBe("passing");
  });

  it("maps SUCCESSFUL + INPROGRESS to pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statuses(["SUCCESSFUL", "INPROGRESS"])));
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBe("pending");
  });

  it("maps any FAILED to failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statuses(["SUCCESSFUL", "FAILED"])));
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBe("failing");
  });

  it("maps STOPPED to failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statuses(["STOPPED"])));
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBe("failing");
  });

  it("returns undefined when there are no statuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => statuses([])));
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBeUndefined();
  });

  it("aggregates worst-wins across paginated status pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [{ state: "SUCCESSFUL" }],
          next: "https://api.bitbucket.org/2.0/next",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { values: [{ state: "FAILED" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await bitbucketCodeHost.fetchCiStatus(repo, "sha", token)).toBe("failing");
  });
});

describe("bitbucketCodeHost.fetchFailingChecks", () => {
  it("keeps FAILED/STOPPED statuses and falls back to the key for a name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, {
        values: [
          { key: "BUILD", name: "build", state: "FAILED", url: "u1", description: "compile error" },
          { key: "DEPLOY", state: "STOPPED", url: "u2" },
          { key: "TEST", name: "test", state: "SUCCESSFUL" },
        ],
      }),
    ));
    const checks = await bitbucketCodeHost.fetchFailingChecks(repo, "sha", token);
    expect(checks).toEqual([
      { name: "build", url: "u1", summary: "compile error" },
      { name: "DEPLOY", url: "u2", summary: undefined },
    ]);
  });
});

describe("bitbucketCodeHost conventions and identity helpers", () => {
  it("has no draft concept", () => {
    expect(bitbucketCodeHost.supportsDraft).toBe(false);
  });

  it("builds a plain reference for the tracker link", () => {
    expect(bitbucketCodeHost.linkIssueText("PROJ-123")).toBe("Refs PROJ-123");
  });

  it("uses the x-token-auth askpass username", () => {
    expect(bitbucketCodeHost.pushCredentials("tok")).toEqual({
      username: "x-token-auth",
      password: "tok",
    });
  });

  it("builds the https clone URL", () => {
    expect(bitbucketCodeHost.cloneUrl(repo)).toBe("https://bitbucket.org/acme/demo.git");
  });

  it("parses all four remote forms", () => {
    expect(bitbucketCodeHost.parseOrigin("https://bitbucket.org/acme/demo.git")).toEqual(repo);
    expect(bitbucketCodeHost.parseOrigin("https://user@bitbucket.org/acme/demo.git")).toEqual(repo);
    expect(bitbucketCodeHost.parseOrigin("git@bitbucket.org:acme/demo.git")).toEqual(repo);
    expect(bitbucketCodeHost.parseOrigin("ssh://git@bitbucket.org/acme/demo.git")).toEqual(repo);
  });

  it("returns null for a github remote and for a three-segment path", () => {
    expect(bitbucketCodeHost.parseOrigin("https://github.com/acme/demo.git")).toBeNull();
    expect(bitbucketCodeHost.parseOrigin("https://bitbucket.org/acme/demo/extra.git")).toBeNull();
  });
});
