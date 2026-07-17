import { describe, it, expect } from "vitest";
import { deriveProviderAccounts, deriveProviderView } from "../src/auth-view";
import type { Account, AuthState } from "../src/types";

const google: Account = { provider: "google", id: "sub-1", email: "a@b.c", name: "Ada" };
const github: Account = { provider: "github", id: "42", name: "octo" };

function state(partial: Partial<AuthState>): AuthState {
  return { accounts: [], flows: {}, ...partial };
}

describe("deriveProviderView", () => {
  it("returns signed-out for an empty state", () => {
    expect(deriveProviderView(state({}), "google")).toEqual({ status: "signed-out" });
  });

  it("returns signed-in with the provider's account", () => {
    const s = state({ accounts: [google] });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: google });
  });

  it("picks the most recently signed-in account", () => {
    const older: Account = { ...google, id: "old", signedInAt: 100 };
    const newer: Account = { ...google, id: "new", signedInAt: 200 };
    const s = state({ accounts: [older, newer] });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: newer });
  });

  it("later array position wins on a signedInAt tie or absence", () => {
    const first: Account = { ...google, id: "first" };
    const second: Account = { ...google, id: "second" };
    const s = state({ accounts: [first, second] });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: second });
  });

  it("unconfigured wins over everything", () => {
    const s = state({
      accounts: [google],
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
      flows: { github: { status: "signing-in" } },
    });
    expect(deriveProviderView(s, "google")).toEqual({ status: "signed-in", account: google });
    expect(deriveProviderView(s, "github")).toEqual({ status: "signing-in" });
  });
});

describe("deriveProviderAccounts", () => {
  it("returns no accounts and an idle flow for an empty state", () => {
    expect(deriveProviderAccounts(state({}), "google")).toEqual({
      accounts: [],
      flow: { status: "idle" },
    });
  });

  it("filters to the provider and sorts ascending by signedInAt", () => {
    const a: Account = { ...google, id: "a", signedInAt: 300 };
    const b: Account = { ...google, id: "b", signedInAt: 100 };
    const c: Account = { ...google, id: "c", signedInAt: 200 };
    const s = state({ accounts: [a, github, b, c] });
    const view = deriveProviderAccounts(s, "google");
    expect(view.accounts.map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(view.flow).toEqual({ status: "idle" });
  });

  it("returns existing rows alongside a signing-in flow", () => {
    const s = state({ accounts: [google], flows: { google: { status: "signing-in" } } });
    const view = deriveProviderAccounts(s, "google");
    expect(view.accounts).toEqual([google]);
    expect(view.flow).toEqual({ status: "signing-in" });
  });

  it("passes unconfigured and error flows through", () => {
    expect(deriveProviderAccounts(state({ flows: { google: { status: "unconfigured" } } }), "google").flow).toEqual({
      status: "unconfigured",
    });
    expect(deriveProviderAccounts(state({ flows: { google: { status: "error", error: "x" } } }), "google").flow).toEqual({
      status: "error",
      error: "x",
    });
  });
});
