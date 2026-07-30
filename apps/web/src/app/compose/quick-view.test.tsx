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

/** A resumed quick draft comes back without a transcript — the card is all of it. */
const RESUMED_CARD = {
  messages: [],
  draft: {
    issues: [
      {
        title: "web:fix: the topbar jumps",
        body: "It shifts by a pixel on hover.",
        acceptanceCriteria: [],
        labels: [],
      },
    ],
    relations: [],
  },
};

function installSkipper(opts: { created?: unknown; chat?: unknown } = {}) {
  const start = vi.fn().mockResolvedValue({ ok: true, chatId: "chat-1" });
  const resume = vi.fn().mockResolvedValue({ ok: true, chatId: "draft-3", unfinished: true });
  const dispose = vi.fn().mockResolvedValue(undefined);
  const updateDraft = vi.fn().mockResolvedValue({ ok: true });
  const remove = vi.fn().mockResolvedValue({ ok: true });
  const getSelfLogin = vi.fn().mockResolvedValue({ login: "cicababba" });
  const createIssueOnTracker = vi.fn().mockResolvedValue(
    opts.created ?? {
      ok: true,
      id: "12",
      key: "12",
      number: 12,
      url: "https://github.com/acme/widgets/issues/12",
    },
  );
  const getChat = vi.fn().mockResolvedValue(opts.chat ?? { messages: [] });
  (window as unknown as { skipper: unknown }).skipper = {
    composer: {
      start,
      resume,
      getChat,
      send: vi.fn(),
      generateDraft: vi.fn(),
      updateDraft,
      dispose,
      cancel: vi.fn(),
      getSelfLogin,
      getEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
    },
    drafts: { list: vi.fn().mockResolvedValue([]), remove, onChanged: vi.fn(() => () => {}) },
    orchestrator: { createIssueOnTracker },
    openExternal: vi.fn(),
  };
  return { start, resume, getChat, updateDraft, dispose, remove, getSelfLogin, createIssueOnTracker };
}

function renderQuick(draftId?: string) {
  const onSwitch = vi.fn();
  const view = render(
    <QuickView repo={REPO} mode="quick" onSwitch={onSwitch} draftId={draftId ?? null} />,
  );
  return { onSwitch, view };
}

/** The push to main is debounced (500ms) — let it land inside act so a pending
 *  timer never updates state after the test. */
async function flushDraftPush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
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
      key: "13",
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

// Quick borrows the composer record (#272) for one reason: so an abandoned card
// survives. Nothing else about the path changes.
describe("QuickView unfinished drafts", () => {
  it("starts a session on the first edit and pushes the card after the debounce", async () => {
    const { start, updateDraft } = installSkipper();
    renderQuick();
    expect(start).not.toHaveBeenCalled();

    type("Title", "web:fix: the topbar jumps");

    await waitFor(() => expect(start).toHaveBeenCalledWith(REPO));
    await flushDraftPush();
    const [, chatId, draft] = updateDraft.mock.calls.at(-1) as [
      unknown,
      string,
      { issues: { title: string }[] },
    ];
    expect(chatId).toBe("chat-1");
    expect(draft.issues[0].title).toBe("web:fix: the topbar jumps");
  });

  // An unlinked repo has no record to hold the card; creating issues is still
  // the point of the page, so it must keep working.
  it("keeps the create flow working when the session cannot start", async () => {
    const { start, updateDraft, createIssueOnTracker } = installSkipper();
    start.mockResolvedValue({ ok: false, error: "repo not linked" });
    renderQuick();

    type("Title", "web:fix: the topbar jumps");
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    type("Body", "It shifts by a pixel on hover.");
    await flushDraftPush();

    // A failed start is remembered, not retried on every keystroke.
    expect(start).toHaveBeenCalledTimes(1);
    expect(updateDraft).not.toHaveBeenCalled();

    await clickCreate();
    expect(createIssueOnTracker).toHaveBeenCalled();
    expect(await screen.findByText("#12 created")).toBeTruthy();
  });

  it("resumes an unfinished quick draft prefilled, without starting a new session", async () => {
    const { start, resume, getChat } = installSkipper({ chat: RESUMED_CARD });
    renderQuick("draft-3");

    await waitFor(() => expect(resume).toHaveBeenCalledWith(REPO, "draft-3"));
    expect(start).not.toHaveBeenCalled();
    await waitFor(() => expect(getChat).toHaveBeenCalledWith(REPO, "draft-3"));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "web:fix: the topbar jumps",
    );
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe(
      "It shifts by a pixel on hover.",
    );
    await flushDraftPush();
  });

  it("says so when the resume fails", async () => {
    const { resume } = installSkipper();
    resume.mockResolvedValue({ ok: false, error: "unknown draft" });
    renderQuick("draft-3");

    await waitFor(() => expect(resume).toHaveBeenCalledWith(REPO, "draft-3"));
    expect(
      await screen.findByText("The composer could not start: unknown draft"),
    ).toBeTruthy();
  });

  it("leaves the abandoned card to main's capture on a plain unmount", async () => {
    const { start, dispose } = installSkipper();
    const { view } = renderQuick();
    type("Title", "web:fix: the topbar jumps");
    await waitFor(() => expect(start).toHaveBeenCalled());
    await flushDraftPush();

    view.unmount();

    await waitFor(() => expect(dispose).toHaveBeenCalledWith(REPO, "chat-1", undefined));
  });

  it("discards the session when the user confirms leaving for chat", async () => {
    const { start, dispose } = installSkipper();
    const { onSwitch, view } = renderQuick();
    type("Title", "web:fix: the topbar jumps");
    await waitFor(() => expect(start).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("chat"));
    await flushDraftPush();
    view.unmount();

    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith(REPO, "chat-1", { discard: true }),
    );
  });

  it("removes the draft it resumed once every issue reached the tracker", async () => {
    const { remove, dispose } = installSkipper({ chat: RESUMED_CARD });
    const { view } = renderQuick("draft-3");
    await waitFor(() =>
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
        "web:fix: the topbar jumps",
      ),
    );

    await clickCreate();

    expect(await screen.findByText("#12 created")).toBeTruthy();
    await waitFor(() => expect(remove).toHaveBeenCalledWith("draft-3"));
    await flushDraftPush();
    view.unmount();
    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith(REPO, "draft-3", { discard: true }),
    );
  });
});
