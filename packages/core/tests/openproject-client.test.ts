import { describe, it, expect, vi, afterEach } from "vitest";
import { openprojectGet } from "../src/adapters/openproject/client";
import { ApiError, AuthError } from "../src/adapters/types";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const token = async () => "tok";
const URL_ = "https://op.example.com/api/v3/work_packages";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openprojectGet", () => {
  it("sends a Bearer authorization header by default", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await openprojectGet<{ id: number }>(URL_, token);
    expect(body).toEqual({ id: 1 });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.accept).toBe("application/json");
  });

  it("wraps the token as HTTP Basic apikey:<token> when authMethod is pat", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await openprojectGet(URL_, token, "pat");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("apikey:tok").toString("base64")}`);
  });

  it("retries once with forceRefresh on 401", async () => {
    const getToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "bad" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await openprojectGet(URL_, getToken);
    expect(body).toEqual({ ok: true });
    expect(getToken).toHaveBeenNthCalledWith(2, true);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe("Bearer fresh");
  });

  it("throws AuthError when 401 survives the refresh", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad" })));
    await expect(openprojectGet(URL_, token)).rejects.toBeInstanceOf(AuthError);
  });

  it("throws ApiError with status on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { message: "boom" })));
    const err = await openprojectGet(URL_, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
  });

  it("surfaces retry-after on 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse(429, { message: "slow down" }, { "retry-after": "30" }),
    ));
    const err = await openprojectGet(URL_, token).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
  });
});
