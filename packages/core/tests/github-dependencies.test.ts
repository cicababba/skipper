import { describe, it, expect, vi, afterEach } from "vitest";
import type { Issue } from "@skipper/shared";
import {
  fetchGitHubDependencies,
  parseBodyDependencies,
} from "../src/adapters/github/dependencies";

const token = async () => "tok";

function ghIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "github:100",
    kind: "issue",
    source: "github",
    sourceRef: { project: "o/r", key: "5" },
    codeHost: "github",
    accountId: "a",
    repo: { owner: "o", name: "r" },
    key: "5",
    number: 5,
    title: "t",
    labels: [],
    assignees: [],
    url: "https://github.com/o/r/issues/5",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    state: "open",
    ...over,
  };
}

function depPayload(number: number, project: string) {
  return { number, repository_url: `https://api.github.com/repos/${project}` };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGitHubDependencies — native", () => {
  it("maps native deps, including a cross-repo repository_url", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, [depPayload(1, "o/r"), depPayload(7, "other/repo")]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refs = await fetchGitHubDependencies(ghIssue({ body: "Blocked by #99" }), token);
    expect(refs).toEqual([
      { project: "o/r", key: "1" },
      { project: "other/repo", key: "7" },
    ]);
    // Native non-empty wins — the body's #99 is ignored.
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/repos/o/r/issues/5/dependencies/blocked_by",
    );
  });

  it("follows Link pagination", async () => {
    const page2 = "https://api.github.com/repos/o/r/issues/5/dependencies/blocked_by?page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url) === page2) return jsonResponse(200, [depPayload(2, "o/r")]);
      return jsonResponse(200, [depPayload(1, "o/r")], { link: `<${page2}>; rel="next"` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const refs = await fetchGitHubDependencies(ghIssue(), token);
    expect(refs.map((r) => r.key)).toEqual(["1", "2"]);
  });

  it("falls back to body parsing when native is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    const refs = await fetchGitHubDependencies(ghIssue({ body: "Blocked by #3" }), token);
    expect(refs).toEqual([{ project: "o/r", key: "3" }]);
  });

  it("falls back to body parsing on a 404 (native unavailable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { message: "Not Found" })));
    const refs = await fetchGitHubDependencies(ghIssue({ body: "depends on o2/r2#6" }), token);
    expect(refs).toEqual([{ project: "o2/r2", key: "6" }]);
  });

  it("propagates a 403 ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { message: "rate limited" })),
    );
    await expect(fetchGitHubDependencies(ghIssue(), token)).rejects.toMatchObject({ status: 403 });
  });

  it("drops self-references and dedupes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, [depPayload(5, "o/r"), depPayload(1, "o/r"), depPayload(1, "o/r")])),
    );
    const refs = await fetchGitHubDependencies(ghIssue(), token); // issue key is "5"
    expect(refs).toEqual([{ project: "o/r", key: "1" }]);
  });
});

describe("parseBodyDependencies", () => {
  it("parses a single 'Blocked by #N'", () => {
    expect(parseBodyDependencies("Blocked by #3", "o/r")).toEqual([{ project: "o/r", key: "3" }]);
  });

  it("parses a comma/and separated list with a cross-repo ref", () => {
    expect(parseBodyDependencies("depends on #4, #5 and o2/r2#6", "o/r")).toEqual([
      { project: "o/r", key: "4" },
      { project: "o/r", key: "5" },
      { project: "o2/r2", key: "6" },
    ]);
  });

  it("is case-insensitive", () => {
    expect(parseBodyDependencies("BLOCKED BY #8", "o/r")).toEqual([{ project: "o/r", key: "8" }]);
  });

  it("ignores a bare ref with no phrase", () => {
    expect(parseBodyDependencies("see #7 for context", "o/r")).toEqual([]);
  });

  it("does not swallow prose after the ref", () => {
    expect(parseBodyDependencies("blocked by #3 see #4", "o/r")).toEqual([
      { project: "o/r", key: "3" },
    ]);
  });

  it("returns nothing for an empty body", () => {
    expect(parseBodyDependencies(undefined, "o/r")).toEqual([]);
  });
});
