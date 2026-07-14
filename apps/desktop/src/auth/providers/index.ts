import type { AuthProviderId } from "@skipper/shared";
import type { ProviderConfig } from "../provider";
import { googleProvider } from "./google";
import { githubProvider } from "./github";

export const PROVIDERS: Record<AuthProviderId, ProviderConfig> = {
  google: googleProvider,
  github: githubProvider,
};
