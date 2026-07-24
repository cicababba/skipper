import { describe, it, expect, vi, afterEach } from "vitest";
import { gitlabCodeHost } from "../src/adapters/gitlab/code-host";
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

describe("gitlabCodeHost.createPr", () => {
  const params = { title: "t", body: "b", head: "feature/issue-12", base: "main", draft: true };

  it("creates a Draft MR and returns it without the existing flag", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        id: 555,
        iid: 12,
        web_url: "https://gitlab.com/octo/demo/-/merge_requests/12",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const created = await gitlabCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "gitlab:555",
      number: 12,
      url: "https://gitlab.com/octo/demo/-/merge_requests/12",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/projects/octo%2Fdemo/merge_requests");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      title: "Draft: t",
      description: "b",
      source_branch: "feature/issue-12",
      target_branch: "main",
    });
  });

  it("does not double-prefix a title that already carries Draft:", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { id: 1, iid: 1, web_url: "u" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await gitlabCodeHost.createPr(repo, { ...params, title: "Draft: t" }, token);
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.title).toBe("Draft: t");
  });

  it("omits the Draft prefix when draft is false", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { id: 1, iid: 1, web_url: "u" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await gitlabCodeHost.createPr(repo, { ...params, draft: false }, token);
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.title).toBe("t");
  });

  it("adopts the open MR for this source branch on 409", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(409, { message: "already exists" }))
      .mockResolvedValueOnce(
        jsonResponse(200, [
          { id: 9, iid: 4, web_url: "https://gitlab.com/octo/demo/-/merge_requests/4" },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const created = await gitlabCodeHost.createPr(repo, params, token);
    expect(created).toEqual({
      id: "gitlab:9",
      number: 4,
      url: "https://gitlab.com/octo/demo/-/merge_requests/4",
      existing: true,
    });
    const lookupUrl = String(fetchMock.mock.calls[1][0]);
    expect(lookupUrl).toContain("source_branch=feature%2Fissue-12");
    expect(lookupUrl).toContain("state=opened");
  });

  it("rethrows the original 409 when no open MR matches the source branch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(409, { message: "already exists" }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const err = await gitlabCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  it("rethrows other errors without a lookup", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { message: "boom" }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await gitlabCodeHost.createPr(repo, params, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("gitlabCodeHost.fetchReviews", () => {
  function stub(approvals: unknown, discussions: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/discussions")
          ? jsonResponse(200, discussions)
          : jsonResponse(200, approvals),
      ),
    );
  }

  it("maps an unresolved thread to changes-requested and skips system + author notes", async () => {
    stub({ approvals_left: 0 }, [
      {
        notes: [
          { id: 1, system: true, resolvable: false, resolved: false, body: "changed the milestone" },
          {
            id: 2,
            resolvable: true,
            resolved: false,
            body: "Please fix the null check.",
            author: { username: "reviewer" },
            created_at: "2026-07-01T00:00:00Z",
            position: { new_path: "src/a.ts", new_line: 10 },
          },
          {
            id: 3,
            resolvable: true,
            resolved: false,
            body: "self note",
            author: { username: "author" },
          },
        ],
      },
      { notes: [{ id: 9, resolvable: true, resolved: true, body: "resolved elsewhere" }] },
    ]);
    const result = await gitlabCodeHost.fetchReviews(repo, 4, token, "author");
    expect(result.decision).toBe("changes-requested");
    expect(result.comments).toEqual([
      {
        author: "reviewer",
        path: "src/a.ts",
        line: 10,
        body: "Please fix the null check.",
        url: "https://gitlab.com/octo/demo/-/merge_requests/4#note_2",
        submittedAt: "2026-07-01T00:00:00Z",
      },
    ]);
  });

  it("returns approved with no comments when approvals are met and threads resolved", async () => {
    stub({ approvals_left: 0 }, [
      { notes: [{ id: 1, resolvable: true, resolved: true, body: "looks good now" }] },
    ]);
    const result = await gitlabCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("approved");
    expect(result.comments).toEqual([]);
  });

  it("returns review-required when unapproved and no unresolved threads", async () => {
    stub({ approvals_left: 2 }, []);
    const result = await gitlabCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("review-required");
  });

  it("falls back to the approved boolean when approvals_left is absent", async () => {
    stub({ approved: true }, []);
    const result = await gitlabCodeHost.fetchReviews(repo, 4, token);
    expect(result.decision).toBe("approved");
  });
});

