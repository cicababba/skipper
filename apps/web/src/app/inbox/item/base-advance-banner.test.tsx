import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BaseAdvanceNotice, LifecycleState, TrackedItem } from "@skipper/shared";
import { BaseAdvanceBanner } from "./base-advance-banner";

const hoisted = vi.hoisted(() => ({
  requestTransition: vi.fn(async () => ({ ok: true as const, item: {} as TrackedItem })),
}));

vi.mock("@/lib/orchestrator-context", () => ({
  useOrchestrator: () => ({ requestTransition: hoisted.requestTransition }),
}));

function notice(overrides: Partial<BaseAdvanceNotice> = {}): BaseAdvanceNotice {
  return {
    at: "2026-08-07T12:00:00.000Z",
    mergedKeys: ["9"],
    overlapFiles: [],
    reason: "overlap",
    ...overrides,
  };
}

function item(state: LifecycleState, baseAdvance?: BaseAdvanceNotice): TrackedItem {
  return {
    id: "github:1",
    source: "github",
    key: "1",
    number: 1,
    title: "fix the topbar jump",
    url: "https://example.test/acme/rocket/issues/1",
    state,
    transitions: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    baseAdvance,
  } as unknown as TrackedItem;
}

const replanButton = () => screen.queryByRole("button", { name: /Replan on the new base/ });

afterEach(() => {
  vi.clearAllMocks();
});

describe("BaseAdvanceBanner", () => {
  it("renders nothing when the item carries no notice", () => {
    const { container } = render(<BaseAdvanceBanner item={item("plan-gate")} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the merges that advanced the base", () => {
    render(<BaseAdvanceBanner item={item("plan-gate", notice({ mergedKeys: ["9", "PROJ-3"] }))} />);
    expect(screen.getByText("Merged in the meantime: #9, PROJ-3")).toBeTruthy();
  });

  it("lists the plan-cited files the merge also changed", () => {
    render(
      <BaseAdvanceBanner
        item={item("plan-gate", notice({ overlapFiles: ["src/a.ts", "src/b.ts"] }))}
      />,
    );
    expect(screen.getByText("Plan-cited files the merge also changed:")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("lists the citations that stopped resolving on the new base", () => {
    render(
      <BaseAdvanceBanner
        item={item(
          "plan-gate",
          notice({ newMisses: { files: ["src/gone.ts"], symbols: ["oldSym"] } }),
        )}
      />,
    );
    expect(screen.getByText("Citations that no longer resolve on the new base:")).toBeTruthy();
    expect(screen.getByText("src/gone.ts")).toBeTruthy();
    expect(screen.getByText("oldSym")).toBeTruthy();
  });

  it("omits the misses section when the probe found nothing new", () => {
    render(
      <BaseAdvanceBanner
        item={item("plan-gate", notice({ newMisses: { files: [], symbols: [] } }))}
      />,
    );
    expect(screen.queryByText("Citations that no longer resolve on the new base:")).toBeNull();
  });

  it("explains a hand-edited plan instead of offering to overwrite it silently", () => {
    render(<BaseAdvanceBanner item={item("plan-gate", notice({ reason: "edited-plan" }))} />);
    expect(
      screen.getByText("This plan was edited by hand, so it is never replanned automatically."),
    ).toBeTruthy();
  });

  it("explains an in-flight item", () => {
    render(<BaseAdvanceBanner item={item("human-review", notice({ reason: "in-flight" }))} />);
    expect(
      screen.getByText("Work is already in flight here, so nothing was replanned automatically."),
    ).toBeTruthy();
  });

  it("offers Replan where the lifecycle allows it", () => {
    render(<BaseAdvanceBanner item={item("plan-gate", notice())} />);
    expect(replanButton()).toBeTruthy();
  });

  it("hides Replan on a state that cannot reach planning", () => {
    render(<BaseAdvanceBanner item={item("human-review", notice({ reason: "in-flight" }))} />);
    expect(replanButton()).toBeNull();
  });

  it("sends the item back to planning when Replan is pressed", () => {
    render(<BaseAdvanceBanner item={item("plan-gate", notice())} />);
    fireEvent.click(replanButton()!);
    expect(hoisted.requestTransition).toHaveBeenCalledWith(
      "github:1",
      "planning",
      "base advanced — replanning on the new base",
    );
  });

  it("surfaces a refused transition", async () => {
    hoisted.requestTransition.mockResolvedValueOnce({
      ok: false,
      error: "illegal transition",
    } as never);
    render(<BaseAdvanceBanner item={item("plan-gate", notice())} />);
    fireEvent.click(replanButton()!);
    expect(await screen.findByText("illegal transition")).toBeTruthy();
  });
});
