import { describe, it, expect, vi, afterEach } from "vitest";
import { pollGitHubAccount } from "../src/adapters/github/poll";
import { emptyGitHubCursor, type GitHubAccountCursor } from "../src/adapters/github/types";

const ACCOUNT = "45292355";
const token = async () => "tok";

interface StubIssue {
  id: number;
  number: number;
  title: string;
  state?: "open" | "closed";
  updated_at?: string;
  pull_request?: { merged_at: string | null };
  draft?: boolean;
}

function issuePayload(over: StubIssue) {
  return {
    id: over.id,
    number: over.number,
    title: over.title,
    body: "b",
    state: over.state ?? "open",
    html_url: `https://github.com/o/r/issues/${over.number}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-07-10T10:00:00Z",
    labels: [{ name: "bug" }],
    assignees: [{ login: "cicababba" }],
    user: { login: "cicababba" },
    repository_url: "https://api.github.com/repos/o/r",
    ...(over.pull_request ? { pull_request: over.pull_request, draft: over.draft ?? false } : {}),
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollGitHubAccount", () => {
  it("full walk follows pagination and produces a cursor with overlap", async () => {
    const page2 = "https://api.github.com/issues?filter=assigned&page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === page2) {
        return jsonResponse(200, [issuePayload({ id: 2, number: 2, title: "two", updated_at: "2026-07-10T12:00:00Z" })]);
      }
      if (u.includes("filter=assigned")) {
        expect(u).toContain("state=open");
        expect(u).not.toContain("since=");
        return jsonResponse(200, [issuePayload({ id: 1, number: 1, title: "one" })], {
          etag: 'W/"page1"',
          link: `<${page2}>; rel="next"`,
        });
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.mode).toBe("full");
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(result.issues[0]).toMatchObject({
      id: "github:1",
      platform: "github",
      accountId: ACCOUNT,
      repo: { owner: "o", name: "r" },
      kind: "issue",
      labels: ["bug"],
      author: "cicababba",
    });
    const expectedSince = new Date(Date.parse("2026-07-10T12:00:00Z") - 60_000).toISOString();
    expect(result.cursor.assigned.since).toBe(expectedSince);
    const etagUrls = Object.keys(result.cursor.assigned.etags);
    expect(etagUrls).toHaveLength(1);
    expect(etagUrls[0]).toContain("filter=assigned");
  });

  it("delta poll sends since + state=all and reports mode delta", async () => {
    const cursor: GitHubAccountCursor = {
      ...emptyGitHubCursor(),
      assigned: { since: "2026-07-09T00:00:00Z", etags: {} },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("filter=assigned")) {
        expect(u).toContain("state=all");
        expect(u).toContain(`since=${encodeURIComponent("2026-07-09T00:00:00Z")}`);
        return jsonResponse(200, [issuePayload({ id: 9, number: 9, title: "closed one", state: "closed" })]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token, cursor });
    expect(result.mode).toBe("delta");
    expect(result.issues[0]).toMatchObject({ number: 9, state: "closed" });
  });

  it("304 on both page-1 urls returns empty result with unchanged cursor", async () => {
    const cursor = emptyGitHubCursor();
    cursor.assigned = { since: "2026-07-09T00:00:00Z", etags: {} };
    cursor.created = { since: "2026-07-08T00:00:00Z", etags: {} };
    // Seed the etags keyed by the exact page-1 URLs the poll will build.
    const seed = async () => {
      const fetchSeed = vi.fn(async (url: string | URL) => {
        cursor[String(url).includes("filter=assigned") ? "assigned" : "created"].etags[String(url)] = 'W/"e"';
        return jsonResponse(200, []);
      });
      vi.stubGlobal("fetch", fetchSeed);
      await pollGitHubAccount({ accountId: ACCOUNT, getToken: token, cursor });
    };
    await seed();

    const fetchMock = vi.fn(async () => jsonResponse(304, null));
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token, cursor });
    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.cursor.assigned.since).toBe("2026-07-09T00:00:00Z");
    expect(result.cursor.created.since).toBe("2026-07-08T00:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters pull_request items per stream and hydrates open PRs", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/repos/o/r/pulls/7")) {
        return jsonResponse(200, {
          state: "open",
          merged: false,
          draft: true,
          mergeable: true,
          head: { ref: "feature/x" },
          base: { ref: "develop" },
        });
      }
      if (u.includes("filter=assigned")) {
        return jsonResponse(200, [
          issuePayload({ id: 1, number: 1, title: "real issue" }),
          issuePayload({ id: 5, number: 5, title: "assigned pr", pull_request: { merged_at: null } }),
        ]);
      }
      if (u.includes("filter=created")) {
        return jsonResponse(200, [
          issuePayload({ id: 6, number: 6, title: "my plain issue" }),
          issuePayload({ id: 7, number: 7, title: "my pr", pull_request: { merged_at: null } }),
          issuePayload({
            id: 8,
            number: 8,
            title: "merged pr",
            state: "closed",
            pull_request: { merged_at: "2026-07-09T00:00:00Z" },
          }),
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.issues.map((i) => i.number)).toEqual([1]);
    expect(result.pullRequests.map((p) => p.number)).toEqual([7, 8]);

    const open = result.pullRequests.find((p) => p.number === 7)!;
    expect(open).toMatchObject({ headRef: "feature/x", baseRef: "develop", draft: true, mergeable: true });
    const merged = result.pullRequests.find((p) => p.number === 8)!;
    expect(merged).toMatchObject({ merged: true, state: "closed" });
    expect(merged.headRef).toBeUndefined();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/pulls/8"))).toBe(false);
  });

  it("hydration failure is non-fatal", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/pulls/")) return jsonResponse(500, { message: "boom" });
      if (u.includes("filter=created")) {
        return jsonResponse(200, [issuePayload({ id: 7, number: 7, title: "pr", pull_request: { merged_at: null } })]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0].headRef).toBeUndefined();
  });

  it("treats a cursor version mismatch as a full walk", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).not.toContain("since=");
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const badCursor = { ...emptyGitHubCursor(), version: 2 } as unknown as GitHubAccountCursor;
    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token, cursor: badCursor });
    expect(result.mode).toBe("full");
  });

  it("recovers from a 422 on delta with a full walk", async () => {
    const cursor: GitHubAccountCursor = {
      ...emptyGitHubCursor(),
      assigned: { since: "garbage", etags: {} },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("since=")) return jsonResponse(422, { message: "bad since" });
      if (u.includes("filter=assigned")) {
        return jsonResponse(200, [issuePayload({ id: 1, number: 1, title: "one" })]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitHubAccount({ accountId: ACCOUNT, getToken: token, cursor });
    expect(result.mode).toBe("full");
    expect(result.issues).toHaveLength(1);
  });

  it("deep-hydrates tracked PRs absent from the delta stream, with reviews + CI", async () => {
    const cursor: GitHubAccountCursor = {
      ...emptyGitHubCursor(),
      assigned: { since: "2026-07-09T00:00:00Z", etags: {} },
      created: { since: "2026-07-09T00:00:00Z", etags: {} },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/repos/o/r/pulls/7/reviews")) {
        return jsonResponse(200, [{ user: { login: "rev" }, state: "CHANGES_REQUESTED" }]);
      }
      if (u.includes("/check-runs")) {
        return jsonResponse(200, { check_runs: [{ status: "completed", conclusion: "success" }] });
      }
      if (u.includes("/status")) {
        return jsonResponse(200, { state: "pending", total_count: 0 });
      }
      if (u.includes("/repos/o/r/pulls/7")) {
        return jsonResponse(200, {
          id: 700,
          number: 7,
          title: "tracked pr",
          body: "b",
          state: "open",
          merged: false,
          draft: false,
          mergeable: true,
          html_url: "https://github.com/o/r/pull/7",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-10T00:00:00Z",
          user: { login: "cicababba" },
          head: { ref: "feature/issue-7", sha: "abc123" },
          base: { ref: "develop" },
        });
      }
      return jsonResponse(200, []); // empty delta streams
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitHubAccount({
      accountId: ACCOUNT,
      getToken: token,
      cursor,
      deepHydrate: [{ owner: "o", name: "r", number: 7 }],
    });
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      id: "github:700",
      number: 7,
      headRef: "feature/issue-7",
      reviewDecision: "changes-requested",
      ciStatus: "passing",
    });
  });

  it("merges deep-hydrated PRs by repo+number, keeping the stream's issue-record id", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/reviews")) return jsonResponse(200, []);
      if (u.includes("/check-runs")) return jsonResponse(200, { check_runs: [] });
      if (u.includes("/status")) return jsonResponse(200, { total_count: 0 });
      if (u.includes("/repos/o/r/pulls/7")) {
        return jsonResponse(200, {
          id: 700,
          number: 7,
          title: "my pr",
          state: "open",
          merged: false,
          draft: true,
          mergeable: null,
          html_url: "https://github.com/o/r/pull/7",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-10T00:00:00Z",
          user: { login: "cicababba" },
          head: { ref: "feature/issue-7", sha: "abc" },
          base: { ref: "develop" },
        });
      }
      if (u.includes("filter=created")) {
        return jsonResponse(200, [
          issuePayload({ id: 7, number: 7, title: "my pr", pull_request: { merged_at: null } }),
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitHubAccount({
      accountId: ACCOUNT,
      getToken: token,
      deepHydrate: [{ owner: "o", name: "r", number: 7 }],
    });
    expect(result.pullRequests).toHaveLength(1);
    // stream id (github:7) wins over the pull-record id (github:700)
    expect(result.pullRequests[0].id).toBe("github:7");
    expect(result.pullRequests[0].reviewDecision).toBe("review-required");
    // deep hydration replaces regular hydration: exactly one detail GET for #7
    const detailCalls = fetchMock.mock.calls.filter((c) => /\/pulls\/7$/.test(String(c[0])));
    expect(detailCalls).toHaveLength(1);
  });

  it("a failing deep-hydration target is non-fatal", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/repos/o/r/pulls/9")) return jsonResponse(500, { message: "boom" });
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitHubAccount({
      accountId: ACCOUNT,
      getToken: token,
      deepHydrate: [{ owner: "o", name: "r", number: 9 }],
    });
    expect(result.pullRequests).toEqual([]);
  });

  it("performs requests serially", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const u = String(url);
      if (u.includes("filter=created")) {
        return jsonResponse(200, [
          issuePayload({ id: 7, number: 7, title: "pr1", pull_request: { merged_at: null } }),
          issuePayload({ id: 8, number: 8, title: "pr2", pull_request: { merged_at: null } }),
        ]);
      }
      if (u.includes("/pulls/")) {
        return jsonResponse(200, {
          state: "open", merged: false, draft: false, mergeable: null,
          head: { ref: "h" }, base: { ref: "b" },
        });
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    await pollGitHubAccount({ accountId: ACCOUNT, getToken: token });
    expect(maxInFlight).toBe(1);
  });
});
