import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProviderConfig } from "../src/auth/provider";

// oauth-flow imports `shell` from electron — stub it so the module loads in node.
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

import { refreshTokens } from "../src/auth/oauth-flow";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function baseConfig(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "jira",
    displayName: "Jira",
    authEndpoint: () => "https://auth",
    tokenEndpoint: () => "https://token",
    scopes: [],
    clientId: "cid",
    usesPkce: false,
    rotatesRefreshToken: true,
    requiresRefreshTokenOnExchange: true,
    requiresBaseUrl: false,
    supportsPat: false,
    mapUser: async () => ({ provider: "jira", id: "x" }),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Both grants route through the same tokenRequest(); refresh exercises the
// body-encoding branch (exchange shares it verbatim).
describe("tokenRequest body encoding", () => {
  it("sends a JSON body + content-type when tokenRequestFormat is json", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "a", expires_in: 3600, refresh_token: "r" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = baseConfig({ tokenRequestFormat: "json", clientSecret: "sec" });

    await refreshTokens(config, "old-refresh");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "cid",
      client_secret: "sec",
      refresh_token: "old-refresh",
      grant_type: "refresh_token",
    });
  });

  it("defaults to a form-encoded body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "a", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = baseConfig({});

    await refreshTokens(config, "old-refresh");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe("cid");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends HTTP Basic auth and omits client credentials from the body when tokenAuth is basic", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "a", expires_in: 3600, refresh_token: "r" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = baseConfig({ tokenAuth: "basic", clientSecret: "sec" });

    await refreshTokens(config, "old-refresh");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const expected = `Basic ${Buffer.from("cid:sec").toString("base64")}`;
    expect((init.headers as Record<string, string>).authorization).toBe(expected);
    const params = new URLSearchParams(init.body as string);
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
  });
});
