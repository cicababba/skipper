import { GITLAB_BASE_URL } from "@skipper/shared";
import { vendorRequest, type VendorHttpConfig } from "../http";
import type { GitLabRateLimit, GitLabTokenProvider } from "./types";

const CONFIG: VendorHttpConfig = {
  vendor: "GitLab",
  rateLimitHeaders: { remaining: "ratelimit-remaining", reset: "ratelimit-reset" },
};

export interface GitLabResponse<T> {
  body: T;
  nextUrl?: string; // from Link rel="next"
  rateLimit?: GitLabRateLimit;
}

/** baseUrl is the instance root (e.g. https://gitlab.com or https://git.corp/gitlab),
 *  not an API base — the adapter appends the versioned API path. */
export function gitlabApiBase(baseUrl?: string): string {
  return `${baseUrl ?? GITLAB_BASE_URL}/api/v4`;
}

async function gitlabRequest<T>(
  method: "GET" | "POST",
  url: string,
  getToken: GitLabTokenProvider,
  body?: unknown,
): Promise<GitLabResponse<T>> {
  const res = await vendorRequest<T>(CONFIG, method, url, getToken, { body });
  return { body: res.body as T, nextUrl: res.nextUrl, rateLimit: res.rateLimit };
}

export async function gitlabGet<T>(
  url: string,
  getToken: GitLabTokenProvider,
): Promise<GitLabResponse<T>> {
  return gitlabRequest<T>("GET", url, getToken);
}

export async function gitlabPost<T>(
  url: string,
  getToken: GitLabTokenProvider,
  body: unknown,
): Promise<GitLabResponse<T>> {
  return gitlabRequest<T>("POST", url, getToken, body);
}
