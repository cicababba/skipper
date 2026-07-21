import { describe, it, expect } from "vitest";
import { mapJiraIssue, toUtcIso, type JiraIssuePayload } from "../src/adapters/jira/map";

function payload(fields: Partial<JiraIssuePayload["fields"]> = {}): JiraIssuePayload {
  return {
    id: "10001",
    key: "PROJ-7",
    fields: {
      summary: "Do the thing",
      description: "plain description",
      labels: ["backend"],
      components: [{ name: "auth" }],
      assignee: { accountId: "acc-1" },
      reporter: { accountId: "acc-2" },
      status: { statusCategory: { key: "indeterminate" } },
      project: { key: "PROJ" },
      created: "2026-07-01T10:30:00.000+0200",
      updated: "2026-07-02T10:30:00.000+0200",
      ...fields,
    },
  };
}

describe("jira map", () => {
  it("normalizes an offset timestamp to UTC ISO", () => {
    expect(toUtcIso("2026-07-01T10:30:00.000+0200")).toBe("2026-07-01T08:30:00.000Z");
    expect(toUtcIso(undefined)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("maps a Cloud issue: statusCategory, browse url, merged labels+components", () => {
    const issue = mapJiraIssue(payload(), "acct", "https://acme.atlassian.net/");
    expect(issue.id).toBe("jira:10001");
    expect(issue.key).toBe("PROJ-7");
    expect(issue.sourceRef).toEqual({ project: "PROJ", key: "PROJ-7" });
    expect(issue.state).toBe("open"); // statusCategory !== "done"
    expect(issue.labels).toEqual(["backend", "auth"]);
    expect(issue.assignees).toEqual(["acc-1"]);
    expect(issue.author).toBe("acc-2");
    // trailing slash on the base is trimmed before /browse.
    expect(issue.url).toBe("https://acme.atlassian.net/browse/PROJ-7");
    expect(issue.createdAt).toBe("2026-07-01T08:30:00.000Z");
  });

  it("closes an issue whose statusCategory is done", () => {
    const issue = mapJiraIssue(payload({ status: { statusCategory: { key: "done" } } }), "acct", "https://x");
    expect(issue.state).toBe("closed");
  });

  it("resolves user id by accountId → key → name precedence (Cloud vs Data Center)", () => {
    const dc = mapJiraIssue(
      payload({ assignee: { key: "dc-key", name: "dc-name" }, reporter: { name: "only-name" } }),
      "acct",
      "https://x",
    );
    expect(dc.assignees).toEqual(["dc-key"]);
    expect(dc.author).toBe("only-name");
  });

  it("flattens an ADF description and coerces an empty one to undefined", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
    };
    expect(mapJiraIssue(payload({ description: adf }), "acct", "https://x").body).toContain("hello world");
    expect(mapJiraIssue(payload({ description: "" }), "acct", "https://x").body).toBeUndefined();
  });

  it("tolerates missing optional fields", () => {
    const issue = mapJiraIssue(
      { id: "1", key: "P-1", fields: {} },
      "acct",
      "https://x",
    );
    expect(issue.title).toBe("");
    expect(issue.labels).toEqual([]);
    expect(issue.assignees).toEqual([]);
    expect(issue.state).toBe("open");
    expect(issue.sourceRef.project).toBe("");
  });
});
