import { describe, it, expect, vi, afterEach } from "vitest";
import { createJiraIssue } from "../src/adapters/jira/create";
import type { CreateIssueParams } from "../src/adapters/types";

const token = async () => "tok";
const CLOUD_ID = "cloud-1";
const CLOUD_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;
const DC_BASE = "https://jira.corp";

function params(over: Partial<CreateIssueParams> = {}): CreateIssueParams {
  return {
    repo: { owner: "o", name: "r" },
    title: "t",
    accountId: "acc-1",
    project: "PROJ",
    ...over,
  };
}

function issuePayload(over: Record<string, unknown> = {}) {
  return {
    id: "10101",
    key: "PROJ-123",
    fields: {
      summary: "t",
      description: "b",
      labels: ["bug"],
      components: [],
      assignee: null,
      reporter: { accountId: "user-1" },
      status: { statusCategory: { key: "new" } },
      project: { key: "PROJ" },
      created: "2026-07-29T10:00:00.000+0000",
      updated: "2026-07-29T10:00:00.000+0000",
    },
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Cloud happy path: createmeta → POST /issue → hydration GET. */
function cloudFetch(types: unknown[] = [{ id: "10001", name: "Task", subtask: false }]) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/createmeta")) return jsonResponse(200, { issueTypes: types });
    if (init?.method === "POST") return jsonResponse(201, { id: "10101", key: "PROJ-123" });
    return jsonResponse(200, issuePayload());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createJiraIssue", () => {
  it("throws without a project and never touches the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createJiraIssue(params({ project: undefined }), token, DC_BASE)).rejects.toThrow(
      /needs a project/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates on Cloud via v3 with an ADF description and a hydration GET", async () => {
    const fetchMock = cloudFetch();
    vi.stubGlobal("fetch", fetchMock);

    const issue = await createJiraIssue(
      params({ body: "why", labels: ["needs triage", "web"] }),
      token,
      undefined,
      CLOUD_ID,
    );

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${CLOUD_BASE}/rest/api/3/issue/createmeta/PROJ/issuetypes`,
    );

    const [postUrl, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(String(postUrl)).toBe(`${CLOUD_BASE}/rest/api/3/issue`);
    expect(postInit.method).toBe("POST");
    const sent = JSON.parse(String(postInit.body));
    expect(sent.fields.project).toEqual({ key: "PROJ" });
    expect(sent.fields.summary).toBe("t");
    expect(sent.fields.issuetype).toEqual({ id: "10001" });
    // Jira rejects labels containing spaces.
    expect(sent.fields.labels).toEqual(["needs-triage", "web"]);
    expect(sent.fields.description).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "why" }] }],
    });

    expect(String(fetchMock.mock.calls[2][0])).toContain(`${CLOUD_BASE}/rest/api/3/issue/PROJ-123?fields=`);
    expect(issue.id).toBe("jira:10101");
    expect(issue.key).toBe("PROJ-123");
    expect(issue.number).toBeUndefined();
    expect(issue.url).toBe(`${CLOUD_BASE}/browse/PROJ-123`);
  });

  it("omits the description when the caller sends no body", async () => {
    const fetchMock = cloudFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createJiraIssue(params(), token, undefined, CLOUD_ID);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    const sent = JSON.parse(String(postInit.body));
    expect(sent.fields).not.toHaveProperty("description");
    expect(sent.fields).not.toHaveProperty("labels");
  });

  it("creates on Data Center via v2 with a plain-string description", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/createmeta")) {
        return jsonResponse(200, { values: [{ id: "3", name: "Task" }] });
      }
      if (init?.method === "POST") return jsonResponse(201, { id: "10101", key: "PROJ-123" });
      return jsonResponse(200, issuePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const issue = await createJiraIssue(params({ body: "why" }), token, DC_BASE);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${DC_BASE}/rest/api/2/issue/createmeta/PROJ/issuetypes`,
    );
    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body)).fields.description).toBe("why");
    expect(issue.url).toBe(`${DC_BASE}/browse/PROJ-123`);
  });

  it("prefers a type named Task whatever its position", async () => {
    const fetchMock = cloudFetch([
      { id: "10004", name: "Bug" },
      { id: "10001", name: "task" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await createJiraIssue(params(), token, undefined, CLOUD_ID);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body)).fields.issuetype).toEqual({ id: "10001" });
  });

  it("falls back to the first non-subtask type when there is no Task", async () => {
    const fetchMock = cloudFetch([
      { id: "10005", name: "Sub-task", subtask: true },
      { id: "10004", name: "Bug" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    await createJiraIssue(params(), token, undefined, CLOUD_ID);

    const [, postInit] = fetchMock.mock.calls[1] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body)).fields.issuetype).toEqual({ id: "10004" });
  });

  it("falls back to the classic createmeta when the scoped one 404s (DC < 8.4)", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/createmeta/PROJ/issuetypes")) return jsonResponse(404, { message: "nope" });
      if (u.includes("/createmeta")) {
        return jsonResponse(200, { projects: [{ issuetypes: [{ id: "3", name: "Task" }] }] });
      }
      if (init?.method === "POST") return jsonResponse(201, { id: "10101", key: "PROJ-123" });
      return jsonResponse(200, issuePayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    await createJiraIssue(params(), token, DC_BASE);

    const classicUrl = String(fetchMock.mock.calls[1][0]);
    expect(classicUrl).toContain(`${DC_BASE}/rest/api/2/issue/createmeta?`);
    expect(classicUrl).toContain("projectKeys=PROJ");
    expect(classicUrl).toContain("expand=projects.issuetypes");
    const [, postInit] = fetchMock.mock.calls[2] as [string | URL, RequestInit];
    expect(JSON.parse(String(postInit.body)).fields.issuetype).toEqual({ id: "3" });
  });

  it("throws a clear error when the project offers no creatable type", async () => {
    vi.stubGlobal("fetch", cloudFetch([{ id: "10005", name: "Sub-task", subtask: true }]));

    await expect(createJiraIssue(params(), token, undefined, CLOUD_ID)).rejects.toThrow(
      "Jira project PROJ offers no creatable issue types",
    );
  });

  it("propagates a 403 when the token predates the write:jira-work scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/createmeta")
          ? jsonResponse(200, { issueTypes: [{ id: "10001", name: "Task" }] })
          : jsonResponse(403, { errorMessages: ["forbidden"] }),
      ),
    );

    await expect(createJiraIssue(params(), token, undefined, CLOUD_ID)).rejects.toMatchObject({
      status: 403,
    });
  });
});
