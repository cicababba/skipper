import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPullRequest,
  deriveReviewDecision,
  fetchCiStatus,
  fetchPullReviews,
  findOpenPullByHead,
  mapReviewFeedback,
  type PullReviewCommentPayload,
  type PullReviewPayload,
} from "../src/github/pulls";
import { GitHubApiError } from "../src/github/types";

const repo = { owner: "octo", name: "demo" };
const token = async () => "tok";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPullRequest", () => {
  it("posts the params and maps id/number/url", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { id: 555, number: 12, html_url: "https://github.com/octo/demo/pull/12" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await createPullRequest(
      repo,
      { title: "t", body: "b", head: "feature/issue-12", base: "main", draft: true },
      token,
    );
    expect(created).toEqual({
      id: "github:555",
      number: 12,
      url: "https://github.com/octo/demo/pull/12",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/octo/demo/pulls");
    expect(JSON.parse(init.body as string)).toMatchObject({ head: "feature/issue-12", draft: true });
  });

  it("propagates a 422 (PR already exists) with status for the caller's recovery", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { message: "already exists" })));
    const err = await createPullRequest(
      repo,
      { title: "t", body: "b", head: "h", base: "main", draft: true },
      token,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBe(422);
  });
});

describe("findOpenPullByHead", () => {
  it("queries by owner:branch and maps the first match", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, [{ id: 9, number: 4, html_url: "https://github.com/octo/demo/pull/4" }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const found = await findOpenPullByHead(repo, "feature/issue-4", token);
    expect(found).toEqual({ id: "github:9", number: 4, url: "https://github.com/octo/demo/pull/4" });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("head=octo%3Afeature%2Fissue-4");
    expect(String(url)).toContain("state=open");
  });

  it("returns null when no PR matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    expect(await findOpenPullByHead(repo, "feature/issue-4", token)).toBeNull();
  });
});

describe("fetchPullReviews", () => {
  it("follows Link rel=next pagination", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, [{ state: "APPROVED", user: { login: "a" } }], {
          link: '<https://api.github.com/repos/octo/demo/pulls/1/reviews?page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, [{ state: "COMMENTED", user: { login: "b" } }]));
    vi.stubGlobal("fetch", fetchMock);
    const reviews = await fetchPullReviews(repo, 1, token);
    expect(reviews).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("deriveReviewDecision", () => {
  const r = (login: string, state: string, at: string): PullReviewPayload => ({
    user: { login },
    state,
    submitted_at: at,
  });

  it("returns review-required with no reviews", () => {
    expect(deriveReviewDecision([])).toBe("review-required");
  });

  it("changes-requested wins over another reviewer's approval", () => {
    const reviews = [r("a", "APPROVED", "2026-01-01"), r("b", "CHANGES_REQUESTED", "2026-01-02")];
    expect(deriveReviewDecision(reviews)).toBe("changes-requested");
  });

  it("the same reviewer's later approval supersedes their change request", () => {
    const reviews = [r("a", "CHANGES_REQUESTED", "2026-01-01"), r("a", "APPROVED", "2026-01-02")];
    expect(deriveReviewDecision(reviews)).toBe("approved");
  });

  it("DISMISSED clears the reviewer's vote", () => {
    const reviews = [r("a", "CHANGES_REQUESTED", "2026-01-01"), r("a", "DISMISSED", "2026-01-02")];
    expect(deriveReviewDecision(reviews)).toBe("review-required");
  });

  it("COMMENTED reviews and the PR author's reviews are ignored", () => {
    const reviews = [r("a", "COMMENTED", "2026-01-01"), r("author", "APPROVED", "2026-01-02")];
    expect(deriveReviewDecision(reviews, "author")).toBe("review-required");
  });
});

describe("mapReviewFeedback", () => {
  it("collects change-request review bodies and inline comments, skipping the PR author and empty bodies", () => {
    const reviews: PullReviewPayload[] = [
      { user: { login: "rev" }, state: "CHANGES_REQUESTED", body: "Please fix X", html_url: "u1" },
      { user: { login: "rev" }, state: "APPROVED", body: "lgtm now" },
      { user: { login: "rev2" }, state: "CHANGES_REQUESTED", body: "  " },
      { user: { login: "author" }, state: "CHANGES_REQUESTED", body: "self note" },
    ];
    const comments: PullReviewCommentPayload[] = [
      { user: { login: "rev" }, path: "src/a.ts", line: 10, body: "rename this" },
      { user: { login: "author" }, path: "src/b.ts", line: 2, body: "author note" },
      { user: { login: "rev" }, path: "src/c.ts", original_line: 5, line: null, body: "old line note" },
    ];
    const feedback = mapReviewFeedback(reviews, comments, "author");
    expect(feedback).toEqual([
      { author: "rev", body: "Please fix X", url: "u1", submittedAt: undefined },
      { author: "rev", path: "src/a.ts", line: 10, body: "rename this", url: undefined, submittedAt: undefined },
      { author: "rev", path: "src/c.ts", line: 5, body: "old line note", url: undefined, submittedAt: undefined },
    ]);
  });

  it("includes the author's comments when no prAuthor filter is passed", () => {
    const comments: PullReviewCommentPayload[] = [
      { user: { login: "author" }, path: "src/b.ts", line: 2, body: "author feedback" },
    ];
    expect(mapReviewFeedback([], comments)).toHaveLength(1);
  });
});

describe("fetchCiStatus", () => {
  function stubCi(checkRuns: unknown[], combined: { state?: string; total_count?: number }): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/check-runs")) {
          return jsonResponse(200, { check_runs: checkRuns });
        }
        return jsonResponse(200, combined);
      }),
    );
  }

  it("any failing check run wins", async () => {
    stubCi(
      [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }],
      { state: "success", total_count: 1 },
    );
    expect(await fetchCiStatus(repo, "abc", token)).toBe("failing");
  });

  it("in-progress runs report pending", async () => {
    stubCi([{ status: "in_progress", conclusion: null }], { total_count: 0 });
    expect(await fetchCiStatus(repo, "abc", token)).toBe("pending");
  });

  it("all success reports passing", async () => {
    stubCi([{ status: "completed", conclusion: "success" }], { total_count: 0 });
    expect(await fetchCiStatus(repo, "abc", token)).toBe("passing");
  });

  it("legacy combined status failure wins even without check runs", async () => {
    stubCi([], { state: "failure", total_count: 2 });
    expect(await fetchCiStatus(repo, "abc", token)).toBe("failing");
  });

  it("no checks at all reports undefined", async () => {
    stubCi([], { state: "pending", total_count: 0 });
    expect(await fetchCiStatus(repo, "abc", token)).toBeUndefined();
  });
});
