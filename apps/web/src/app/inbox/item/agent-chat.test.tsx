import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentChatKind, LifecycleState, PlanChatMessage, PrReviewComment } from "@skipper/shared";
import { AgentChatPanel } from "./agent-chat";

const HISTORY: PlanChatMessage[] = [
  { role: "user", text: "why this refactor?", at: "2026-07-21T09:00:00.000Z" },
  { role: "assistant", text: "because of X", at: "2026-07-21T09:00:01.000Z" },
];

const INSTRUCTIONS: PrReviewComment[] = [{ path: "src/a.ts", body: "extract the helper" }];

function installSkipper(opts: {
  history?: PlanChatMessage[];
  sendResult?: unknown;
  prepareResult?: unknown;
  confirmResult?: unknown;
} = {}) {
  const getHistory = vi.fn().mockResolvedValue(opts.history ?? HISTORY);
  const send = vi
    .fn()
    .mockResolvedValue(opts.sendResult ?? { ok: true, reply: "answer", mode: "resumed" });
  const prepareApply = vi
    .fn()
    .mockResolvedValue(opts.prepareResult ?? { ok: true, instructions: INSTRUCTIONS });
  const confirmApply = vi.fn().mockResolvedValue(opts.confirmResult ?? { ok: true });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const stream = { getEvents: vi.fn().mockResolvedValue([]), onEvent: vi.fn(() => () => {}) };
  (window as unknown as { skipper: unknown }).skipper = {
    agentChat: { getHistory, send, prepareApply, confirmApply, cancel },
    coding: stream,
    review: stream,
  };
  return { getHistory, send, prepareApply, confirmApply };
}

function renderPanel(
  props: { kind?: AgentChatKind; itemState?: LifecycleState; selectedFile?: string | null } = {},
) {
  return render(
    <AgentChatPanel
      kind={props.kind ?? "coder"}
      itemId="item-1"
      itemState={props.itemState ?? "human-review"}
      selectedFile={props.selectedFile}
      onBusyChange={vi.fn()}
    />,
  );
}

async function clickApply() {
  const button = (await screen.findByRole("button", { name: "Apply changes" })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("AgentChatPanel — fresh session notice (#170)", () => {
  it("warns when the agent session was gone and the turn ran fresh", async () => {
    installSkipper({ sendResult: { ok: true, reply: "answer", mode: "fresh" } });
    renderPanel();
    await screen.findByText("because of X");

    fireEvent.change(screen.getByPlaceholderText("Ask about the changes…"), {
      target: { value: "still there?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/The coding session is gone/)).toBeTruthy();
  });

  it("forwards the selected worktree file as turn context", async () => {
    const { send } = installSkipper();
    renderPanel({ selectedFile: "src/a.ts" });
    await screen.findByText("because of X");

    fireEvent.change(screen.getByPlaceholderText("Ask about the changes…"), {
      target: { value: "what is this?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("coder", "item-1", "what is this?", {
        selectedFile: "src/a.ts",
      }),
    );
  });
});

describe("AgentChatPanel — Apply gating (#188)", () => {
  it("offers Apply for the coder at a state that allows re-entry", async () => {
    installSkipper();
    renderPanel({ kind: "coder", itemState: "human-review" });
    expect(await screen.findByRole("button", { name: "Apply changes" })).toBeTruthy();
  });

  it("never offers Apply to the reviewer", async () => {
    installSkipper();
    renderPanel({ kind: "reviewer" });
    await screen.findByText("because of X");
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });

  it("hides Apply on a state that does not allow re-entry", async () => {
    installSkipper();
    renderPanel({ kind: "coder", itemState: "merged" });
    await screen.findByText("because of X");
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });
});

describe("AgentChatPanel — two-phase apply (#188)", () => {
  it("previews the distilled instructions, then confirms them", async () => {
    const { prepareApply, confirmApply } = installSkipper();
    renderPanel();
    await clickApply();

    expect(await screen.findByText("extract the helper")).toBeTruthy();
    expect(prepareApply).toHaveBeenCalledWith("item-1");

    fireEvent.click(screen.getByRole("button", { name: "Send back to coding" }));
    await waitFor(() => expect(confirmApply).toHaveBeenCalledWith("item-1", INSTRUCTIONS));
  });

  it("drops the preview when a new message is sent", async () => {
    installSkipper();
    renderPanel();
    await clickApply();
    await screen.findByText("extract the helper");

    fireEvent.change(screen.getByPlaceholderText("Ask about the changes…"), {
      target: { value: "one more thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.queryByText("extract the helper")).toBeNull());
  });
});
