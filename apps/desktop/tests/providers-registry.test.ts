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
        isIssueSource: false,
        requiresBaseUrl: false,
        supportsPat: true,
        patRequiresBaseUrl: true,
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
    expect(jira.rotatesRefreshToken).toBe(true);
    expect(jira.requiresBaseUrl).toBe(false);
    expect(jira.patRequiresBaseUrl).toBe(true);
    expect(jira.extraAuthParams).toEqual({ audience: "api.atlassian.com", prompt: "consent" });
    expect(typeof jira.listResources).toBe("function");
  });
});
