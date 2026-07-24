import { describe, expect, it } from "vitest";
import { inboxGate, type InboxGateInput } from "./gate";

function input(overrides: Partial<InboxGateInput> = {}): InboxGateInput {
  return {
    isElectron: true,
    authLoaded: true,
    issueAccounts: 1,
    orchestrator: { accounts: 1, items: 3 },
    ...overrides,
  };
}

describe("inboxGate", () => {
  it("returns desktop-only outside Electron regardless of everything else", () => {
    expect(inboxGate(input({ isElectron: false, orchestrator: null }))).toBe("desktop-only");
    expect(inboxGate(input({ isElectron: false }))).toBe("desktop-only");
  });

  it("loads while auth has not settled — even with zero accounts (the #192 flash)", () => {
    expect(inboxGate(input({ authLoaded: false, issueAccounts: 0 }))).toBe("loading");
  });

  it("loads while the orchestrator snapshot is missing", () => {
    expect(inboxGate(input({ orchestrator: null }))).toBe("loading");
  });

  it("shows the connect CTA only when auth settled with zero issue-source accounts", () => {
    expect(inboxGate(input({ issueAccounts: 0 }))).toBe("connect");
    expect(
      inboxGate(input({ issueAccounts: 0, orchestrator: { accounts: 0, items: 0 } })),
    ).toBe("connect");
  });

  it("keeps loading while the first poll is pending and nothing is persisted", () => {
    expect(inboxGate(input({ orchestrator: { accounts: 0, items: 0 } }))).toBe("loading");
  });

  it("shows persisted items even before the first poll lands", () => {
    expect(inboxGate(input({ orchestrator: { accounts: 0, items: 5 } }))).toBe("content");
  });

  it("shows no-items once the poll landed with an empty queue", () => {
    expect(inboxGate(input({ orchestrator: { accounts: 2, items: 0 } }))).toBe("no-items");
  });

  it("shows content in the steady state", () => {
    expect(inboxGate(input())).toBe("content");
  });
});
