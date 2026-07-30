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

function installSkipper(
  opts: {
    draft?: ComposerDraft;
    /** Deferred openers (#138) let a test unmount before resume/start resolves. */
    startResult?: Promise<unknown>;
    resumeResult?: Promise<unknown>;
    chat?: unknown;
  } = {},
) {
  const start = vi.fn(() => opts.startResult ?? Promise.resolve({ ok: true, chatId: "chat-1" }));
  const resume = vi.fn(() => opts.resumeResult ?? Promise.resolve({ ok: true, chatId: "draft-1" }));
  const getChat = vi.fn().mockResolvedValue(opts.chat ?? { messages: [] });
  const send = vi.fn().mockResolvedValue({ ok: true, reply: "an answer" });
  const generateDraft = vi.fn().mockResolvedValue({ ok: true, draft: opts.draft ?? DRAFT });
  const updateDraft = vi.fn().mockResolvedValue({ ok: true });
  const dispose = vi.fn().mockResolvedValue(undefined);
  const cancel = vi.fn().mockResolvedValue(undefined);
  const getSelfLogin = vi.fn().mockResolvedValue({ login: "cicababba" });
  const saveDraft = vi.fn().mockResolvedValue({ ok: true, draftId: "chat-1" });
  const remove = vi.fn().mockResolvedValue({ ok: true });
  const createIssueOnTracker = vi.fn(async () => ({
    ok: true,
    id: "12",
    key: "12",
    number: 12,
    url: "https://github.com/acme/widgets/issues/12",
  }));
  (window as unknown as { skipper: unknown }).skipper = {
    composer: {
      start,
      resume,
      getChat,
      send,
      generateDraft,
      updateDraft,
      saveDraft,
      dispose,
      cancel,
      getSelfLogin,
      getEvents: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
    },
    drafts: { list: vi.fn().mockResolvedValue([]), remove, onChanged: vi.fn(() => () => {}) },
    orchestrator: { createIssueOnTracker },
    openExternal: vi.fn(),
  };
  return { start, resume, getChat, send, generateDraft, updateDraft, dispose, saveDraft, remove, createIssueOnTracker };
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
      expect(dispose).toHaveBeenCalledWith(
        { owner: "acme", name: "widgets" },
        "chat-1",
        undefined,
      ),
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

// Saved drafts (#138): promotion, resume and the publish that ends the draft.
describe("ComposerView drafts", () => {
  const HYDRATED = {
    messages: [{ role: "user", text: "rate-limit the webhook", at: "2026-07-25T10:00:00.000Z" }],
    draft: DRAFT,
    editedFlags: { 0: ["title"] },
  };

  it("keeps Save draft disabled until something has been discussed", async () => {
    installSkipper();
    render(<ComposerView />);
    const button = (await screen.findByRole("button", { name: "Save draft" })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("promotes the chat and turns the button into a Saved indicator", async () => {
    const { saveDraft } = installSkipper();
    render(<ComposerView />);
    await chat("rate-limit the webhook");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });

    expect(saveDraft).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "chat-1");
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("surfaces a failed save and leaves the button offering a retry", async () => {
    const skipper = installSkipper();
    skipper.saveDraft.mockResolvedValue({ ok: false, error: "disk full" });
    render(<ComposerView />);
    await chat("go");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });

    expect(await screen.findByText(/The draft could not be saved: disk full/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
  });

  it("resumes a saved draft instead of opening a fresh chat", async () => {
    const { start, resume, getChat } = installSkipper({ chat: HYDRATED });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    render(<ComposerView />);

    await waitFor(() =>
      expect(resume).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1"),
    );
    expect(start).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(getChat).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1"),
    );
    // The pane comes back with the draft, and the chat is promoted from the start.
    expect(await screen.findByDisplayValue("web:feat: rate-limit the webhook")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate draft" })).toBeTruthy();
    await flushDraftPush();
  });

  it("keeps the restored edit flags, so a regeneration still warns", async () => {
    const { generateDraft } = installSkipper({ chat: HYDRATED });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    render(<ComposerView />);
    await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    await clickGenerate("Regenerate draft");
    expect(await screen.findByText("Regenerate over your edits?")).toBeTruthy();
    expect(generateDraft).not.toHaveBeenCalled();
    await flushDraftPush();
  });

  it("opens the chat path on a draft even when quick is the stored preference", async () => {
    const { resume } = installSkipper({ chat: HYDRATED });
    window.localStorage.setItem("composer.mode", "quick");
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    render(<ComposerView />);

    await waitFor(() => expect(resume).toHaveBeenCalled());
    expect(await screen.findByPlaceholderText("Describe the work…")).toBeTruthy();
    await flushDraftPush();
  });

  it("surfaces a resume that finds no draft", async () => {
    installSkipper({ resumeResult: Promise.resolve({ ok: false, error: "unknown draft" }) });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "gone" });
    render(<ComposerView />);
    expect(await screen.findByText(/unknown draft/)).toBeTruthy();
  });

  // A resumed record is keyed by the stable draft id, so a mount that lost the
  // race must not dispose it — the mount that owns the key is still using it.
  it("does not dispose a resumed chat whose promise lands after unmount", async () => {
    let resolveResume!: (v: unknown) => void;
    const resumeResult = new Promise<unknown>((resolve) => {
      resolveResume = resolve;
    });
    const { dispose } = installSkipper({ resumeResult });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    const view = render(<ComposerView />);
    view.unmount();

    await act(async () => {
      resolveResume({ ok: true, chatId: "draft-1" });
      await resumeResult;
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  // A fresh chat's id was minted for this mount alone, so the late record is
  // nobody else's and disposing it is the only way not to leak it.
  it("still disposes a fresh chat whose promise lands after unmount", async () => {
    let resolveStart!: (v: unknown) => void;
    const startResult = new Promise<unknown>((resolve) => {
      resolveStart = resolve;
    });
    const { dispose } = installSkipper({ startResult });
    const view = render(<ComposerView />);
    view.unmount();

    await act(async () => {
      resolveStart({ ok: true, chatId: "chat-1" });
      await startResult;
    });
    expect(dispose).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "chat-1");
  });

  it("deletes the draft once every issue reached the tracker", async () => {
    const { remove, createIssueOnTracker } = installSkipper();
    render(<ComposerView />);
    await chat("go");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    await screen.findByText("Saved");
    await clickGenerate("Generate draft");
    await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(createIssueOnTracker).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Every issue was created.")).toBeTruthy();
    await waitFor(() => expect(remove).toHaveBeenCalledWith("chat-1"));
    await flushDraftPush();
  });

  it("leaves an unsaved chat alone when its issues are created", async () => {
    const { remove } = installSkipper();
    render(<ComposerView />);
    await chat("go");
    await clickGenerate("Generate draft");
    await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(await screen.findByText("Every issue was created.")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
    await flushDraftPush();
  });
});

// Unfinished drafts (#272): the same list, the same resume route, one flag that
// says the app saved this — not the user.
describe("ComposerView unfinished drafts", () => {
  const UNFINISHED_RESUME = Promise.resolve({ ok: true, chatId: "draft-1", unfinished: true });

  const HYDRATED = {
    messages: [{ role: "user", text: "rate-limit the webhook", at: "2026-07-25T10:00:00.000Z" }],
    draft: DRAFT,
    editedFlags: {},
  };

  /** A quick session has no transcript — that is what makes it quick-shaped. */
  const QUICK_HYDRATED = {
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

  it("resumes an unfinished quick draft into the quick path, prefilled", async () => {
    const { start, resume, getChat } = installSkipper({ chat: QUICK_HYDRATED });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, mode: "quick", draft: "draft-1" });
    render(<ComposerView />);

    await waitFor(() =>
      expect(resume).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1"),
    );
    expect(start).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(getChat).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1"),
    );
    expect(await screen.findByDisplayValue("web:fix: the topbar jumps")).toBeTruthy();
    // Quick stays quick: no chat, no distillation.
    expect(screen.queryByRole("button", { name: "Generate draft" })).toBeNull();
    expect(screen.queryByPlaceholderText("Describe the work…")).toBeNull();
    await flushDraftPush();
  });

  it("keeps offering Save draft on a resumed unfinished chat", async () => {
    installSkipper({ chat: HYDRATED, resumeResult: UNFINISHED_RESUME });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    render(<ComposerView />);

    expect(await screen.findByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(screen.queryByText("Saved")).toBeNull();
    await flushDraftPush();
  });

  it("promotes the resumed unfinished draft when the user saves it", async () => {
    const { saveDraft } = installSkipper({ chat: HYDRATED, resumeResult: UNFINISHED_RESUME });
    saveDraft.mockResolvedValue({ ok: true, draftId: "draft-1" });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    render(<ComposerView />);
    const save = (await screen.findByRole("button", { name: "Save draft" })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(save);
    });

    expect(saveDraft).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1");
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    await flushDraftPush();
  });

  it("publishing a resumed unfinished draft removes it and discards the session", async () => {
    const { remove, dispose, createIssueOnTracker } = installSkipper({
      chat: HYDRATED,
      resumeResult: UNFINISHED_RESUME,
    });
    searchParams = new URLSearchParams({ ...BARE_PARAMS, draft: "draft-1" });
    const view = render(<ComposerView />);
    await screen.findByDisplayValue("web:feat: rate-limit the webhook");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(createIssueOnTracker).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("draft-1"));
    await flushDraftPush();

    view.unmount();
    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "draft-1", {
        discard: true,
      }),
    );
  });

  // Walking away is the whole feature: the renderer says nothing and main is the
  // one that decides the session is worth keeping.
  it("leaves an abandoned chat to main's capture on a plain unmount", async () => {
    const { dispose } = installSkipper();
    const view = render(<ComposerView />);
    await chat("rate-limit the webhook");

    view.unmount();

    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith(
        { owner: "acme", name: "widgets" },
        "chat-1",
        undefined,
      ),
    );
  });

  it("discards the session when the user confirms a switch to quick", async () => {
    const { dispose } = installSkipper();
    const view = render(<ComposerView />);
    await chat("rate-limit the webhook");

    fireEvent.click(screen.getByRole("button", { name: "Quick" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    });
    view.unmount();

    await waitFor(() =>
      expect(dispose).toHaveBeenCalledWith({ owner: "acme", name: "widgets" }, "chat-1", {
        discard: true,
      }),
    );
  });
});
