import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AuthProviderId, ResourceCandidate } from "@skipper/shared";
import { OAuthError, type ProviderConfig, type ProviderTokens } from "../src/auth/provider";
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

// Drive sign-in without a real browser roundtrip: runOAuthFlow just hands back
// tokens; the manager orchestrates resource resolution + mapUser on top.
const { runOAuthFlowMock } = vi.hoisted(() => ({ runOAuthFlowMock: vi.fn() }));
vi.mock("../src/auth/oauth-flow", () => ({
  runOAuthFlow: runOAuthFlowMock,
  refreshTokens: vi.fn(),
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

import { refreshTokens } from "../src/auth/oauth-flow";
import { AuthManager } from "../src/auth/manager";

const refreshMock = vi.mocked(refreshTokens);

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
      jira: fakeProvider("jira"),
      bitbucket: fakeProvider("bitbucket"),
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

const acme: ResourceCandidate = { id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net" };
const globex: ResourceCandidate = { id: "cloud-2", name: "Globex", url: "https://globex.atlassian.net" };

function jiraProvider(candidates: ResourceCandidate[]): ProviderConfig {
  return {
    ...fakeProvider("jira"),
    requiresBaseUrl: false,
    patRequiresBaseUrl: true,
    listResources: async () => candidates,
    mapUser: async (_token, _baseUrl, resource) => {
      if (!resource) throw new Error("no resource");
      return { provider: "jira", id: "acc-9", baseUrl: resource.url, cloudId: resource.id };
    },
    mapUserFromPat: async (_pat, baseUrl) => ({ provider: "jira", id: "dc-1", baseUrl }),
  };
}

function makeManager(jira: ProviderConfig): AuthManager {
  return new AuthManager({
    google: fakeProvider("google"),
    github: fakeProvider("github"),
    gitlab: fakeProvider("gitlab"),
    jira,
    bitbucket: fakeProvider("bitbucket"),
  });
}

describe("AuthManager jira resource resolution (#77)", () => {
  beforeEach(() => {
    storeState.current = { version: 2, accounts: {} };
    runOAuthFlowMock.mockReset();
    runOAuthFlowMock.mockResolvedValue({
      accessToken: "jira-access",
      refreshToken: "jira-refresh",
      expiresAt: Date.now() + 1_000_000_000,
      scope: "",
      tokenType: "bearer",
    });
  });

  it("auto-picks the only accessible site and stores it host-scoped with a cloudId", async () => {
    const manager = makeManager(jiraProvider([acme]));
    await manager.init();
    await manager.signIn("jira");

    const accounts = manager.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].key).toBe("jira:acme.atlassian.net:acc-9");
    expect(accounts[0].cloudId).toBe("cloud-1");
    expect(accounts[0].baseUrl).toBe("https://acme.atlassian.net");
    expect(manager.getState().flows.jira).toBeUndefined();
  });

  it("errors when no sites are accessible", async () => {
    const manager = makeManager(jiraProvider([]));
    await manager.init();
    await manager.signIn("jira");
    expect(manager.getState().flows.jira?.status).toBe("error");
    expect(manager.getState().accounts).toHaveLength(0);
  });

  it("prompts a site choice with several sites, ignores stale ids, completes on a valid pick", async () => {
    const manager = makeManager(jiraProvider([acme, globex]));
    await manager.init();
    const done = manager.signIn("jira");
    await vi.waitFor(() => expect(manager.getState().flows.jira?.status).toBe("choosing-resource"));

    // Unknown id is ignored — the pick stays open.
    manager.chooseResource("jira", "does-not-exist");
    expect(manager.getState().flows.jira?.status).toBe("choosing-resource");

    manager.chooseResource("jira", "cloud-2");
    await done;

    const accounts = manager.getState().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].key).toBe("jira:globex.atlassian.net:acc-9");
    expect(accounts[0].cloudId).toBe("cloud-2");
  });

  it("cancelling mid-pick aborts the sign-in and clears the pending choice", async () => {
    const manager = makeManager(jiraProvider([acme, globex]));
    await manager.init();
    const done = manager.signIn("jira");
    await vi.waitFor(() => expect(manager.getState().flows.jira?.status).toBe("choosing-resource"));

    manager.cancelSignIn("jira");
    await done;
    expect(manager.getState().accounts).toHaveLength(0);
    // A late pick after cancel is a no-op (pending was cleared).
    manager.chooseResource("jira", "cloud-1");
    expect(manager.getState().accounts).toHaveLength(0);
  });

  it("ignores a second signIn while a site pick is open", async () => {
    const jira = jiraProvider([acme, globex]);
    const listSpy = vi.spyOn(jira, "listResources");
    const manager = makeManager(jira);
    await manager.init();
    const done = manager.signIn("jira");
    await vi.waitFor(() => expect(manager.getState().flows.jira?.status).toBe("choosing-resource"));

    await manager.signIn("jira"); // busy — no-op
    expect(runOAuthFlowMock).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(1);

    manager.chooseResource("jira", "cloud-1");
    await done;
    expect(manager.getState().accounts).toHaveLength(1);
  });

  it("rejects a PAT sign-in without an instance URL on a patRequiresBaseUrl provider", async () => {
    const manager = makeManager(jiraProvider([acme]));
    await manager.init();
    await manager.signInWithPat("jira", "some-token");
    expect(manager.getState().flows.jira?.status).toBe("error");
    expect(manager.getState().accounts).toHaveLength(0);
  });
});

