import { JIRA_OAUTH_ENDPOINTS } from "@skipper/shared";
import { vendorRequest, type VendorHttpConfig } from "../http";
import type { JiraTokenProvider } from "./types";

const CONFIG: VendorHttpConfig = {
  vendor: "Jira",
  baseHeaders: { accept: "application/json" },
};

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

export async function jiraGet<T>(url: string, getToken: JiraTokenProvider): Promise<T> {
  return (await vendorRequest<T>(CONFIG, "GET", url, getToken)).body as T;
}

export async function jiraPost<T>(
  url: string,
  getToken: JiraTokenProvider,
  body: unknown,
): Promise<T> {
  return (await vendorRequest<T>(CONFIG, "POST", url, getToken, { body })).body as T;
}
