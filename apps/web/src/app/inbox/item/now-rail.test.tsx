import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { LifecycleState, TrackedItem, TransitionEvent } from "@skipper/shared";
import { NowRail } from "./now-rail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/orchestrator-context", () => ({
  useOrchestrator: () => ({
    openPr: vi.fn(),
    requestTransition: vi.fn(),
    closeItemOnTracker: vi.fn(),
    untrackItem: vi.fn(),
    state: { sourceCapabilities: { github: { closeIssue: true } } },
  }),
}));

const PR = { id: "pr-1", number: 42, url: "https://example.test/acme/rocket/pull/42" };

function item(state: LifecycleState, overrides: Partial<TrackedItem> = {}): TrackedItem {
  const transitions: TransitionEvent[] = [{ at: "2026-07-01T00:00:00.000Z", from: null, to: state, actor: "system" }];
  return {
    id: "github:1",
    source: "github",
    key: "42",
    number: 42,
    title: "fix the topbar jump",
    url: "https://example.test/acme/rocket/issues/42",
    state,
    transitions,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as TrackedItem;
}

function installSkipper() {
  const openExternal = vi.fn();
  (window as unknown as { skipper: unknown }).skipper = { openExternal };
  return { openExternal };
}

function renderRail(overrides: Partial<React.ComponentProps<typeof NowRail>> = {}) {
  const props: React.ComponentProps<typeof NowRail> = {
    item: item("in-review", { pr: PR }),
    storedPlan: null,
    totals: null,
    wtStatus: null,
    now: Date.parse("2026-07-01T00:05:00.000Z"),
    onNavigateTab: () => {},
    ...overrides,
  };
  return render(<NowRail {...props} />);
}

const prLink = () => screen.queryByRole("button", { name: /PR #42/ });

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("NowRail — PR link", () => {
  it("renders a PR link for an item that has a PR and opens its url externally", () => {
    const { openExternal } = installSkipper();
    renderRail();

    const link = prLink();
    expect(link).toBeTruthy();

    fireEvent.click(link!);
    expect(openExternal).toHaveBeenCalledWith(PR.url);
  });

  it("renders no PR link when the item has no PR", () => {
    installSkipper();
    renderRail({ item: item("in-review") });

    expect(prLink()).toBeNull();
    expect(screen.getByRole("button", { name: /Open issue on the platform/ })).toBeTruthy();
  });

  it("keeps the PR link in a settled state", () => {
    const { openExternal } = installSkipper();
    renderRail({ item: item("merged", { pr: PR }) });

    fireEvent.click(prLink()!);
    expect(openExternal).toHaveBeenCalledWith(PR.url);
  });
});
