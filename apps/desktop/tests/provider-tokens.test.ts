import { describe, it, expect } from "vitest";
import { applyRefreshedTokens, type ProviderTokens, type RefreshedTokens } from "../src/auth/provider";

const CURRENT: ProviderTokens = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  idToken: "old-id",
  expiresAt: 1000,
  refreshTokenExpiresAt: 9000,
  scope: "openid",
  tokenType: "Bearer",
};

const REFRESHED: RefreshedTokens = {
  accessToken: "new-access",
  expiresAt: 2000,
};

describe("applyRefreshedTokens", () => {
  it("always takes the new access token and expiry", () => {
    const next = applyRefreshedTokens(CURRENT, REFRESHED, false);
    expect(next.accessToken).toBe("new-access");
    expect(next.expiresAt).toBe(2000);
    expect(next.scope).toBe("openid");
    expect(next.tokenType).toBe("Bearer");
  });

  it("keeps the old refresh token when the provider does not rotate", () => {
    const next = applyRefreshedTokens(CURRENT, { ...REFRESHED, refreshToken: "unexpected" }, false);
    expect(next.refreshToken).toBe("old-refresh");
  });

  it("takes the rotated refresh token and its expiry when the provider rotates", () => {
    const next = applyRefreshedTokens(
      CURRENT,
      { ...REFRESHED, refreshToken: "new-refresh", refreshTokenExpiresAt: 99000 },
      true,
    );
    expect(next.refreshToken).toBe("new-refresh");
    expect(next.refreshTokenExpiresAt).toBe(99000);
  });

  it("keeps the old refresh token when rotation is expected but none returned", () => {
    const next = applyRefreshedTokens(CURRENT, REFRESHED, true);
    expect(next.refreshToken).toBe("old-refresh");
    expect(next.refreshTokenExpiresAt).toBe(9000);
  });

  it("carries the id token over when the refresh omits it", () => {
    expect(applyRefreshedTokens(CURRENT, REFRESHED, false).idToken).toBe("old-id");
    expect(applyRefreshedTokens(CURRENT, { ...REFRESHED, idToken: "new-id" }, false).idToken).toBe("new-id");
  });
});
