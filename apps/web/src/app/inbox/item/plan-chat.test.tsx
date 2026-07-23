import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlanChatMessage, StoredPlan } from "@skipper/shared";
import { PlanChatPanel } from "./plan-chat";

const STORED: StoredPlan = {
  version: 2,
  itemId: "item-1",
  repo: { owner: "octo", name: "repo" },
  generatedAt: "2026-07-21T00:00:00.000Z",
  model: "claude",
  plan: {
    summary: "s",
    files: [],
    steps: [],
    acceptance: [],
    risks: [],
    openQuestions: [],
    estimatedSize: "s",
  },
};

function installSkipper(opts: {
  history: PlanChatMessage[];
  historyAfterApply?: PlanChatMessage[];
  applyResult?:
    | { ok: true; stored: StoredPlan }
    | { ok: false; error?: string; cancelled?: boolean };
}) {
  const getHistory = vi.fn();
  getHistory.mockResolvedValueOnce(opts.history);
  getHistory.mockResolvedValue(opts.historyAfterApply ?? opts.history);
  const apply = vi.fn().mockResolvedValue(opts.applyResult ?? { ok: false });
  const send = vi.fn().mockResolvedValue({ ok: true, reply: "reply" });
  const planning = {
    getEvents: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn(() => () => {}),
  };
  (window as unknown as { skipper: unknown }).skipper = {
    planChat: { getHistory, send, apply },
    planning,
  };
  return { getHistory, apply, send };
}

function renderPanel(props: Partial<React.ComponentProps<typeof PlanChatPanel>> = {}) {
  return render(
    <PlanChatPanel
      itemId="item-1"
      disabled={false}
      onPlanUpdated={props.onPlanUpdated ?? vi.fn()}
      onBusyChange={props.onBusyChange ?? vi.fn()}
      onCountChange={props.onCountChange}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("PlanChatPanel — applied marker (#201)", () => {
  it("renders an applied marker as a centered chip with the change count", async () => {
    installSkipper({
      history: [
        { role: "user", text: "change X", at: "2026-07-21T09:00:00.000Z" },
        { kind: "applied", changeCount: 3, at: "2026-07-21T09:01:00.000Z" },
      ],
    });
    renderPanel();
    expect(await screen.findByText(/Changes applied — 3 changes/)).toBeTruthy();
  });

  it("reports only the text-message count to onCountChange, ignoring markers", async () => {
    const onCountChange = vi.fn();
    installSkipper({
      history: [
        { role: "user", text: "q", at: "2026-07-21T09:00:00.000Z" },
        { role: "assistant", text: "a", at: "2026-07-21T09:00:01.000Z" },
        { kind: "applied", changeCount: 4, at: "2026-07-21T09:01:00.000Z" },
      ],
    });
    renderPanel({ onCountChange });
    await screen.findByText(/Changes applied — 4 changes/);
    expect(onCountChange).toHaveBeenLastCalledWith(2);
    expect(onCountChange).not.toHaveBeenCalledWith(3);
  });
});

describe("PlanChatPanel — apply refetches history (#201)", () => {
  it("refetches the transcript after a successful apply and renders the new marker", async () => {
    const onPlanUpdated = vi.fn();
    const { apply, getHistory } = installSkipper({
      history: [
        { role: "user", text: "change X", at: "2026-07-21T09:00:00.000Z" },
        { role: "assistant", text: "sure", at: "2026-07-21T09:00:01.000Z" },
      ],
      historyAfterApply: [
        { role: "user", text: "change X", at: "2026-07-21T09:00:00.000Z" },
        { role: "assistant", text: "sure", at: "2026-07-21T09:00:01.000Z" },
        { kind: "applied", changeCount: 5, at: "2026-07-21T09:02:00.000Z" },
      ],
      applyResult: { ok: true, stored: STORED },
    });
    renderPanel({ onPlanUpdated });

    await screen.findByText("change X");
    fireEvent.click(screen.getByRole("button", { name: "Update plan from discussion" }));

    expect(await screen.findByText(/Changes applied — 5 changes/)).toBeTruthy();
    expect(apply).toHaveBeenCalledWith("item-1");
    expect(getHistory).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onPlanUpdated).toHaveBeenCalledWith(STORED));
  });
});
