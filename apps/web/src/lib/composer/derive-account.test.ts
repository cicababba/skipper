import { describe, it, expect } from "vitest";
import { accountCandidates, deriveAccount } from "./derive-account";

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
    expect(candidates).toEqual(["github:2", "github:1"]);
  });

  it("ignores items from other repos", () => {
    const candidates = accountCandidates({
      accounts,
      items: [item("github:2", "other/repo"), item("github:1")],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual(["github:1", "github:2"]);
  });

  it("falls back to every create-capable account when nothing is tracked", () => {
    expect(accountCandidates({ accounts, items: [], repoKey: "acme/widgets" })).toEqual([
      "github:1",
      "github:2",
    ]);
  });

  // A tracker without createIssue can never post the draft, so it must not be
  // offered — not even when it owns every item in the repo.
  it("drops accounts on providers that cannot create issues", () => {
    const candidates = accountCandidates({
      accounts,
      items: [item("jira:9"), item("jira:9")],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual(["github:1", "github:2"]);
  });

  it("returns nothing when no connected account can create", () => {
    const candidates = accountCandidates({
      accounts: [{ key: "jira:9", provider: "jira" }],
      items: [],
      repoKey: "acme/widgets",
    });
    expect(candidates).toEqual([]);
    expect(deriveAccount({ accounts: [{ key: "jira:9", provider: "jira" }], items: [], repoKey: "acme/widgets" })).toBeUndefined();
  });
});

describe("deriveAccount", () => {
  it("preselects the best candidate", () => {
    expect(
      deriveAccount({ accounts, items: [item("github:2")], repoKey: "acme/widgets" }),
    ).toBe("github:2");
  });
});
