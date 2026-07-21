import { GITLAB_BASE_URL } from "@skipper/shared";
import type { PrReviewComment, PullRequest, RepoRef } from "@skipper/shared";
import type { CreatedPr, FailingCheck } from "../types";
import { drainLinkPages } from "../http";
import { gitlabApiBase, gitlabGet, gitlabPost } from "./client";
import { ciStatusFromPipeline, type GitLabApprovalsPayload } from "./map";
import type { GitLabTokenProvider } from "./types";

interface CreatedMrPayload {
  id: number;
  iid: number;
  web_url: string;
}

export interface GitLabDiscussionPayload {
  notes?: Array<{
    id: number;
    system?: boolean;
    resolvable?: boolean;
    resolved?: boolean;
    body?: string | null;
    author?: { username: string } | null;
    created_at?: string;
    position?: {
      new_path?: string | null;
      old_path?: string | null;
      new_line?: number | null;
      old_line?: number | null;
    } | null;
  }>;
}

export interface GitLabPipelinePayload {
  id: number;
  status?: string;
}

export interface GitLabJobPayload {
  name?: string;
  web_url?: string;
  failure_reason?: string;
  allow_failure?: boolean;
}

function projectUrl(repo: RepoRef, baseUrl?: string): string {
  const projectPath = encodeURIComponent(`${repo.owner}/${repo.name}`);
  return `${gitlabApiBase(baseUrl)}/projects/${projectPath}`;
}

export async function createMergeRequest(
  repo: RepoRef,
  params: { title: string; body: string; head: string; base: string; draft: boolean },
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<CreatedPr> {
  // GitLab has no draft flag on create — the "Draft:" title prefix is the API
  // convention. Don't double-prefix a title that already carries it.
  const title =
    params.draft && !/^draft:\s/i.test(params.title) ? `Draft: ${params.title}` : params.title;
  const res = await gitlabPost<CreatedMrPayload>(
    `${projectUrl(repo, baseUrl)}/merge_requests`,
    getToken,
    {
      title,
      description: params.body,
      source_branch: params.head,
      target_branch: params.base,
    },
  );
  const payload = res.body;
  return { id: `gitlab:${payload.id}`, number: payload.iid, url: payload.web_url };
}

/** Recovery for "MR already exists" (409 on create): adopt the open MR for this source branch. */
export async function findOpenMrByHead(
  repo: RepoRef,
  head: string,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<CreatedPr | null> {
  const params = new URLSearchParams({ source_branch: head, state: "opened" });
  const res = await gitlabGet<CreatedMrPayload[]>(
    `${projectUrl(repo, baseUrl)}/merge_requests?${params.toString()}`,
    getToken,
  );
  const payload = res.body?.[0];
  if (!payload) return null;
  return { id: `gitlab:${payload.id}`, number: payload.iid, url: payload.web_url };
}

export async function fetchMrApprovals(
  repo: RepoRef,
  iid: number,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<GitLabApprovalsPayload> {
  const res = await gitlabGet<GitLabApprovalsPayload>(
    `${projectUrl(repo, baseUrl)}/merge_requests/${iid}/approvals`,
    getToken,
  );
  return res.body;
}

export function fetchMrDiscussions(
  repo: RepoRef,
  iid: number,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<GitLabDiscussionPayload[]> {
  return drainLinkPages<GitLabDiscussionPayload>(
    `${projectUrl(repo, baseUrl)}/merge_requests/${iid}/discussions?per_page=100`,
    (url) => gitlabGet<GitLabDiscussionPayload[]>(url, getToken),
  );
}

/** A thread is unresolved when it holds a resolvable note that hasn't been resolved. */
export function hasUnresolvedThreads(discussions: GitLabDiscussionPayload[]): boolean {
  return discussions.some((d) => (d.notes ?? []).some((n) => n.resolvable && !n.resolved));
}

/** Human feedback for the fix prompt: notes from unresolved threads, minus system
 *  notes and the PR author's own. */
export function mapDiscussionFeedback(
  discussions: GitLabDiscussionPayload[],
  repo: RepoRef,
  iid: number,
  prAuthor?: string,
  baseUrl?: string,
): PrReviewComment[] {
  const host = baseUrl ?? GITLAB_BASE_URL;
  const out: PrReviewComment[] = [];
  for (const discussion of discussions) {
    const notes = discussion.notes ?? [];
    if (!notes.some((n) => n.resolvable && !n.resolved)) continue;
    for (const note of notes) {
      if (note.system) continue;
      const author = note.author?.username;
      if (author === prAuthor) continue;
      const body = note.body?.trim();
      if (!body) continue;
      out.push({
        author,
        path: note.position?.new_path ?? note.position?.old_path ?? undefined,
        line: note.position?.new_line ?? note.position?.old_line ?? undefined,
        body,
        url: `${host}/${repo.owner}/${repo.name}/-/merge_requests/${iid}#note_${note.id}`,
        submittedAt: note.created_at,
      });
    }
  }
  return out;
}

async function fetchLatestPipeline(
  repo: RepoRef,
  sha: string,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<GitLabPipelinePayload | undefined> {
  const params = new URLSearchParams({ sha, order_by: "id", sort: "desc", per_page: "1" });
  const res = await gitlabGet<GitLabPipelinePayload[]>(
    `${projectUrl(repo, baseUrl)}/pipelines?${params.toString()}`,
    getToken,
  );
  return res.body?.[0];
}

export async function fetchCiStatus(
  repo: RepoRef,
  sha: string,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<PullRequest["ciStatus"]> {
  const pipeline = await fetchLatestPipeline(repo, sha, getToken, baseUrl);
  return ciStatusFromPipeline(pipeline?.status);
}

/** The failed jobs of the latest pipeline for a sha — feeds the CI-fix re-entry prompt. */
export async function fetchFailingChecks(
  repo: RepoRef,
  sha: string,
  getToken: GitLabTokenProvider,
  baseUrl?: string,
): Promise<FailingCheck[]> {
  const pipeline = await fetchLatestPipeline(repo, sha, getToken, baseUrl);
  if (!pipeline) return [];
  const jobs = await drainLinkPages<GitLabJobPayload>(
    `${projectUrl(repo, baseUrl)}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`,
    (url) => gitlabGet<GitLabJobPayload[]>(url, getToken),
  );
  return jobs
    .filter((job) => job.allow_failure !== true)
    .map((job) => ({
      name: job.name ?? "unnamed job",
      url: job.web_url ?? undefined,
      summary: job.failure_reason ?? undefined,
    }));
}
