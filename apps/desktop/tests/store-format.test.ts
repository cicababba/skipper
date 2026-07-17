import { describe, it, expect } from "vitest";
import { accountKey, emptyStore, parseStoreFile, type AuthStoreFile } from "../src/auth/store-format";

const V2_STORE: AuthStoreFile = {
  version: 2,
  accounts: {
    "github:42": {
      account: { provider: "github", id: "42", name: "octo" },
      tokens: {
        accessToken: "ghu_x",
        refreshToken: "ghr_x",
        expiresAt: 1000,
        refreshTokenExpiresAt: 2000,
        scope: "",
        tokenType: "bearer",
      },
      signedInAt: 500,
    },
  },
};

const LEGACY_SESSION = {
  tokens: {
    accessToken: "ya29.x",
    refreshToken: "1//refresh",
    idToken: "eyJ.id",
    expiresAt: 1000,
    scope: "openid email profile",
    tokenType: "Bearer",
  },
  user: { sub: "sub-1", email: "a@b.c", name: "Ada", picture: "https://p" },
  signedInAt: 500,
};

describe("accountKey", () => {
  it("joins provider and id", () => {
    expect(accountKey("google", "sub-1")).toBe("google:sub-1");
  });
});

describe("parseStoreFile", () => {
  it("round-trips a v2 store", () => {
    const parsed = parseStoreFile(JSON.stringify(V2_STORE));
    expect(parsed).toEqual({ store: V2_STORE, migrated: false });
  });

  it("drops a legacy active key on read", () => {
    const withActive = { ...V2_STORE, active: { github: "42" } };
    const parsed = parseStoreFile(JSON.stringify(withActive));
    expect(parsed).toEqual({ store: V2_STORE, migrated: false });
    expect("active" in parsed!.store).toBe(false);
  });

  it("migrates a legacy single-session file to a google account", () => {
    const parsed = parseStoreFile(JSON.stringify(LEGACY_SESSION));
    expect(parsed?.migrated).toBe(true);
    const store = parsed!.store;
    expect(store.version).toBe(2);
    expect("active" in store).toBe(false);
    const stored = store.accounts["google:sub-1"];
    expect(stored.account).toEqual({
      provider: "google",
      id: "sub-1",
      email: "a@b.c",
      name: "Ada",
      avatarUrl: "https://p",
    });
    expect(stored.tokens.idToken).toBe("eyJ.id");
    expect(stored.tokens.refreshToken).toBe("1//refresh");
    expect(stored.signedInAt).toBe(500);
  });

  it("rejects garbage", () => {
    expect(parseStoreFile("not json")).toBeNull();
    expect(parseStoreFile("42")).toBeNull();
    expect(parseStoreFile("null")).toBeNull();
    expect(parseStoreFile(JSON.stringify({ something: "else" }))).toBeNull();
    expect(parseStoreFile(JSON.stringify({ tokens: {}, user: {} }))).toBeNull();
  });

  it("emptyStore is a valid v2 store", () => {
    const parsed = parseStoreFile(JSON.stringify(emptyStore()));
    expect(parsed).toEqual({ store: emptyStore(), migrated: false });
  });
});
