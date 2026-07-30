import { describe, it, expect, vi, afterEach } from "vitest";
import { pollBitbucketAccount } from "../src/adapters/bitbucket/poll";
import type { BitbucketAccountCursor } from "../src/adapters/bitbucket/types";

const ACCOUNT = "bitbucket:me";
const token = async () => "tok";
const API = "https://api.bitbucket.org/2.0";
const ME = "{me-uuid}";

function issuePayload(over: Record<string, unknown> = {}) {
  return {
    id: 3,
    title: "Fix the thing",
    content: { raw: "body" },
    state: "new",
    reporter: { nickname: "bob" },
    assignee: { nickname: "ada", uuid: ME },
    repository: { full_name: "acme/rocket" },
    links: { html: { href: "https://bitbucket.org/acme/rocket/issues/3" } },
    created_on: "2026-07-10T09:00:00.000000+00:00",
    updated_on: "2026-07-17T10:30:00.000000+00:00",
    ...over,
  };
}

function prPayload(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "Add the thing",
    description: "why",
    state: "OPEN",
    author: { nickname: "ada", uuid: ME },
    source: {
      branch: { name: "feature/x" },
      commit: { hash: "deadbeef" },
      repository: { full_name: "acme/rocket" },
    },
    destination: { branch: { name: "main" }, repository: { full_name: "acme/rocket" } },
    links: { html: { href: "https://bitbucket.org/acme/rocket/pull-requests/7" } },
    created_on: "2026-07-10T09:00:00.000000+00:00",
    updated_on: "2026-07-17T10:30:00.000000+00:00",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface StubData {
  prs?: unknown[];
  repos?: string[];
  issues?: unknown[];
  /** Extra routes, matched on the full URL, taking precedence over the defaults. */
  routes?: Array<[test: (url: string) => boolean, response: () => Response]>;
}

/** Routes the four stages of a poll: /user, the PR stream, the repo list and the
 *  per-repo issue walk. */
function stubFetch(data: StubData = {}) {
  const repos = data.repos ?? ["acme/rocket"];
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    for (const [test, response] of data.routes ?? []) {
      if (test(url)) return response();
    }
    if (url === `${API}/user`) return jsonResponse(200, { uuid: ME, nickname: "ada" });
    if (url.includes("/pullrequests/")) return jsonResponse(200, { values: data.prs ?? [] });
    if (url.includes(`${API}/repositories?`)) {
      return jsonResponse(200, { values: repos.map((full_name) => ({ full_name })) });
    }
    if (url.includes("/issues")) return jsonResponse(200, { values: data.issues ?? [] });
    throw new Error(`unrouted request: ${url}`);
  });
}

function urlsMatching(mock: ReturnType<typeof vi.fn>, needle: string): string[] {
  return mock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(needle));
}

function qOf(url: string): string {
  return new URL(url).searchParams.get("q") ?? "";
}

const base = { accountId: ACCOUNT, getToken: token };

