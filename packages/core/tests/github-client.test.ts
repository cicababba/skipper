import { describe, it, expect, vi, afterEach } from "vitest";
import { githubGet, githubPost, parseLinkNext } from "../src/adapters/github/client";
import { ApiError, AuthError } from "../src/adapters/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const token = async () => "tok";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseLinkNext", () => {
  it("extracts the rel=next url", () => {
    const link =
      '<https://api.github.com/issues?page=2>; rel="next", <https://api.github.com/issues?page=5>; rel="last"';
    expect(parseLinkNext(link)).toBe("https://api.github.com/issues?page=2");
  });

  it("returns undefined without a next rel", () => {
    expect(parseLinkNext('<https://api.github.com/issues?page=1>; rel="prev"')).toBeUndefined();
    expect(parseLinkNext(null)).toBeUndefined();
  });
});

describe("githubGet", () => {
  it("parses body, etag, next link and rate limit on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, [{ id: 1 }], {
        etag: 'W/"abc"',
        link: '<https://api.github.com/issues?page=2>; rel="next"',
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-reset": "1800000000",
      }),
    ));
    const res = await githubGet<Array<{ id: number }>>("https://api.github.com/issues", token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1 }]);
    expect(res.etag).toBe('W/"abc"');
    expect(res.nextUrl).toBe("https://api.github.com/issues?page=2");
    expect(res.rateLimit).toEqual({ remaining: 4999, resetAt: new Date(1800000000 * 1000).toISOString() });
  });

  it("sends if-none-match and returns 304 without body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(304, null));
    vi.stubGlobal("fetch", fetchMock);
    const res = await githubGet("https://api.github.com/issues", token, { etag: 'W/"abc"' });
    expect(res.status).toBe(304);
    expect(res.body).toBeUndefined();
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('W/"abc"');
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await githubGet("https://api.github.com/user", getToken);
    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(githubGet("https://api.github.com/user", token)).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError without fetching when the token is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(githubGet("https://api.github.com/user", async () => null)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces retry-after on 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(403, { message: "slow down" }, { "retry-after": "60" }),
    ));
    const err = await githubGet("https://api.github.com/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("throws ApiError with status on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { message: "Validation Failed" })));
    const err = await githubGet("https://api.github.com/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
  });

  it("computes retry from the rate limit reset when remaining is 0", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(403, { message: "rate limited" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpoch),
      }),
    ));
    const err = await githubGet("https://api.github.com/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.retryAfterSeconds).toBeGreaterThan(100);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(120);
  });
});

describe("githubPost", () => {
  it("sends a JSON body with content-type and parses the created resource", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 7, number: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await githubPost<{ id: number; number: number }>(
      "https://api.github.com/repos/o/r/pulls",
      token,
      { title: "t", head: "feature/issue-3", base: "main", draft: true },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7, number: 3 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string).head).toBe("feature/issue-3");
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await githubPost("https://api.github.com/repos/o/r/pulls", getToken, {});
    expect(res.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
  });

  it("propagates a 422 as ApiError with status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { message: "already exists" })));
    const err = await githubPost("https://api.github.com/repos/o/r/pulls", token, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
  });
});
