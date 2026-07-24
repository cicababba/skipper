import { describe, it, expect, vi, afterEach } from "vitest";
import { listJiraProjects } from "../src/adapters/jira/projects";
import { ApiError, AuthError } from "../src/adapters/types";

const token = async () => "tok";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listJiraProjects — Cloud", () => {
  const target = { cloudId: "cid" };

  it("walks startAt/isLast pagination across two pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [{ id: "1", key: "PROJ", name: "Project" }],
          isLast: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { values: [{ id: "2", key: "OPS", name: "Ops" }], isLast: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listJiraProjects(token, target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.atlassian.com/ex/jira/cid/rest/api/3/project/search?startAt=0&maxResults=50",
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain("startAt=1");
    expect(projects).toEqual([
      { id: "1", key: "PROJ", name: "Project" },
      { id: "2", key: "OPS", name: "Ops" },
    ]);
  });

  it("stops when a page returns no values even without isLast", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { values: [{ id: "1", key: "PROJ", name: "Project" }] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { values: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listJiraProjects(token, target);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(projects).toEqual([{ id: "1", key: "PROJ", name: "Project" }]);
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(200, { values: [], isLast: true }));
    vi.stubGlobal("fetch", fetchMock);

    await listJiraProjects(getToken, target);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(listJiraProjects(token, target)).rejects.toBeInstanceOf(AuthError);
  });

  it("surfaces retry-after on 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { message: "slow down" }, { "retry-after": "42" })),
    );
    const err = await listJiraProjects(token, target).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(42);
  });
});

describe("listJiraProjects — Data Center", () => {
  it("reads the full array from the v2 endpoint at the instance base URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe("https://jira.corp/rest/api/2/project");
        return jsonResponse(200, [
          { id: "10", key: "DC", name: "Data Center" },
          { id: "11", key: "INFRA", name: "Infra" },
        ]);
      }),
    );
    const projects = await listJiraProjects(token, { baseUrl: "https://jira.corp" });
    expect(projects).toEqual([
      { id: "10", key: "DC", name: "Data Center" },
      { id: "11", key: "INFRA", name: "Infra" },
    ]);
  });
});