function cursor(over: Partial<BitbucketAccountCursor> = {}): BitbucketAccountCursor {
  return {
    version: 1,
    issues: { updatedAfter: "2026-07-16T00:00:00.000Z" },
    pullRequests: { updatedAfter: "2026-07-16T00:00:00.000Z" },
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollBitbucketAccount — full walk", () => {
  it("resolves the account uuid, then walks open PRs and issue-enabled repos", async () => {
    const fetchMock = stubFetch({ prs: [prPayload()], issues: [issuePayload()] });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base });

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${API}/user`);

    const prUrl = urlsMatching(fetchMock, "/pullrequests/")[0];
    expect(prUrl).toContain(`${API}/pullrequests/${encodeURIComponent(ME)}`);
    expect(qOf(prUrl)).toBe('state = "OPEN"');

    const repoUrl = urlsMatching(fetchMock, `${API}/repositories?`)[0];
    expect(qOf(repoUrl)).toBe("has_issues = true");
    expect(new URL(repoUrl).searchParams.get("role")).toBe("member");

    const issueUrl = urlsMatching(fetchMock, "/rocket/issues")[0];
    expect(qOf(issueUrl)).toBe('(state = "new" OR state = "open" OR state = "on hold")');

    expect(res.mode).toBe("full");
    expect(res.issues.map((i) => i.id)).toEqual(["bitbucket:acme/rocket#3"]);
    expect(res.pullRequests.map((p) => p.id)).toEqual(["bitbucket:acme/rocket!7"]);
    expect(res.rateLimit).toBeUndefined();
  });

  it("keeps only issues assigned to the polling account", async () => {
    const fetchMock = stubFetch({
      issues: [
        issuePayload(),
        issuePayload({ id: 4, assignee: { nickname: "bob", uuid: "{other}" } }),
        issuePayload({ id: 5, assignee: null }),
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base });

    expect(res.issues.map((i) => i.number)).toEqual([3]);
  });

  it("advances the issue cursor even when nothing is assigned to the account", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        issues: [issuePayload({ assignee: { uuid: "{other}" }, updated_on: "2026-07-17T10:30:00+00:00" })],
      }),
    );

    const res = await pollBitbucketAccount({ ...base });

    expect(res.issues).toEqual([]);
    // max(updated_on) − 60s overlap
    expect(res.cursor.issues.updatedAfter).toBe("2026-07-17T10:29:00.000Z");
  });

  it("drains pagination on both streams", async () => {
    const prNext = `${API}/pullrequests/x?page=2`;
    const issueNext = `${API}/repositories/acme/rocket/issues?page=2`;
    const fetchMock = stubFetch({
      routes: [
        [(u) => u === prNext, () => jsonResponse(200, { values: [prPayload({ id: 8 })] })],
        [(u) => u === issueNext, () => jsonResponse(200, { values: [issuePayload({ id: 4 })] })],
        [
          (u) => u.includes("/pullrequests/"),
          () => jsonResponse(200, { values: [prPayload()], next: prNext }),
        ],
        [
          (u) => u.includes("/rocket/issues"),
          () => jsonResponse(200, { values: [issuePayload()], next: issueNext }),
        ],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base });

    expect(res.pullRequests.map((p) => p.number)).toEqual([7, 8]);
    expect(res.issues.map((i) => i.number)).toEqual([3, 4]);
  });

  it("caps the repo walk and warns through onProgress", async () => {
    const repos = Array.from({ length: 55 }, (_, i) => `acme/repo-${i}`);
    const fetchMock = stubFetch({ repos });
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    await pollBitbucketAccount({ ...base, onProgress });

    expect(urlsMatching(fetchMock, "/issues")).toHaveLength(50);
    expect(onProgress).toHaveBeenCalledWith("issue walk capped at 50 of 55 repos with issues");
  });
});

describe("pollBitbucketAccount — delta", () => {
  it("scopes both streams by updated_on and enumerates every PR state", async () => {
    const fetchMock = stubFetch({ prs: [prPayload()], issues: [issuePayload()] });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base, cursor: cursor() });

    const prQ = qOf(urlsMatching(fetchMock, "/pullrequests/")[0]);
    expect(prQ).toBe(
      'updated_on > "2026-07-16T00:00:00.000Z" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
    );
    // No state filter on issues, so closures arrive and reconcile can close the item.
    expect(qOf(urlsMatching(fetchMock, "/rocket/issues")[0])).toBe(
      'updated_on > "2026-07-16T00:00:00.000Z"',
    );
    expect(res.mode).toBe("delta");
  });

  it("keeps the previous cursor when the delta comes back empty", async () => {
    vi.stubGlobal("fetch", stubFetch());

    const res = await pollBitbucketAccount({ ...base, cursor: cursor() });

    expect(res.cursor.issues.updatedAfter).toBe("2026-07-16T00:00:00.000Z");
    expect(res.cursor.pullRequests.updatedAfter).toBe("2026-07-16T00:00:00.000Z");
    expect(res.cursor.version).toBe(1);
  });

  it("falls back to a full walk when Bitbucket rejects the query with 400", async () => {
    let rejected = false;
    const fetchMock = stubFetch({
      routes: [
        [
          (u) => u.includes("/pullrequests/") && !rejected,
          () => {
            rejected = true;
            return jsonResponse(400, { error: { message: "bad query" } });
          },
        ],
      ],
      prs: [prPayload()],
    });
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const res = await pollBitbucketAccount({ ...base, cursor: cursor(), onProgress });

    expect(onProgress).toHaveBeenCalledWith("cursor rejected (400) — falling back to full walk");
    expect(res.mode).toBe("full");
    expect(qOf(urlsMatching(fetchMock, "/pullrequests/").at(-1)!)).toBe('state = "OPEN"');
  });

  it("ignores a cursor that isn't the exact v1 shape", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({
      ...base,
      cursor: { version: 2 } as unknown as BitbucketAccountCursor,
    });

    expect(res.mode).toBe("full");
    expect(qOf(urlsMatching(fetchMock, "/pullrequests/")[0])).toBe('state = "OPEN"');
  });
});

describe("pollBitbucketAccount — deep hydration", () => {
  const deepHydrate = [{ owner: "acme", name: "rocket", number: 7 }];

  it("merges review decision and CI onto the streamed PR, keeping the stream id", async () => {
    const fetchMock = stubFetch({
      prs: [prPayload()],
      routes: [
        [
          (u) => u.endsWith("/pullrequests/7"),
          () =>
            jsonResponse(200, {
              ...prPayload(),
              participants: [{ user: { nickname: "rev" }, approved: true }],
            }),
        ],
        [
          (u) => u.includes("/commit/deadbeef/statuses"),
          () => jsonResponse(200, { values: [{ key: "ci", state: "SUCCESSFUL" }] }),
        ],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base, deepHydrate });

    expect(res.pullRequests).toHaveLength(1);
    expect(res.pullRequests[0]).toMatchObject({
      id: "bitbucket:acme/rocket!7",
      reviewDecision: "approved",
      ciStatus: "passing",
    });
  });

  it("appends a tracked PR the stream did not return", async () => {
    const fetchMock = stubFetch({
      routes: [
        [
          (u) => u.endsWith("/pullrequests/7"),
          () => jsonResponse(200, { ...prPayload(), participants: [] }),
        ],
        [(u) => u.includes("/statuses"), () => jsonResponse(200, { values: [] })],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base, deepHydrate });

    expect(res.pullRequests.map((p) => p.number)).toEqual([7]);
    expect(res.pullRequests[0].reviewDecision).toBe("review-required");
  });

  it("skips the review/CI calls for a PR that is no longer open", async () => {
    const fetchMock = stubFetch({
      routes: [
        [
          (u) => u.endsWith("/pullrequests/7"),
          () => jsonResponse(200, prPayload({ state: "MERGED" })),
        ],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await pollBitbucketAccount({ ...base, deepHydrate });

    expect(res.pullRequests[0]).toMatchObject({ state: "closed", merged: true });
    expect(urlsMatching(fetchMock, "/statuses")).toHaveLength(0);
  });

  it("survives a hydration failure without failing the poll", async () => {
    const fetchMock = stubFetch({
      issues: [issuePayload()],
      routes: [
        [(u) => u.endsWith("/pullrequests/7"), () => jsonResponse(500, { error: { message: "boom" } })],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const res = await pollBitbucketAccount({ ...base, deepHydrate, onProgress });

    expect(res.issues).toHaveLength(1);
    expect(res.pullRequests).toEqual([]);
    expect(onProgress).toHaveBeenCalledWith(
      expect.stringContaining("deep hydration failed for acme/rocket!7"),
    );
  });

  it("caps hydration at 20 tracked PRs and warns", async () => {
    const targets = Array.from({ length: 25 }, (_, i) => ({
      owner: "acme",
      name: "rocket",
      number: i + 1,
    }));
    const fetchMock = stubFetch({
      routes: [
        [
          (u) => /\/pullrequests\/\d+$/.test(u),
          () => jsonResponse(200, { ...prPayload(), participants: [] }),
        ],
        [(u) => u.includes("/statuses"), () => jsonResponse(200, { values: [] })],
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    await pollBitbucketAccount({ ...base, deepHydrate: targets, onProgress });

    expect(onProgress).toHaveBeenCalledWith("deep hydration capped at 20 of 25 tracked PRs");
    // Each hydrated PR is fetched twice (detail, then participants) — count targets.
    const hydrated = new Set(
      fetchMock.mock.calls
        .map((c) => /\/pullrequests\/(\d+)$/.exec(String(c[0])))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1]),
    );
    expect(hydrated.size).toBe(20);
  });
});
