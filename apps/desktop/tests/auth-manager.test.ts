import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthProviderId } from "@skipper/shared";
import type { ProviderConfig, ProviderTokens } from "../src/auth/provider";
import type { AuthStoreFile } from "../src/auth/store-format";

// manager.ts transitively imports electron (oauth-flow) and the disk store — mock
// both so the manager is unit-testable in plain node.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: vi.fn() },
}));

const storeState: { current: AuthStoreFile | null } = { current: null };
vi.mock("../src/auth/token-store", () => ({
  loadStore: vi.fn(async () => storeState.current),
  saveStore: vi.fn(async (s: AuthStoreFile) => {
    storeState.current = s;
  }),
  clearStore: vi.fn(async () => {
    storeState.current = null;
  }),
  isEncryptionAvailable: () => true,
}));

import { AuthManager } from "../src/auth/manager";

function fakeProvider(id: AuthProviderId): ProviderConfig {
  return {
    id,
    displayName: id,
    authEndpoint: () => "https://auth",
    tokenEndpoint: () => "https://token",
    scopes: [],
    clientId: "real-client-id",
    usesPkce: true,
    rotatesRefreshToken: false,
    requiresRefreshTokenOnExchange: false,
    requiresBaseUrl: false,
    supportsPat: true,
    mapUser: async () => ({ provider: id, id: "x" }),
    revoke: vi.fn(async () => {}),
  };
}

function tokens(access: string): ProviderTokens {
  return {
    accessToken: access,
    refreshToken: "refresh",
    // Far future so getAccessToken never takes the refresh path (no fetch).
    expiresAt: Date.now() + 1_000_000_000,
    scope: "",
    tokenType: "bearer",
  };
}

function seedTwoGitlabAccounts(): void {
  storeState.current = {
    version: 2,
    accounts: {
      "gitlab:42": {
        account: { provider: "gitlab", key: "gitlab:42", id: "42", authMethod: "oauth" },
        tokens: tokens("cloud-access"),
        signedInAt: 100,
      },
      "gitlab:git.corp:42": {
        account: {
          provider: "gitlab",
          key: "gitlab:git.corp:42",
          id: "42",
          baseUrl: "https://git.corp",
          authMethod: "oauth",
        },
        tokens: tokens("corp-access"),
        signedInAt: 200,
      },
    },
  };
}

describe("AuthManager host-scoped identity (#101)", () => {
  let manager: AuthManager;

  beforeEach(async () => {
    seedTwoGitlabAccounts();
    manager = new AuthManager({
      google: fakeProvider("google"),
      github: fakeProvider("github"),
      gitlab: fakeProvider("gitlab"),
    });
    await manager.init();
  });

  it("keeps two same-id accounts on different hosts distinct in getState", () => {
    const keys = manager.getState().accounts.map((a) => a.key);
    expect(new Set(keys)).toEqual(new Set(["gitlab:42", "gitlab:git.corp:42"]));
  });

  it("getAccessToken resolves the self-hosted token by key, not the gitlab.com one", async () => {
    expect(await manager.getAccessToken("gitlab:git.corp:42")).toBe("corp-access");
    expect(await manager.getAccessToken("gitlab:42")).toBe("cloud-access");
  });

  it("signOut removes only the keyed account", async () => {
    await manager.signOut("gitlab:42");
    const keys = manager.getState().accounts.map((a) => a.key);
    expect(keys).toEqual(["gitlab:git.corp:42"]);
    expect(await manager.getAccessToken("gitlab:git.corp:42")).toBe("corp-access");
  });
});
