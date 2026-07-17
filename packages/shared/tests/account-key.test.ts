import { describe, it, expect } from "vitest";
import { accountKey } from "../src/account-key";

describe("accountKey", () => {
  it("joins provider and id when no baseUrl", () => {
    expect(accountKey("google", "sub-1")).toBe("google:sub-1");
    expect(accountKey("github", "42")).toBe("github:42");
  });

  it("host-scopes a self-hosted account", () => {
    expect(accountKey("gitlab", "42", "https://git.corp")).toBe("gitlab:git.corp:42");
  });

  it("uses only the host of a baseUrl with a subpath", () => {
    expect(accountKey("gitlab", "42", "https://git.corp/gitlab")).toBe("gitlab:git.corp:42");
  });

  it("keeps a non-default port in the host segment", () => {
    expect(accountKey("gitlab", "42", "https://git.corp:8443")).toBe("gitlab:git.corp:8443:42");
  });

  it("host-scopes a jira cloud account by its atlassian.net site", () => {
    expect(accountKey("jira", "acc-9", "https://acme.atlassian.net")).toBe(
      "jira:acme.atlassian.net:acc-9",
    );
  });
});
