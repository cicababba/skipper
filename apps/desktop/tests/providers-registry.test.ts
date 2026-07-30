import { describe, it, expect } from "vitest";
import { AUTH_PROVIDER_IDS } from "@skipper/shared";
import { issueSourceForAuthProvider } from "@skipper/core";
import { PROVIDERS, providerMetadata } from "../src/auth/providers";

describe("provider registry", () => {
  it("registers every declared provider id under its own key", () => {
    for (const id of AUTH_PROVIDER_IDS) {
      expect(PROVIDERS[id].id).toBe(id);
    }
  });

  it("derives the renderer metadata rows from the registries", () => {
    const rows = providerMetadata((id) => issueSourceForAuthProvider(id) !== undefined);
    expect(rows).toEqual([
      { id: "google", displayName: "Google", isIssueSource: false, requiresBaseUrl: false, supportsPat: false },
      { id: "github", displayName: "GitHub", isIssueSource: true, requiresBaseUrl: false, supportsPat: false },
      {
        id: "gitlab",
        displayName: "GitLab",
        isIssueSource: true,
        requiresBaseUrl: true,
        defaultBaseUrl: "https://gitlab.com",
        supportsPat: true,
      },
      {
        id: "jira",
        displayName: "Jira",
        isIssueSource: true,
        requiresBaseUrl: false,
        supportsPat: true,
        patRequiresBaseUrl: true,
        needsProjectMapping: true,
      },
      {
        id: "bitbucket",
        displayName: "Bitbucket",
        // #274: Bitbucket became an issue source, not just a code host.
        isIssueSource: true,
        requiresBaseUrl: false,
        supportsPat: false,
      },
      {
        id: "openproject",
        displayName: "OpenProject",
        isIssueSource: true,
        requiresBaseUrl: true,
        supportsPat: true,
        needsProjectMapping: true,
        clientIdFromUser: true,
      },
    ]);
  });

  it("configures the gitlab provider as a public PKCE client with rotating refresh tokens", () => {
    const gitlab = PROVIDERS.gitlab;
    expect(gitlab.usesPkce).toBe(true);
    expect(gitlab.clientSecret).toBeUndefined();
    expect(gitlab.rotatesRefreshToken).toBe(true);
    expect(gitlab.redirectPorts).toEqual([8130, 8131, 8132]);
  });

  it("configures the jira provider for Atlassian 3LO (no PKCE, JSON body, audience/prompt, port 8133)", () => {
    const jira = PROVIDERS.jira;
    expect(jira.usesPkce).toBe(false);
    expect(jira.tokenRequestFormat).toBe("json");
    expect(jira.redirectPorts).toEqual([8133]);
    expect(jira.scopes).toContain("offline_access");
    // write:jira-work (#274) — issue creation; existing accounts must reconnect for it.
    expect(jira.scopes).toContain("write:jira-work");
    expect(jira.rotatesRefreshToken).toBe(true);
    expect(jira.requiresBaseUrl).toBe(false);
    expect(jira.patRequiresBaseUrl).toBe(true);
    expect(jira.extraAuthParams).toEqual({ audience: "api.atlassian.com", prompt: "consent" });
    expect(typeof jira.listResources).toBe("function");
  });

  it("configures the bitbucket provider (no PKCE, Basic token auth, rotating refresh, port 8134)", () => {
    const bitbucket = PROVIDERS.bitbucket;
    expect(bitbucket.usesPkce).toBe(false);
    expect(bitbucket.clientSecret).toBeDefined();
    expect(bitbucket.tokenAuth).toBe("basic");
    expect(bitbucket.rotatesRefreshToken).toBe(true);
    expect(bitbucket.requiresRefreshTokenOnExchange).toBe(true);
    expect(bitbucket.redirectPorts).toEqual([8134]);
    // issue:write (#274) — issue creation; existing accounts must reconnect for it.
    expect(bitbucket.scopes).toEqual([
      "repository",
      "pullrequest:write",
      "issue:write",
      "account",
    ]);
    expect(bitbucket.requiresBaseUrl).toBe(false);
    expect(bitbucket.supportsPat).toBe(false);
    expect(bitbucket.revoke).toBeUndefined();
  });

  it("configures the openproject provider (self-hosted public PKCE client, user client id, ports 8135-8137)", () => {
    const op = PROVIDERS.openproject;
    expect(op.usesPkce).toBe(true);
    expect(op.clientSecret).toBeUndefined();
    expect(op.clientId).toBe("");
    expect(op.clientIdFromUser).toBe(true);
    expect(op.rotatesRefreshToken).toBe(true);
    expect(op.requiresRefreshTokenOnExchange).toBe(true);
    expect(op.redirectPorts).toEqual([8135, 8136, 8137]);
    expect(op.scopes).toEqual(["api_v3"]);
    expect(op.requiresBaseUrl).toBe(true);
    expect(op.needsProjectMapping).toBe(true);
    expect(op.supportsPat).toBe(true);
    expect(op.revoke).toBeUndefined();
    expect(op.listResources).toBeUndefined();
  });
});
