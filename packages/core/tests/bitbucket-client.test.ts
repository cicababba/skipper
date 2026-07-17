import { describe, it, expect, vi, afterEach } from "vitest";
import { bitbucketGet, bitbucketPaginate } from "../src/adapters/bitbucket/client";
import { ApiError, AuthError } from "../src/adapters/types";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const token = async () => "tok";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bitbucketGet", () => {
  it("parses the JSON body on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { id: 1 })));
    const body = await bitbucketGet<{ id: number }>("https://api.bitbucket.org/2.0/user", token);
    expect(body).toEqual({ id: 1 });
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { type: "error", error: { message: "bad" } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await bitbucketGet("https://api.bitbucket.org/2.0/user", getToken);
    expect(body).toEqual({ ok: true });
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: { message: "bad" } })));
    await expect(
      bitbucketGet("https://api.bitbucket.org/2.0/user", token),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError without fetching when the token is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      bitbucketGet("https://api.bitbucket.org/2.0/user", async () => null),
    ).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Retry-After on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "3600" }),
    ));
    const err = await bitbucketGet("https://api.bitbucket.org/2.0/user", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(3600);
  });

  it("surfaces the error envelope message on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(500, { type: "error", error: { message: "boom" } }),
    ));
    const err = await bitbucketGet("https://api.bitbucket.org/2.0/user", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
  });

  it("falls back to the raw text when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("plain failure", { status: 502, headers: { "content-type": "text/plain" } }),
    ));
    const err = await bitbucketGet("https://api.bitbucket.org/2.0/user", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toContain("plain failure");
  });
});

describe("bitbucketPaginate", () => {
  it("follows the next link across pages and stops when it is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { values: [{ id: 1 }], next: "https://api.bitbucket.org/2.0/next" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { values: [{ id: 2 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const all = await bitbucketPaginate<{ id: number }>(
      "https://api.bitbucket.org/2.0/first",
      token,
    );
    expect(all).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.bitbucket.org/2.0/next");
  });
});
