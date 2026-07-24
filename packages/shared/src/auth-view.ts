import type {
  Account,
  AuthProviderId,
  AuthState,
  ProviderAccountsView,
  ProviderAuthView,
} from "./types";

/** Collapse the multi-account AuthState into the single-provider view the UI renders. */
export function deriveProviderView(state: AuthState, provider: AuthProviderId): ProviderAuthView {
  const flow = state.flows[provider];
  if (flow?.status === "unconfigured") return { status: "unconfigured" };
  // The glance view stays a spinner while the user picks a site; the settings
  // card reads the full choosing-resource status off the raw flow.
  if (flow?.status === "signing-in" || flow?.status === "choosing-resource") {
    return { status: "signing-in" };
  }
  if (flow?.status === "error") return { status: "error", error: flow.error };

  // Most recently signed-in account represents the provider; later array
  // position wins ties so a fresh sign-in is picked immediately.
  let best: Account | undefined;
  for (const account of state.accounts) {
    if (account.provider !== provider) continue;
    if (!best || (account.signedInAt ?? 0) >= (best.signedInAt ?? 0)) best = account;
  }
  return best ? { status: "signed-in", account: best } : { status: "signed-out" };
}

/** Every account for a provider (connection order) plus its flow — the settings card view. */
export function deriveProviderAccounts(
  state: AuthState,
  provider: AuthProviderId,
): ProviderAccountsView {
  const accounts = state.accounts
    .filter((a) => a.provider === provider)
    .sort((a, b) => (a.signedInAt ?? 0) - (b.signedInAt ?? 0));
  return { accounts, flow: state.flows[provider] ?? { status: "idle" } };
}
