import { describe, it, expect } from "vitest";
import { deriveProviderView } from "../src/auth-view";
import type { Account, AuthState } from "../src/types";

const google: Account = { provider: "google", id: "sub-1", email: "a@b.c", name: "Ada" };
const github: Account = { provider: "github", id: "42", name: "octo" };

function state(partial: Partial<AuthState>): AuthState {
  return { accounts: [], active: {}, flows: {}, ...partial };
}

describe("deriveProviderView", () => {
  it("returns signed-out for an empty state", () => {
    expect(deriveProviderView(state({}), "google")).toEqual({ status: "signed-out" });
  });

  it("returns signed-in with the active account", () => {
    const s = state({ accounts: [google], active: { google: "sub-1" } });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: google });
  });

  it("returns signed-out when the active id points to a missing account", () => {
    const s = state({ accounts: [], active: { google: "gone" } });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-out" });
  });

  it("unconfigured wins over everything", () => {
    const s = state({
      accounts: [google],
      active: { google: "sub-1" },
      flows: { google: { status: "unconfigured" } },
    });
    expect(deriveProviderView(s, "google")).toEqual({ status: "unconfigured" });
  });

  it("passes signing-in and error through", () => {
    expect(
      deriveProviderView(state({ flows: { google: { status: "signing-in" } } }), "google"),
    ).toEqual({ status: "signing-in" });
    expect(
      deriveProviderView(state({ flows: { google: { status: "error", error: "boom" } } }), "google"),
    ).toEqual({ status: "error", error: "boom" });
  });

  it("providers are independent", () => {
    const s = state({
      accounts: [google, github],
      active: { google: "sub-1", github: "42" },
      flows: { github: { status: "signing-in" } },
    });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: google });
    expect(deriveProviderView(s, "github")).toEqual({ status: "signing-in" });
  });
});
