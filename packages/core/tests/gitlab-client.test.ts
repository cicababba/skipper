import { describe, it, expect, vi, afterEach } from "vitest";
import { gitlabApiBase, gitlabGet } from "../src/adapters/gitlab/client";
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

describe("gitlabApiBase", () => {
  it("appends /api/v4 to the instance root, defaulting to gitlab.com", () => {
    expect(gitlabApiBase()).toBe("https://gitlab.com/api/v4");
    expect(gitlabApiBase("https://git.corp/gitlab")).toBe("https://git.corp/gitlab/api/v4");
  });
});

describe("gitlabGet", () => {
  it("parses body, next link and rate limit on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(200, [{ id: 1 }], {
        link: '<https://gitlab.com/api/v4/issues?page=2>; rel="next"',
        "ratelimit-remaining": "1999",
        "ratelimit-reset": "1800000000",
      }),
    ));
    const res = await gitlabGet<Array<{ id: number }>>("https://gitlab.com/api/v4/issues", token);
    expect(res.body).toEqual([{ id: 1 }]);
    expect(res.nextUrl).toBe("https://gitlab.com/api/v4/issues?page=2");
    expect(res.rateLimit).toEqual({ remaining: 1999, resetAt: new Date(1800000000 * 1000).toISOString() });
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await gitlabGet("https://gitlab.com/api/v4/user", getToken);
    expect(res.body).toEqual({ ok: true });
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(gitlabGet("https://gitlab.com/api/v4/user", token)).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError without fetching when the token is null", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(gitlabGet("https://gitlab.com/api/v4/user", async () => null)).rejects.toBeInstanceOf(
      AuthError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces retry-after on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": "30" }),
    ));
    const err = await gitlabGet("https://gitlab.com/api/v4/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("computes retry from the rate limit reset on 429 when remaining is 0", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 120;
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(429, { message: "rate limited" }, {
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(resetEpoch),
      }),
    ));
    const err = await gitlabGet("https://gitlab.com/api/v4/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.retryAfterSeconds).toBeGreaterThan(100);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it("throws ApiError with status on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    const err = await gitlabGet("https://gitlab.com/api/v4/issues", token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });
});
