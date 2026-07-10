import type { AuthProviderId, AuthState, ProviderAuthView } from "./types";

/** Collapse the multi-account AuthState into the single-provider view the UI renders. */
export function deriveProviderView(state: AuthState, provider: AuthProviderId): ProviderAuthView {
  const flow = state.flows[provider];
  if (flow?.status === "unconfigured") return { status: "unconfigured" };
  if (flow?.status === "signing-in") return { status: "signing-in" };
  if (flow?.status === "error") return { status: "error", error: flow.error };

  const activeId = state.active[provider];
  if (activeId) {
    const account = state.accounts.find((a) => a.provider === provider && a.id === activeId);
    if (account) return { status: "signed-in", account };
  }
  return { status: "signed-out" };
}
