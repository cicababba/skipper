import { describe, it, expect, vi, afterEach } from "vitest";
import { pollGitLabAccount } from "../src/adapters/gitlab/poll";
import { emptyGitLabCursor, type GitLabAccountCursor } from "../src/adapters/gitlab/types";

const ACCOUNT = "45292355";
const token = async () => "tok";

interface StubItem {
  id: number;
  iid: number;
  title: string;
  updated_at?: string;
}

function issuePayload(over: StubItem & { state?: "opened" | "closed" }) {
  return {
    id: over.id,
    iid: over.iid,
    title: over.title,
    description: "b",
    state: over.state ?? "opened",
    web_url: `https://gitlab.com/o/r/-/issues/${over.iid}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-07-10T10:00:00Z",
    labels: ["bug"],
    assignees: [{ username: "cicababba" }],
    author: { username: "cicababba" },
    references: { full: `o/r#${over.iid}` },
  };
}

function mrPayload(
  over: StubItem & {
    state?: "opened" | "closed" | "locked" | "merged";
    draft?: boolean;
    source_branch?: string;
    target_branch?: string;
    sha?: string;
    merge_status?: string;
  },
) {
  return {
    id: over.id,
    iid: over.iid,
    title: over.title,
    description: "b",
    state: over.state ?? "opened",
    web_url: `https://gitlab.com/o/r/-/merge_requests/${over.iid}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: over.updated_at ?? "2026-07-10T10:00:00Z",
    labels: [],
    assignees: [{ username: "cicababba" }],
    author: { username: "cicababba" },
    references: { full: `o/r!${over.iid}` },
    draft: over.draft ?? false,
    source_branch: over.source_branch ?? "feature/x",
    target_branch: over.target_branch ?? "main",
    sha: over.sha ?? "deadbeef",
    merge_status: over.merge_status ?? "can_be_merged",
  };
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

describe("pollGitLabAccount", () => {
  it("full walk hits both endpoints with correct scope+state, follows pagination", async () => {
    const issuesPage2 = "https://gitlab.com/api/v4/issues?scope=assigned_to_me&page=2";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u === issuesPage2) {
        return jsonResponse(200, [
          issuePayload({ id: 2, iid: 2, title: "two", updated_at: "2026-07-10T12:00:00Z" }),
        ]);
      }
      if (u.includes("/issues?")) {
        expect(u).toContain("scope=assigned_to_me");
        expect(u).toContain("state=opened");
        expect(u).not.toContain("updated_after");
        return jsonResponse(200, [issuePayload({ id: 1, iid: 1, title: "one" })], {
          link: `<${issuesPage2}>; rel="next"`,
        });
      }
      if (u.includes("/merge_requests?")) {
        expect(u).toContain("scope=created_by_me");
        expect(u).toContain("state=opened");
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.mode).toBe("full");
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    const expectedAfter = new Date(Date.parse("2026-07-10T12:00:00Z") - 60_000).toISOString();
    expect(result.cursor.issues.updatedAfter).toBe(expectedAfter);
  });

  it("maps issues to neutral items with gitlab id, stamps and iid keying", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/issues?")) {
        return jsonResponse(200, [issuePayload({ id: 555, iid: 42, title: "hello" })]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.issues[0]).toMatchObject({
      id: "gitlab:555",
      source: "gitlab",
      codeHost: "gitlab",
      key: "42",
      number: 42,
      sourceRef: { project: "o/r", key: "42" },
      accountId: ACCOUNT,
      repo: { owner: "o", name: "r" },
      kind: "issue",
      labels: ["bug"],
      author: "cicababba",
      assignees: ["cicababba"],
    });
  });

  it("resolves nested-group repo from references.full and falls back to web_url", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/issues?")) {
        return jsonResponse(200, [
          { ...issuePayload({ id: 1, iid: 7, title: "nested" }), references: { full: "group/sub/project#7" } },
          {
            ...issuePayload({ id: 2, iid: 8, title: "fallback" }),
            references: undefined,
            web_url: "https://gitlab.com/group/sub/project/-/issues/8",
          },
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token });
    expect(result.issues[0].repo).toEqual({ owner: "group/sub", name: "project" });
    expect(result.issues[0].sourceRef.project).toBe("group/sub/project");
    expect(result.issues[1].repo).toEqual({ owner: "group/sub", name: "project" });
  });

  it("maps merge requests without a detail fetch (list payload is complete)", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/merge_requests?")) {
        return jsonResponse(200, [
          mrPayload({
            id: 10,
            iid: 3,
            title: "open draft",
            draft: true,
            source_branch: "feature/x",
            target_branch: "develop",
            sha: "abc",
            merge_status: "can_be_merged",
          }),
          mrPayload({ id: 11, iid: 4, title: "merged mr", state: "merged" }),
          mrPayload({ id: 12, iid: 5, title: "closed mr", state: "closed" }),
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token });

    const open = result.pullRequests.find((p) => p.number === 3)!;
    expect(open).toMatchObject({
      state: "open",
      draft: true,
      headRef: "feature/x",
      baseRef: "develop",
      headSha: "abc",
      mergeable: true,
    });
    const merged = result.pullRequests.find((p) => p.number === 4)!;
    expect(merged).toMatchObject({ state: "closed", merged: true });
    const closed = result.pullRequests.find((p) => p.number === 5)!;
    expect(closed).toMatchObject({ state: "closed", merged: false });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/merge_requests/"))).toBe(false);
  });

  it("delta sends updated_after, omits state, surfaces a closed issue, mode delta", async () => {
    const cursor: GitLabAccountCursor = {
      ...emptyGitLabCursor(),
      issues: { updatedAfter: "2026-07-09T00:00:00Z" },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/issues?")) {
        expect(u).toContain(`updated_after=${encodeURIComponent("2026-07-09T00:00:00Z")}`);
        expect(u).not.toContain("state=");
        return jsonResponse(200, [
          issuePayload({ id: 9, iid: 9, title: "closed one", state: "closed" }),
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token, cursor });
    expect(result.mode).toBe("delta");
    expect(result.issues[0]).toMatchObject({ number: 9, state: "closed" });
  });

  it("treats a garbage or version-mismatched cursor as a full walk", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).not.toContain("updated_after");
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const garbage of [
      "junk",
      42,
      null,
      { version: 1 },
      { version: 2, issues: {}, mergeRequests: {} },
    ]) {
      const result = await pollGitLabAccount({
        accountId: ACCOUNT,
        getToken: token,
        cursor: garbage as unknown as GitLabAccountCursor,
      });
      expect(result.mode).toBe("full");
    }
  });

  it("recovers from a 400 on delta with a full walk", async () => {
    const cursor: GitLabAccountCursor = {
      ...emptyGitLabCursor(),
      issues: { updatedAfter: "garbage" },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("updated_after")) return jsonResponse(400, { message: "bad updated_after" });
      if (u.includes("/issues?")) return jsonResponse(200, [issuePayload({ id: 1, iid: 1, title: "one" })]);
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({ accountId: ACCOUNT, getToken: token, cursor });
    expect(result.mode).toBe("full");
    expect(result.issues).toHaveLength(1);
  });

  it("deep-hydrates a tracked MR, keeping the stream's list-record id", async () => {
    const cursor: GitLabAccountCursor = {
      ...emptyGitLabCursor(),
      issues: { updatedAfter: "2026-07-09T00:00:00Z" },
      mergeRequests: { updatedAfter: "2026-07-09T00:00:00Z" },
    };
    const listMr = {
      ...mrPayload({ id: 30, iid: 3, title: "tracked" }),
      references: { full: "group/sub/proj!3" },
      web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/3",
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/merge_requests/3/approvals")) return jsonResponse(200, { approved: true });
      if (u.includes("/merge_requests/3/discussions")) return jsonResponse(200, []);
      if (u.includes("/projects/group%2Fsub%2Fproj/merge_requests/3")) {
        return jsonResponse(200, {
          id: 300,
          iid: 3,
          title: "tracked",
          state: "opened",
          draft: false,
          web_url: "https://gitlab.com/group/sub/proj/-/merge_requests/3",
          created_at: "2026-07-01T00:00:00Z",
          updated_at: "2026-07-10T00:00:00Z",
          author: { username: "cicababba" },
          references: { full: "group/sub/proj!3" },
          source_branch: "feature/x",
          target_branch: "main",
          sha: "abc",
          merge_status: "can_be_merged",
          head_pipeline: { status: "success" },
        });
      }
      if (u.includes("/merge_requests?")) return jsonResponse(200, [listMr]);
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({
      accountId: ACCOUNT,
      getToken: token,
      cursor,
      deepHydrate: [{ owner: "group/sub", name: "proj", number: 3 }],
    });
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      id: "gitlab:30", // stream id wins over the detail-record id gitlab:300
      number: 3,
      reviewDecision: "approved",
      ciStatus: "passing",
    });
  });

  it("surfaces changes-requested when a tracked MR has an unresolved thread", async () => {
    const cursor: GitLabAccountCursor = {
      ...emptyGitLabCursor(),
      mergeRequests: { updatedAfter: "2026-07-09T00:00:00Z" },
    };
    const listMr = {
      ...mrPayload({ id: 30, iid: 3, title: "tracked" }),
      references: { full: "o/r!3" },
      web_url: "https://gitlab.com/o/r/-/merge_requests/3",
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/merge_requests/3/approvals")) return jsonResponse(200, { approved: true });
      if (u.includes("/merge_requests/3/discussions")) {
        return jsonResponse(200, [
          { notes: [{ id: 1, resolvable: true, resolved: false, body: "fix this" }] },
        ]);
      }
      if (u.includes("/projects/o%2Fr/merge_requests/3")) {
        return jsonResponse(200, {
          ...mrPayload({ id: 300, iid: 3, title: "tracked" }),
          state: "opened",
          references: { full: "o/r!3" },
          web_url: "https://gitlab.com/o/r/-/merge_requests/3",
          head_pipeline: { status: "success" },
        });
      }
      if (u.includes("/merge_requests?")) return jsonResponse(200, [listMr]);
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({
      accountId: ACCOUNT,
      getToken: token,
      cursor,
      deepHydrate: [{ owner: "o", name: "r", number: 3 }],
    });
    expect(result.pullRequests[0]).toMatchObject({
      number: 3,
      reviewDecision: "changes-requested",
    });
  });

  it("a failing deep-hydration target is non-fatal", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/projects/o%2Fr/merge_requests/9")) return jsonResponse(500, { message: "boom" });
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollGitLabAccount({
      accountId: ACCOUNT,
      getToken: token,
      deepHydrate: [{ owner: "o", name: "r", number: 9 }],
    });
    expect(result.pullRequests).toEqual([]);
  });

  it("targets the self-hosted API base under a subpath install", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    await pollGitLabAccount({ accountId: ACCOUNT, getToken: token, baseUrl: "https://git.corp/gitlab" });
    expect(seen.every((u) => u.startsWith("https://git.corp/gitlab/api/v4/"))).toBe(true);
    expect(seen.some((u) => u.includes("/api/v4/issues?"))).toBe(true);
    expect(seen.some((u) => u.includes("/api/v4/merge_requests?"))).toBe(true);
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
      if (u.includes("/merge_requests?")) {
        return jsonResponse(200, [
          mrPayload({ id: 1, iid: 1, title: "a" }),
          mrPayload({ id: 2, iid: 2, title: "b" }),
        ]);
      }
      return jsonResponse(200, []);
    });
    vi.stubGlobal("fetch", fetchMock);
    await pollGitLabAccount({
      accountId: ACCOUNT,
      getToken: token,
      deepHydrate: [{ owner: "o", name: "r", number: 1 }],
    });
    expect(maxInFlight).toBe(1);
  });
});
