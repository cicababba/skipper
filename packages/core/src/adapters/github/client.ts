import { parseLinkNext, vendorRequest, type VendorHttpConfig } from "../http";
import type { GitHubRateLimit, GitHubTokenProvider } from "./types";

export { parseLinkNext };

const CONFIG: VendorHttpConfig = {
  vendor: "GitHub",
  baseHeaders: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  },
  rateLimitHeaders: { remaining: "x-ratelimit-remaining", reset: "x-ratelimit-reset" },
  supportsEtag: true,
};

export interface GitHubResponse<T> {
  status: 200 | 304;
  body?: T; // undefined on 304
  etag?: string;
  nextUrl?: string; // from Link rel="next"
  rateLimit?: GitHubRateLimit;
}

export async function githubGet<T>(
  url: string,
  getToken: GitHubTokenProvider,
  opts?: { etag?: string },
): Promise<GitHubResponse<T>> {
  return vendorRequest<T>(CONFIG, "GET", url, getToken, opts);
}

export async function githubPost<T>(
  url: string,
  getToken: GitHubTokenProvider,
  body: unknown,
): Promise<GitHubResponse<T>> {
  return vendorRequest<T>(CONFIG, "POST", url, getToken, { body });
}

export async function githubPatch<T>(
  url: string,
  getToken: GitHubTokenProvider,
  body: unknown,
): Promise<GitHubResponse<T>> {
  return vendorRequest<T>(CONFIG, "PATCH", url, getToken, { body });
}
