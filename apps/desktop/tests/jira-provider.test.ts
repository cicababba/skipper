import { describe, it, expect, vi, afterEach } from "vitest";
import type { ResourceCandidate } from "@skipper/shared";
import {
  listJiraResources,
  mapJiraUser,
  mapJiraDataCenterUser,
} from "../src/auth/providers/jira";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const acme: ResourceCandidate = {
  id: "cloud-1",
  name: "Acme",
  url: "https://acme.atlassian.net",
};

describe("listJiraResources", () => {
  it("maps accessible-resources and keeps only Jira-scoped sites", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, [
        {
          id: "cloud-1",
          name: "Acme",
          url: "https://acme.atlassian.net",
          scopes: ["read:jira-work"],
          avatarUrl: "https://avatars/acme",
        },
        {
          id: "cloud-2",
          name: "Confluence Only",
          url: "https://conf.atlassian.net",
          scopes: ["read:confluence-content.summary"],
        },
      ]),
    ));
    await expect(listJiraResources("tok")).resolves.toEqual([
      { id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", avatarUrl: "https://avatars/acme" },
    ]);
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(listJiraResources("tok")).rejects.toThrow("Jira accessible-resources failed (401)");
  });
});

describe("mapJiraUser", () => {
  it("maps /myself for the chosen site with the cloudId and site baseUrl", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        accountId: "acc-9",
        emailAddress: "ada@acme.com",
        displayName: "Ada Lovelace",
        avatarUrls: { "48x48": "https://avatars/48" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(mapJiraUser("tok", undefined, acme)).resolves.toEqual({
      provider: "jira",
      id: "acc-9",
      email: "ada@acme.com",
      name: "Ada Lovelace",
      avatarUrl: "https://avatars/48",
      baseUrl: "https://acme.atlassian.net",
      cloudId: "cloud-1",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/myself",
    );
  });

  it("throws without a resource (no cloudId to route through)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(mapJiraUser("tok")).rejects.toThrow("Jira sign-in requires a site selection");
  });

  it("throws on a non-OK /myself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "nope" })));
    await expect(mapJiraUser("tok", undefined, acme)).rejects.toThrow("Jira /myself failed (403)");
  });

  it("leaves email undefined when the profile hides it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, { accountId: "acc-9", displayName: "Ada" }),
    ));
    const account = await mapJiraUser("tok", undefined, acme);
    expect(account.email).toBeUndefined();
  });
});

describe("mapJiraDataCenterUser", () => {
  it("maps the v2 /myself with the user key and no cloudId", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        key: "JIRAUSER1",
        name: "ada",
        emailAddress: "ada@corp.internal",
        displayName: "Ada",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const account = await mapJiraDataCenterUser("pat", "https://jira.corp");
    expect(account).toEqual({
      provider: "jira",
      id: "JIRAUSER1",
      email: "ada@corp.internal",
      name: "Ada",
      avatarUrl: undefined,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://jira.corp/rest/api/2/myself");
  });

  it("falls back to name when key is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, { name: "ada", displayName: "Ada" }),
    ));
    const account = await mapJiraDataCenterUser("pat", "https://jira.corp");
    expect(account.id).toBe("ada");
  });

  it("requires an instance URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(mapJiraDataCenterUser("pat")).rejects.toThrow("A valid instance URL is required");
  });
});
