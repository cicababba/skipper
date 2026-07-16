import { ApiError, AuthError } from "../types";
import { parseLinkNext } from "../http";
import type { GitHubRateLimit, GitHubTokenProvider } from "./types";

export { parseLinkNext };

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

export interface GitHubResponse<T> {
  status: 200 | 304;
  body?: T; // undefined on 304
  etag?: string;
  nextUrl?: string; // from Link rel="next"
  rateLimit?: GitHubRateLimit;
}

function parseRateLimit(res: Response): GitHubRateLimit | undefined {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if (remaining == null || reset == null) return undefined;
  return {
    remaining: Number(remaining),
    resetAt: new Date(Number(reset) * 1000).toISOString(),
  };
}

async function githubRequest<T>(
  method: "GET" | "POST",
  url: string,
  getToken: GitHubTokenProvider,
  opts?: { etag?: string; body?: unknown },
): Promise<GitHubResponse<T>> {
  const doFetch = async (token: string) => {
    const headers: Record<string, string> = {
      ...API_HEADERS,
      authorization: `Bearer ${token}`,
    };
    if (opts?.etag) headers["if-none-match"] = opts.etag;
    if (opts?.body !== undefined) headers["content-type"] = "application/json";
    return fetch(url, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };

  const token = await getToken();
  if (!token) throw new AuthError("no GitHub token available");

  let res = await doFetch(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    if (!fresh) throw new AuthError("no GitHub token available after refresh");
    res = await doFetch(fresh);
    if (res.status === 401) {
      throw new AuthError("GitHub rejected the token (401) — re-authentication needed");
    }
  }

  const rateLimit = parseRateLimit(res);

  if (res.status === 304) {
    return { status: 304, etag: res.headers.get("etag") ?? opts?.etag, rateLimit };
  }

  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    let retryAfterSeconds = retryAfter != null ? Number(retryAfter) : undefined;
    if (retryAfterSeconds == null && rateLimit?.remaining === 0) {
      retryAfterSeconds = Math.max(0, Math.ceil((Date.parse(rateLimit.resetAt) - Date.now()) / 1000));
    }
    const text = await res.text().catch(() => "");
    throw new ApiError(
      `GitHub rate limited (${res.status}): ${text}`,
      res.status,
      rateLimit,
      retryAfterSeconds,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`GitHub API error: ${res.status} ${text}`, res.status, rateLimit);
  }

  return {
    status: 200,
    body: (await res.json()) as T,
    etag: res.headers.get("etag") ?? undefined,
    nextUrl: parseLinkNext(res.headers.get("link")),
    rateLimit,
  };
}

export async function githubGet<T>(
  url: string,
  getToken: GitHubTokenProvider,
  opts?: { etag?: string },
): Promise<GitHubResponse<T>> {
  return githubRequest<T>("GET", url, getToken, opts);
}

export async function githubPost<T>(
  url: string,
  getToken: GitHubTokenProvider,
  body: unknown,
): Promise<GitHubResponse<T>> {
  return githubRequest<T>("POST", url, getToken, { body });
}
