import { describe, it, expect } from "vitest";
import {
  accountCandidates,
  deriveAccount,
  ASSIGN_CAPABLE_PROVIDERS,
  CREATE_CAPABLE_PROVIDERS,
} from "./derive-account";

const accounts = [
  { key: "github:1", provider: "github" as const },
  { key: "github:2", provider: "github" as const },
  { key: "jira:9", provider: "jira" as const },
];

const item = (accountId: string, repo = "acme/widgets") => {
  const [owner, name] = repo.split("/");
  return { accountId, repo: { owner, name } };
};

describe("accountCandidates", () => {
  it("puts the account tracking most items in this repo first", () => {
    const candidates = accountCandidates({
      accounts,
      items: [item("github:2"), item("github:2"), item("github:1")],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual(["github:2", "github:1", "jira:9"]);
  });

  it("ignores items from other repos", () => {
    const candidates = accountCandidates({
      accounts,
      items: [item("github:2", "other/repo"), item("github:1")],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual(["github:1", "github:2", "jira:9"]);
  });

  it("falls back to every create-capable account when nothing is tracked", () => {
    expect(accountCandidates({ accounts, items: [], repoKey: "acme/widgets" })).toEqual([
      "github:1",
      "github:2",
      "jira:9",
    ]);
  });

  // #274: every tracker adapter now implements createIssue, so a Jira account
  // that owns the repo's items is a first-class candidate.
  it("ranks a tracker account that owns the repo's items first", () => {
    const candidates = accountCandidates({
      accounts,
      items: [item("jira:9"), item("jira:9")],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual(["jira:9", "github:1", "github:2"]);
  });

  it("still drops accounts on providers that cannot create issues", () => {
    const candidates = accountCandidates({
      accounts: [...accounts, { key: "google:7", provider: "google" as const }],
      items: [],
      repoKey: "acme/widgets",
    });
    expect(candidates).not.toContain("google:7");
  });

  it("returns nothing when no connected account can create", () => {
    const only = { accounts: [{ key: "google:7", provider: "google" as const }], items: [], repoKey: "acme/widgets" };
    expect(accountCandidates(only)).toEqual([]);
    expect(deriveAccount(only)).toBeUndefined();
  });
});

describe("deriveAccount", () => {
  it("preselects the best candidate", () => {
    expect(
      deriveAccount({ accounts, items: [item("github:2")], repoKey: "acme/widgets" }),
    ).toBe("github:2");
  });
});

describe("capability lists", () => {
  it("counts every tracker provider as create-capable", () => {
    expect([...CREATE_CAPABLE_PROVIDERS].sort()).toEqual([
      "bitbucket",
      "github",
      "gitlab",
      "jira",
      "openproject",
    ]);
    expect(CREATE_CAPABLE_PROVIDERS).not.toContain("google");
  });

  // Only GitHub and GitLab resolve a username at create time; the rest would
  // silently drop the assignee, so the UI hides the option instead.
  it("limits assign-at-create to GitHub and GitLab", () => {
    expect([...ASSIGN_CAPABLE_PROVIDERS].sort()).toEqual(["github", "gitlab"]);
    for (const provider of ASSIGN_CAPABLE_PROVIDERS) {
      expect(CREATE_CAPABLE_PROVIDERS).toContain(provider);
    }
  });
});
