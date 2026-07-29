import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickView } from "./quick-view";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ owner: "acme", name: "widgets" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authState: { accounts: [{ key: "github:1", provider: "github" }], flows: {} } }),
}));

vi.mock("@/lib/orchestrator-context", () => ({
  useOrchestrator: () => ({ state: { items: [], accounts: {} } }),
}));

const REPO = { owner: "acme", name: "widgets" };

function installSkipper(opts: { created?: unknown } = {}) {
  const start = vi.fn().mockResolvedValue({ ok: true, chatId: "chat-1" });
  const getSelfLogin = vi.fn().mockResolvedValue({ login: "cicababba" });
  const createIssueOnTracker = vi.fn().mockResolvedValue(
    opts.created ?? {
      ok: true,
      id: "12",
      number: 12,
      url: "https://github.com/acme/widgets/issues/12",
    },
  );
  (window as unknown as { skipper: unknown }).skipper = {
    composer: {
      start,
      getChat: vi.fn().mockResolvedValue({ messages: [] }),
      send: vi.fn(),
      generateDraft: vi.fn(),
      updateDraft: vi.fn(),
      dispose: vi.fn(),
      cancel: vi.fn(),
      getSelfLogin,
      getEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
    },
    orchestrator: { createIssueOnTracker },
    openExternal: vi.fn(),
  };
  return { start, getSelfLogin, createIssueOnTracker };
}

function renderQuick() {
  const onSwitch = vi.fn();
  render(<QuickView repo={REPO} mode="quick" onSwitch={onSwitch} />);
  return { onSwitch };
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function clickCreate() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
  window.localStorage.clear();
});

describe("QuickView", () => {
  it("opens on an empty card without starting a composer session", () => {
    const { start } = installSkipper();
    renderQuick();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe("");
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps what the user types", () => {
    installSkipper();
    renderQuick();
    type("Title", "web:fix: the topbar jumps");
    type("Body", "It shifts by a pixel on hover.");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "web:fix: the topbar jumps",
    );
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe(
      "It shifts by a pixel on hover.",
    );
  });

  it("posts the rendered body and reports the created issue", async () => {
    const { createIssueOnTracker, getSelfLogin } = installSkipper();
    renderQuick();
    type("Title", "web:fix: the topbar jumps");
    type("Body", "It shifts by a pixel on hover.");
    fireEvent.click(screen.getByRole("button", { name: "Add criterion" }));
    type("Acceptance criteria 1", "no shift at any zoom");

    await clickCreate();

    expect(createIssueOnTracker).toHaveBeenCalledWith({
      accountId: "github:1",
      repo: REPO,
      title: "web:fix: the topbar jumps",
      body: "It shifts by a pixel on hover.\n\n## Acceptance criteria\n\n- [ ] no shift at any zoom",
      labels: [],
    });
    // Self-assign is off by default: no login lookup, no assignees on the call.
    expect(getSelfLogin).not.toHaveBeenCalled();
    expect(await screen.findByText("#12 created")).toBeTruthy();
    expect(screen.getByText("Every issue was created.")).toBeTruthy();
  });

  it("assigns the issue to the user when self-assign is on", async () => {
    const { createIssueOnTracker, getSelfLogin } = installSkipper();
    renderQuick();
    type("Title", "web:fix: the topbar jumps");
    fireEvent.click(screen.getByRole("checkbox"));

    await clickCreate();

    expect(getSelfLogin).toHaveBeenCalledWith("github:1");
    expect(createIssueOnTracker.mock.calls[0][0].assignees).toEqual(["cicababba"]);
  });

  it("keeps a rejected issue editable and retryable", async () => {
    const { createIssueOnTracker } = installSkipper({ created: { ok: false, error: "boom" } });
    renderQuick();
    type("Title", "web:fix: the topbar jumps");

    await clickCreate();

    expect(await screen.findByText("Creation failed")).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(false);

    createIssueOnTracker.mockResolvedValue({
      ok: true,
      id: "13",
      number: 13,
      url: "https://github.com/acme/widgets/issues/13",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(await screen.findByText("#13 created")).toBeTruthy();
  });

  // Switching away discards the local draft — it never round-trips to main.
  it("confirms before leaving a card that has content", async () => {
    installSkipper();
    const { onSwitch } = renderQuick();
    type("Title", "web:fix: the topbar jumps");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.getByText("Discard this issue?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("chat"));
  });

  it("switches straight away when the card is empty", () => {
    installSkipper();
    const { onSwitch } = renderQuick();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onSwitch).toHaveBeenCalledWith("chat");
    expect(screen.queryByText("Discard this issue?")).toBeNull();
  });

  it("cancelling the switch keeps the draft", () => {
    installSkipper();
    const { onSwitch } = renderQuick();
    type("Title", "web:fix: the topbar jumps");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSwitch).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "web:fix: the topbar jumps",
    );
  });
});
