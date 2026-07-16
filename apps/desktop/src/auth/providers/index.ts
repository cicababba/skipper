import { AUTH_PROVIDER_IDS, type AuthProviderId, type AuthProviderMeta } from "@skipper/shared";
import type { ProviderConfig } from "../provider";
import { googleProvider } from "./google";
import { githubProvider } from "./github";

export const PROVIDERS: Record<AuthProviderId, ProviderConfig> = {
  google: googleProvider,
  github: githubProvider,
};

export function providerMetadata(
  isIssueSource: (id: AuthProviderId) => boolean,
): AuthProviderMeta[] {
  return AUTH_PROVIDER_IDS.map((id) => ({
    id,
    displayName: PROVIDERS[id].displayName,
    isIssueSource: isIssueSource(id),
    requiresBaseUrl: PROVIDERS[id].requiresBaseUrl,
    supportsPat: PROVIDERS[id].supportsPat,
  }));
}
