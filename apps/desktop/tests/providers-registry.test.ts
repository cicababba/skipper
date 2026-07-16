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
      { id: "google", displayName: "Google", isIssueSource: false },
      { id: "github", displayName: "GitHub", isIssueSource: true },
    ]);
  });
});
