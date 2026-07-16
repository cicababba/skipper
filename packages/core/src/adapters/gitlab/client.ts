import { GITLAB_BASE_URL } from "@skipper/shared";
import { ApiError, AuthError } from "../types";
import { parseLinkNext } from "../http";
import type { GitLabRateLimit, GitLabTokenProvider } from "./types";

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

function parseRateLimit(res: Response): GitLabRateLimit | undefined {
  const remaining = res.headers.get("ratelimit-remaining");
  const reset = res.headers.get("ratelimit-reset");
  if (remaining == null || reset == null) return undefined;
  return {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000).toISOString(),
  };
}

async function gitlabRequest<T>(
  method: "GET" | "POST",
  url: string,
  getToken: GitLabTokenProvider,
  body?: unknown,
): Promise<GitLabResponse<T>> {
  const doFetch = async (token: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  const token = await getToken();
  if (!token) throw new AuthError("no GitLab token available");

  let res = await doFetch(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    if (!fresh) throw new AuthError("no GitLab token available after refresh");
    res = await doFetch(fresh);
    if (res.status === 401) {
      throw new AuthError("GitLab rejected the token (401) — re-authentication needed");
    }
  }

  const rateLimit = parseRateLimit(res);

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    let retryAfterSeconds = retryAfter != null ? Number(retryAfter) : undefined;
    if (retryAfterSeconds == null && rateLimit?.remaining === 0) {
      retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1000));
    }
    const text = await res.text().catch(() => "");
    throw new ApiError(`GitLab rate limited (429): ${text}`, 429, rateLimit, retryAfterSeconds);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`GitLab API error: ${res.status} ${text}`, res.status, rateLimit);
  }

  return {
    body: (await res.json()) as T,
    nextUrl: parseLinkNext(res.headers.get("link")),
    rateLimit,
  };
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