describe("gitlabCodeHost.fetchCiStatus", () => {
  it("maps the latest pipeline for a sha", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain("sha=deadbeef");
        return jsonResponse(200, [{ id: 7, status: "success" }]);
      }),
    );
    expect(await gitlabCodeHost.fetchCiStatus(repo, "deadbeef", token)).toBe("passing");
  });

  it("returns undefined when no pipeline exists for the sha", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    expect(await gitlabCodeHost.fetchCiStatus(repo, "deadbeef", token)).toBeUndefined();
  });
});

describe("gitlabCodeHost.fetchFailingChecks", () => {
  it("returns the failed jobs of the latest pipeline, filtering allow_failure", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/jobs")) {
        expect(u).toContain("/pipelines/7/jobs");
        return jsonResponse(200, [
          {
            name: "lint",
            web_url: "https://gitlab.com/octo/demo/-/jobs/1",
            failure_reason: "script_failure",
          },
          { name: "flaky", allow_failure: true, failure_reason: "script_failure" },
        ]);
      }
      return jsonResponse(200, [{ id: 7, status: "failed" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const checks = await gitlabCodeHost.fetchFailingChecks(repo, "deadbeef", token);
    expect(checks).toEqual([
      { name: "lint", url: "https://gitlab.com/octo/demo/-/jobs/1", summary: "script_failure" },
    ]);
  });

  it("returns an empty list when there is no pipeline for the sha", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, [])));
    expect(await gitlabCodeHost.fetchFailingChecks(repo, "deadbeef", token)).toEqual([]);
  });
});

describe("gitlabCodeHost conventions and identity helpers", () => {
  it("builds the tracker link from the string key", () => {
    expect(gitlabCodeHost.linkIssueText("42")).toBe("Closes #42");
  });

  it("uses the oauth2 askpass username", () => {
    expect(gitlabCodeHost.pushCredentials("tok")).toEqual({ username: "oauth2", password: "tok" });
  });

  it("builds the https clone URL, defaulting to gitlab.com", () => {
    expect(gitlabCodeHost.cloneUrl(repo)).toBe("https://gitlab.com/octo/demo.git");
  });

  it("builds the clone URL against a self-hosted instance with a nested group", () => {
    expect(
      gitlabCodeHost.cloneUrl({ owner: "group/sub", name: "proj" }, "https://git.corp/gitlab"),
    ).toBe("https://git.corp/gitlab/group/sub/proj.git");
  });

  it("parses https, scp-like and ssh origins", () => {
    expect(gitlabCodeHost.parseOrigin("https://gitlab.com/octo/demo.git")).toEqual(repo);
    expect(gitlabCodeHost.parseOrigin("https://gitlab.com/octo/demo/")).toEqual(repo);
    expect(gitlabCodeHost.parseOrigin("git@gitlab.com:octo/demo.git")).toEqual(repo);
    expect(gitlabCodeHost.parseOrigin("ssh://git@gitlab.com/octo/demo")).toEqual(repo);
  });

  it("parses nested-group origins", () => {
    expect(gitlabCodeHost.parseOrigin("https://gitlab.com/group/sub/proj.git")).toEqual({
      owner: "group/sub",
      name: "proj",
    });
    expect(gitlabCodeHost.parseOrigin("git@gitlab.com:group/sub/proj.git")).toEqual({
      owner: "group/sub",
      name: "proj",
    });
  });

  it("parses origins on a self-hosted subpath install", () => {
    expect(
      gitlabCodeHost.parseOrigin("https://git.corp/gitlab/group/sub/proj.git", "https://git.corp/gitlab"),
    ).toEqual({ owner: "group/sub", name: "proj" });
    expect(
      gitlabCodeHost.parseOrigin("git@git.corp:gitlab/group/sub/proj.git", "https://git.corp/gitlab"),
    ).toEqual({ owner: "group/sub", name: "proj" });
  });

  it("returns null for a different host", () => {
    expect(gitlabCodeHost.parseOrigin("https://github.com/octo/demo.git")).toBeNull();
    expect(gitlabCodeHost.parseOrigin("https://gitlab.com/octo/demo.git", "https://git.corp")).toBeNull();
  });
});
