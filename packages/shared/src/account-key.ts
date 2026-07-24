import type { AuthProviderId } from "./types";

/**
 * Globally unique account identity: `provider:id`, or `provider:host:id` for a
 * self-hosted instance. THE account identity everywhere downstream (store key,
 * manifest accountId, orchestrator state, IPC values).
 *
 * baseUrl, when present, must already be normalized (normalizeBaseUrl).
 */
export function accountKey(provider: AuthProviderId, id: string, baseUrl?: string): string {
  return baseUrl ? `${provider}:${new URL(baseUrl).host}:${id}` : `${provider}:${id}`;
}
