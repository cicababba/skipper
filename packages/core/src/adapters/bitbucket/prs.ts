import { BITBUCKET_API_BASE_URL } from "@skipper/shared";
import type { RepoRef } from "@skipper/shared";
import type { CreatedPr, FailingCheck } from "../types";
import { bitbucketGet, bitbucketPaginate, bitbucketPost } from "./client";
import type {
  BitbucketCommentPayload,
  BitbucketParticipant,
  BitbucketStatusPayload,
} from "./map";
import type { BitbucketTokenProvider } from "./types";

interface CreatedPrPayload {
  id: number;
  links?: { html?: { href?: string } };
}

interface PrDetailPayload {
  participants?: BitbucketParticipant[];
}

export function repoApiUrl(repo: RepoRef): string {
  return `${BITBUCKET_API_BASE_URL}/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Bitbucket PR ids are repo-scoped (id == number) — safe because the orchestrator
 *  dedups on repo + number. */
function toCreatedPr(payload: CreatedPrPayload): CreatedPr {
  return { id: `bitbucket:${payload.id}`, number: payload.id, url: payload.links?.html?.href ?? "" };
}

export async function createPullRequest(
  repo: RepoRef,
  params: { title: string; body: string; head: string; base: string; draft: boolean },
  getToken: BitbucketTokenProvider,
): Promise<CreatedPr> {
  // params.draft is intentionally unused — Bitbucket Cloud has no draft concept.
  const payload = await bitbucketPost<CreatedPrPayload>(
    `${repoApiUrl(repo)}/pullrequests`,
    getToken,
    {
      title: params.title,
      description: params.body,
      source: { branch: { name: params.head } },
      destination: { branch: { name: params.base } },
    },
  );
  return toCreatedPr(payload);
}

/** Bitbucket query language string literal: wrap in quotes, escaping `\` and `"`. */
export function bbqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function findOpenPrByHead(
  repo: RepoRef,
  head: string,
  getToken: BitbucketTokenProvider,
): Promise<CreatedPr | null> {
  const search = new URLSearchParams({
    q: `source.branch.name = ${bbqlString(head)} AND state = "OPEN"`,
    pagelen: "1",
  });
  const page = await bitbucketGet<{ values?: CreatedPrPayload[] }>(
    `${repoApiUrl(repo)}/pullrequests?${search.toString()}`,
    getToken,
  );
  const payload = page.values?.[0];
  return payload ? toCreatedPr(payload) : null;
}

export async function fetchPrParticipants(
  repo: RepoRef,
  id: number,
  getToken: BitbucketTokenProvider,
): Promise<BitbucketParticipant[]> {
  const detail = await bitbucketGet<PrDetailPayload>(
    `${repoApiUrl(repo)}/pullrequests/${id}`,
    getToken,
  );
  return detail.participants ?? [];
}

export function fetchPrComments(
  repo: RepoRef,
  id: number,
  getToken: BitbucketTokenProvider,
): Promise<BitbucketCommentPayload[]> {
  return bitbucketPaginate<BitbucketCommentPayload>(
    `${repoApiUrl(repo)}/pullrequests/${id}/comments?pagelen=100`,
    getToken,
  );
}

export function fetchCommitStatuses(
  repo: RepoRef,
  sha: string,
  getToken: BitbucketTokenProvider,
): Promise<BitbucketStatusPayload[]> {
  return bitbucketPaginate<BitbucketStatusPayload>(
    `${repoApiUrl(repo)}/commit/${sha}/statuses?pagelen=100`,
    getToken,
  );
}

/** Failed/stopped commit statuses feed the CI-fix re-entry prompt. Statuses are
 *  upserted by key, so there is one row per key — no dedupe needed. */
export async function fetchFailingChecks(
  repo: RepoRef,
  sha: string,
  getToken: BitbucketTokenProvider,
): Promise<FailingCheck[]> {
  const statuses = await fetchCommitStatuses(repo, sha, getToken);
  return statuses
    .filter((s) => s.state === "FAILED" || s.state === "STOPPED")
    .map((s) => ({ name: s.name ?? s.key ?? "unnamed check", url: s.url, summary: s.description }));
}
