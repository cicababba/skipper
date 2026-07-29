import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComposerDraft } from "@skipper/shared";
import { ComposerView } from "./composer-view";

const BARE_PARAMS = { owner: "acme", name: "widgets" };
let searchParams = new URLSearchParams(BARE_PARAMS);
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace }),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ authState: { accounts: [{ key: "github:1", provider: "github" }], flows: {} } }),
}));

vi.mock("@/lib/orchestrator-context", () => ({
  useOrchestrator: () => ({ state: { items: [], accounts: {} } }),
}));

const DRAFT: ComposerDraft = {
  issues: [
    {
      title: "web:feat: rate-limit the webhook",
      body: "Throttle inbound calls.",
      acceptanceCriteria: [],
      labels: [],
    },
    { title: "core:test: cover it", body: "tests", acceptanceCriteria: [], labels: [] },
  ],
  relations: [{ from: 1, to: 0, kind: "blocks" }],
};

function installSkipper(opts: { draft?: ComposerDraft } = {}) {
  const start = vi.fn().mockResolvedValue({ ok: true, chatId: "chat-1" });
  const getChat = vi.fn().mockResolvedValue({ messages: [] });
  const send = vi.fn().mockResolvedValue({ ok: true, reply: "an answer" });
  const generateDraft = vi.fn().mockResolvedValue({ ok: true, draft: opts.draft ?? DRAFT });
  const updateDraft = vi.fn().mockResolvedValue({ ok: true });
  const dispose = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const getSelfLogin = vi.fn().mockResolvedValue({ login: "cicababba" });
  (window as unknown as { skipper: unknown }).skipper = {
    composer: {
      start,
      getChat,
      send,
      generateDraft,
      updateDraft,
      dispose,
      cancel,
      getSelfLogin,
      getEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
    },
    orchestrator: { createIssueOnTracker: vi.fn() },
    openExternal: vi.fn(),
  };
  return { start, send, generateDraft, updateDraft, dispose };
}

async function chat(text: string) {
  fireEvent.change(await screen.findByPlaceholderText("Describe the work…"), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  });
  await screen.findByText("an answer");
}

/** The draft push is debounced (500ms) — let it land inside act so a pending
 *  timer never updates state after the test. */
async function flushDraftPush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}

/** Generate is disabled until the transcript has a turn — wait it out. */
async function clickGenerate(name: "Generate draft" | "Regenerate draft") {
  const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
  searchParams = new URLSearchParams(BARE_PARAMS);
  replace.mockClear();
  window.localStorage.clear();
});

describe("ComposerView", () => {
  it("opens a chat on the repo when it mounts and disposes it on unmount", async () => {
    const { start, dispose } = installSkipper();
    const view = render(<ComposerView />);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }));
    view.unmount();
    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "chat-1"),
    );
  });

  it("keeps Generate draft disabled until something has been discussed", async () => {
    installSkipper();
    render(<ComposerView />);
    const button = (await screen.findByRole("button", {
      name: "Generate draft",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("splits into the draft pane once a draft lands", async () => {
    const { generateDraft } = installSkipper();
    render(<ComposerView />);
    await chat("rate-limit the webhook");

    expect(screen.queryByLabelText("Title")).toBeNull();
    await clickGenerate("Generate draft");

    await waitFor(() => expect(generateDraft).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "chat-1"));
    expect(await screen.findByDisplayValue("web:feat: rate-limit the webhook")).toBeTruthy();
    expect(screen.getByDisplayValue("core:test: cover it")).toBeTruthy();
    // A generated draft turns the action into a regeneration.
    expect(screen.getByRole("button", { name: "Regenerate draft" })).toBeTruthy();
    await flushDraftPush();
  });

  it("pushes the edited draft back to main so the next prompt carries it", async () => {
    const { updateDraft } = installSkipper();
    render(<ComposerView />);
    await chat("go");
    await clickGenerate("Generate draft");
    const title = await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    fireEvent.change(title, { target: { value: "my own title" } });
    fireEvent.blur(title);

    await waitFor(() => expect(updateDraft).toHaveBeenCalled());
    const [, , draft, flags] = updateDraft.mock.calls.at(-1) as [
      unknown,
      unknown,
      ComposerDraft,
      Record<number, string[]>,
    ];
    expect(draft.issues[0].title).toBe("my own title");
    expect(flags).toEqual({ 0: ["title"] });
    await flushDraftPush();
  });

  // Regenerating over hand-written fields is lossy — preservation is only a
  // prompt-level request, so the user confirms first.
  it("warns before regenerating over manual edits", async () => {
    const { generateDraft } = installSkipper();
    render(<ComposerView />);
    await chat("go");
    await clickGenerate("Generate draft");
    const title = await screen.findByDisplayValue("web:feat: rate-limit the webhook");
    fireEvent.change(title, { target: { value: "mine" } });

    expect(generateDraft).toHaveBeenCalledTimes(1);
    await clickGenerate("Regenerate draft");
    expect(await screen.findByText("Regenerate over your edits?")).toBeTruthy();
    expect(generateDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    });
    await waitFor(() => expect(generateDraft).toHaveBeenCalledTimes(2));
    await flushDraftPush();
  });

  it("regenerates without a warning when nothing was hand-edited", async () => {
    const { generateDraft } = installSkipper();
    render(<ComposerView />);
    await chat("go");
    await clickGenerate("Generate draft");
    await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    await clickGenerate("Regenerate draft");
    await waitFor(() => expect(generateDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Regenerate over your edits?")).toBeNull();
    await flushDraftPush();
  });

  it("surfaces a failed distillation", async () => {
    const skipper = installSkipper();
    skipper.generateDraft.mockResolvedValue({ ok: false, error: "boom" });
    render(<ComposerView />);
    await chat("go");
    await clickGenerate("Generate draft");
    expect(await screen.findByText(/Draft generation failed: boom/)).toBeTruthy();
    await flushDraftPush();
  });
});

// Which path the route opens on (#137): the URL decides, and when it says
// nothing the last used mode does.
describe("ComposerView mode dispatch", () => {
  it("opens the quick path on mode=quick, with no session behind it", async () => {
    const { start } = installSkipper();
    searchParams = new URLSearchParams({ ...BARE_PARAMS, mode: "quick" });
    render(<ComposerView />);
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate draft" })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("falls back to the stored preference when the URL carries no mode", async () => {
    const { start } = installSkipper();
    window.localStorage.setItem("composer.mode", "quick");
    render(<ComposerView />);
    expect(await screen.findByLabelText("Title")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it("lets an explicit mode in the URL win over the stored preference", async () => {
    const { start } = installSkipper();
    window.localStorage.setItem("composer.mode", "quick");
    searchParams = new URLSearchParams({ ...BARE_PARAMS, mode: "chat" });
    render(<ComposerView />);
    await waitFor(() => expect(start).toHaveBeenCalled());
  });

  it("remembers the mode the user switches to", async () => {
    installSkipper();
    render(<ComposerView />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Quick" }));
    });
    expect(replace).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&mode=quick");
    expect(window.localStorage.getItem("composer.mode")).toBe("quick");
  });
});
