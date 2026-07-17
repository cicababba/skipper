import { JIRA_OAUTH_ENDPOINTS } from "@skipper/shared";
import { ApiError, AuthError } from "../types";
import type { JiraTokenProvider } from "./types";

/** Where a Jira account's REST API lives: Cloud routes via api.atlassian.com with
 *  a cloudId; Data Center hits the instance base URL directly. */
export interface JiraTarget {
  cloudId?: string;
  baseUrl?: string;
}

/** API root (no trailing /rest) for a Jira target. Cloud takes precedence when a
 *  cloudId is present; otherwise the Data Center base URL. */
export function jiraApiBase(target: JiraTarget): string {
  if (target.cloudId) return JIRA_OAUTH_ENDPOINTS.apiBase(target.cloudId);
  if (target.baseUrl) return target.baseUrl;
  throw new Error("Jira target requires a cloudId (Cloud) or baseUrl (Data Center)");
}

async function jiraRequest<T>(url: string, getToken: JiraTokenProvider): Promise<T> {
  const doFetch = (token: string) =>
    fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });

  const token = await getToken();
  if (!token) throw new AuthError("no Jira token available");

  let res = await doFetch(token);
  if (res.status === 401) {
    const fresh = await getToken(true);
    if (!fresh) throw new AuthError("no Jira token available after refresh");
    res = await doFetch(fresh);
    if (res.status === 401) {
      throw new AuthError("Jira rejected the token (401) — re-authentication needed");
    }
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfter != null ? Number(retryAfter) : undefined;
    const text = await res.text().catch(() => "");
    throw new ApiError(`Jira rate limited (429): ${text}`, 429, undefined, retryAfterSeconds);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(`Jira API error: ${res.status} ${text}`, res.status);
  }

  return (await res.json()) as T;
}

export async function jiraGet<T>(url: string, getToken: JiraTokenProvider): Promise<T> {
  return jiraRequest<T>(url, getToken);
}
