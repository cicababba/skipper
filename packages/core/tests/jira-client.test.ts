import { describe, it, expect, vi, afterEach } from "vitest";
import { jiraGet } from "../src/adapters/jira/client";
import { ApiError, AuthError } from "../src/adapters/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const token = async () => "tok";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jiraGet", () => {
  it("parses the JSON body and sends accept: application/json on 200", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "1" }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await jiraGet<{ id: string }>("https://api.atlassian.com/ex/jira/c/rest", token);
    expect(body).toEqual({ id: "1" });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.accept).toBe("application/json");
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await jiraGet("https://api.atlassian.com/ex/jira/c/rest", getToken);
    expect(body).toEqual({ ok: true });
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(jiraGet("https://api.atlassian.com/ex/jira/c/rest", token)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("throws AuthError without fetching when the token is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      jiraGet("https://api.atlassian.com/ex/jira/c/rest", async () => null),
    ).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces retry-after on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": "30" }),
    ));
    const err = await jiraGet("https://api.atlassian.com/ex/jira/c/rest", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("throws ApiError with status on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    const err = await jiraGet("https://api.atlassian.com/ex/jira/c/rest", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  it("treats a 403 with retry-after as a retryable rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(403, { message: "slow down" }, { "retry-after": "90" }),
    ));
    const err = await jiraGet("https://api.atlassian.com/ex/jira/c/rest", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.retryAfterSeconds).toBe(90);
    expect(err.message).toContain("Jira rate limited (403)");
  });

  it("treats a signal-less 403 as a generic API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "forbidden" })));
    const err = await jiraGet("https://api.atlassian.com/ex/jira/c/rest", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("Jira API error: 403");
    expect(err.retryAfterSeconds).toBeUndefined();
  });
});
