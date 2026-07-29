// Which account posts the composed issues (#136). The user picks only when the
// answer is genuinely ambiguous: the account that already owns tracked items in
// this repo is the obvious one, and there is usually exactly one.

import type { AuthProviderId } from "@skipper/shared";

/**
 * Auth providers whose issue source implements createIssue. Hardcoded rather
 * than derived: the renderer's capability map is keyed by IssueSourceId, and the
 * only create-capable adapter is the GitHub one
 * (packages/core/src/adapters/github/source.ts:17). Add a provider here when its
 * adapter grows createIssue.
 */
export const CREATE_CAPABLE_PROVIDERS: readonly AuthProviderId[] = ["github"];

export interface AccountCandidateInput {
  /** Connected accounts, in the order the auth layer reports them. */
  accounts: { key: string; provider: AuthProviderId }[];
  /** Tracked items, used only for their (accountId, repo) pairs. */
  items: { accountId: string; repo: { owner: string; name: string } }[];
  /** The repo being composed for, as `owner/name`. */
  repoKey: string;
}

function keyOf(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

/**
 * Candidate account keys, best first: accounts that already track items in this
 * repo (most items first), then every other create-capable account. Accounts on
 * providers that cannot create issues never appear.
 */
export function accountCandidates(input: AccountCandidateInput): string[] {
  const capable = new Map(
    input.accounts
      .filter((a) => CREATE_CAPABLE_PROVIDERS.includes(a.provider))
      .map((a) => [a.key, a] as const),
  );
  const counts = new Map<string, number>();
  for (const item of input.items) {
    if (keyOf(item.repo) !== input.repoKey || !capable.has(item.accountId)) continue;
    counts.set(item.accountId, (counts.get(item.accountId) ?? 0) + 1);
  }
  const tracked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const rest = [...capable.keys()].filter((key) => !counts.has(key));
  return [...tracked, ...rest];
}

/** The account to preselect — the first candidate, or undefined when none can create. */
export function deriveAccount(input: AccountCandidateInput): string | undefined {
  return accountCandidates(input)[0];
}
