import { describe, it, expect, vi, afterEach } from "vitest";
import { githubCodeHost } from "../src/adapters/github/code-host";
import { ApiError } from "../src/adapters/types";

const repo = { owner: "octo", name: "demo" };
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

describe("githubCodeHost.createPr", () => {
  const params = { title: "t", body: "b", head: "feature/issue-12", base: "main", draft: true };

  it("creates the PR and returns it without the existing flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(201, { id: 555, number: 12, html_url: "https://github.com/octo/demo/pull/12" }),
      ),
    );
    const created = await githubCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "github:555",
      number: 12,
      url: "https://github.com/octo/demo/pull/12",
    });
  });

  it("adopts the open PR for this head on 422", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { message: "already exists" }))
      .mockResolvedValueOnce(
        jsonResponse(200, [{ id: 9, number: 4, html_url: "https://github.com/octo/demo/pull/4" }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const created = await githubCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "github:9",
      number: 4,
      url: "https://github.com/octo/demo/pull/4",
      existing: true,
    });
    const lookupUrl = String(fetchMock.mock.calls[1][0]);
    expect(lookupUrl).toContain("head=octo%3Afeature%2Fissue-12");
    expect(lookupUrl).toContain("state=open");
  });

  it("rethrows the original 422 when no open PR matches the head", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { message: "already exists" }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const err = await githubCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
  });

  it("rethrows other errors without a lookup", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { message: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await githubCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("githubCodeHost.fetchReviews", () => {
  it("returns the derived decision and mapped feedback, excluding the PR author", async () => {
    const reviews = [
      { user: { login: "author" }, state: "CHANGES_REQUESTED", body: "self note" },
      {
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please fix the null check.",
        html_url: "https://github.com/octo/demo/pull/4#r1",
        submitted_at: "2026-07-01T00:00:00Z",
      },
    ];
    const comments = [
      {
        user: { login: "reviewer" },
        path: "src/a.ts",
        line: 10,
        body: "inline nit",
        html_url: "https://github.com/octo/demo/pull/4#c1",
        created_at: "2026-07-01T00:01:00Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/reviews") ? jsonResponse(200, reviews) : jsonResponse(200, comments),
      ),
    );
    const result = await githubCodeHost.fetchReviews(repo, 4, token, "author");
    expect(result.decision).toBe("changes-requested");
    expect(result.comments).toEqual([
      {
        author: "reviewer",
        body: "Please fix the null check.",
        url: "https://github.com/octo/demo/pull/4#r1",
        submittedAt: "2026-07-01T00:00:00Z",
      },
      {
        author: "reviewer",
        path: "src/a.ts",
        line: 10,
        body: "inline nit",
        url: "https://github.com/octo/demo/pull/4#c1",
        submittedAt: "2026-07-01T00:01:00Z",
      },
    ]);
  });
});

describe("githubCodeHost conventions", () => {
  it("links issues with the Closes keyword", () => {
    expect(githubCodeHost.linkIssueText(42)).toBe("Closes #42");
  });

  it("uses the x-access-token askpass username", () => {
    expect(githubCodeHost.pushCredentials("tok")).toEqual({
      username: "x-access-token",
      password: "tok",
    });
  });
});

describe("githubCodeHost identity helpers", () => {
  it("builds the tracker link from the string key", () => {
    expect(githubCodeHost.linkIssueText("42")).toBe("Closes #42");
  });

  it("closes by full URL when the issue is outside the PR's repo (#299)", () => {
    expect(githubCodeHost.linkIssueUrlText("https://github.com/acme/issues/issues/42")).toBe(
      "Closes https://github.com/acme/issues/issues/42",
    );
  });

  it("builds the https clone URL", () => {
    expect(githubCodeHost.cloneUrl(repo)).toBe("https://github.com/octo/demo.git");
  });

  it("parses https, scp-like and ssh origins", () => {
    expect(githubCodeHost.parseOrigin("https://github.com/octo/demo.git")).toEqual(repo);
    expect(githubCodeHost.parseOrigin("https://github.com/octo/demo/")).toEqual(repo);
    expect(githubCodeHost.parseOrigin("git@github.com:octo/demo.git")).toEqual(repo);
    expect(githubCodeHost.parseOrigin("ssh://git@github.com/octo/demo")).toEqual(repo);
  });

  it("returns null for non-GitHub origins", () => {
    expect(githubCodeHost.parseOrigin("https://gitlab.com/octo/demo.git")).toBeNull();
  });
});
