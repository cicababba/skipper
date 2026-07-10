import type { AuthProviderId } from "@nestbrain/shared";
import type { ProviderConfig } from "../provider";
import { googleProvider } from "./google";
import { githubProvider } from "./github";

export const PROVIDERS: Record<AuthProviderId, ProviderConfig> = {
  google: googleProvider,
  github: githubProvider,
};