// An expiry inside REFRESH_LEAD_MS forces getAccessToken down the refresh path.
function expiredTokens(access: string): ProviderTokens {
  return { accessToken: access, refreshToken: "refresh-0", expiresAt: Date.now(), scope: "", tokenType: "bearer" };
}

function seedGithubAccount(): void {
  storeState.current = {
    version: 2,
    accounts: {
      "github:1": {
        account: { provider: "github", key: "github:1", id: "1", authMethod: "oauth" },
        tokens: expiredTokens("stale-access"),
        signedInAt: 100,
      },
    },
  };
}

describe("AuthManager token refresh dedup + failure classification (B1/B2)", () => {
  let manager: AuthManager;

  beforeEach(async () => {
    seedGithubAccount();
    refreshMock.mockReset();
    const github = { ...fakeProvider("github"), rotatesRefreshToken: true };
    manager = new AuthManager({
      google: fakeProvider("google"),
      github,
      gitlab: fakeProvider("gitlab"),
      jira: fakeProvider("jira"),
      bitbucket: fakeProvider("bitbucket"),
    });
    await manager.init();
  });

  it("coalesces concurrent refreshes onto a single in-flight request (B1)", async () => {
    let resolveRefresh: (v: unknown) => void = () => {};
    refreshMock.mockImplementation(() => new Promise((res) => (resolveRefresh = res)));

    const a = manager.getAccessToken("github:1");
    const b = manager.getAccessToken("github:1");
    // Both callers park on the one pending refresh — the single-use token is
    // fetched exactly once, not raced.
    expect(refreshMock).toHaveBeenCalledTimes(1);

    resolveRefresh({ accessToken: "fresh-access", expiresAt: Date.now() + 1_000_000_000, refreshToken: "refresh-1" });
    expect(await a).toBe("fresh-access");
    expect(await b).toBe("fresh-access");
  });

  it("clears the in-flight entry so a subsequent refresh runs again", async () => {
    // Each refresh returns an already-expired token, so the next call must refresh anew.
    refreshMock.mockResolvedValue({ accessToken: "a1", expiresAt: Date.now(), refreshToken: "r1" });
    await manager.getAccessToken("github:1");
    await manager.getAccessToken("github:1");
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it("rotates and persists the refresh token on success", async () => {
    refreshMock.mockResolvedValue({ accessToken: "fresh", expiresAt: Date.now() + 1_000_000_000, refreshToken: "rotated" });
    expect(await manager.getAccessToken("github:1")).toBe("fresh");
    expect(storeState.current!.accounts["github:1"].tokens.accessToken).toBe("fresh");
    expect(storeState.current!.accounts["github:1"].tokens.refreshToken).toBe("rotated");
  });

  it("drops the account on an invalid_grant / HTTP 400 refresh failure (B2)", async () => {
    refreshMock.mockRejectedValue(new OAuthError("refused", undefined, { status: 400, oauthCode: "invalid_grant" }));
    expect(await manager.getAccessToken("github:1")).toBeNull();
    expect(manager.getState().accounts).toHaveLength(0);
  });

  it("drops the account on a 200-with-error invalid_grant body (B2)", async () => {
    refreshMock.mockRejectedValue(new OAuthError("refused", undefined, { oauthCode: "invalid_grant" }));
    expect(await manager.getAccessToken("github:1")).toBeNull();
    expect(manager.getState().accounts).toHaveLength(0);
  });

  it("keeps the account on a transient 5xx refresh failure (B2)", async () => {
    refreshMock.mockRejectedValue(new OAuthError("bad gateway", undefined, { status: 502 }));
    expect(await manager.getAccessToken("github:1")).toBeNull();
    expect(manager.getState().accounts.map((a) => a.key)).toEqual(["github:1"]);
  });

  it("keeps the account on a network error with no status (B2)", async () => {
    refreshMock.mockRejectedValue(new OAuthError("fetch failed"));
    expect(await manager.getAccessToken("github:1")).toBeNull();
    expect(manager.getState().accounts).toHaveLength(1);
  });
});
