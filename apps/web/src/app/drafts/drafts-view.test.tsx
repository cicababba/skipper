import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComposerDraftListItem } from "@skipper/shared";
import { DraftsView } from "./drafts-view";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

const DRAFTS: ComposerDraftListItem[] = [
  {
    draftId: "draft-1",
    repo: { owner: "acme", name: "widgets" },
    title: "web:feat: rate-limit the webhook",
    updatedAt: hoursAgo(2),
  },
  {
    draftId: "draft-2",
    repo: { owner: "acme", name: "rocket" },
    title: "",
    updatedAt: hoursAgo(50),
  },
];

/** An abandoned quick session (#272): auto-saved, so it carries both flags. */
const UNFINISHED_QUICK: ComposerDraftListItem = {
  draftId: "draft-3",
  repo: { owner: "acme", name: "widgets" },
  title: "web:fix: the topbar jumps",
  updatedAt: hoursAgo(1),
  unfinished: true,
  quick: true,
};

const UNFINISHED_CHAT: ComposerDraftListItem = {
  draftId: "draft-4",
  repo: { owner: "acme", name: "widgets" },
  title: "web:feat: shepherd the PR",
  updatedAt: hoursAgo(1),
  unfinished: true,
};

function installSkipper(opts: { drafts?: ComposerDraftListItem[]; removeOk?: boolean } = {}) {
  const list = vi.fn().mockResolvedValue(opts.drafts ?? DRAFTS);
  const remove = vi.fn().mockResolvedValue({ ok: opts.removeOk ?? true });
  const onChanged = vi.fn((_callback: () => void) => () => {});
  (window as unknown as { skipper: unknown }).skipper = {
    drafts: { list, remove, onChanged },
    openExternal: vi.fn(),
  };
  return { list, remove, onChanged };
}

async function renderDrafts() {
  await act(async () => {
    render(<DraftsView />);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  push.mockClear();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("DraftsView", () => {
  it("lists every saved draft with its repo and age", async () => {
    installSkipper();
    await renderDrafts();

    expect(await screen.findByText("web:feat: rate-limit the webhook")).toBeTruthy();
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(screen.getByText("acme/rocket")).toBeTruthy();
    expect(screen.getByText("2h")).toBeTruthy();
    expect(screen.getByText("2d")).toBeTruthy();
  });

  it("names an untitled draft rather than showing a blank row", async () => {
    installSkipper();
    await renderDrafts();
    expect(await screen.findByText("Untitled draft")).toBeTruthy();
  });

  it("subscribes to the change broadcast and refetches on it", async () => {
    const { list, onChanged } = installSkipper();
    await renderDrafts();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    const notify = onChanged.mock.calls[0][0];
    await act(async () => {
      notify();
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes on unmount", async () => {
    const unsubscribe = vi.fn();
    installSkipper();
    (window as unknown as { skipper: { drafts: { onChanged: unknown } } }).skipper.drafts.onChanged =
      vi.fn(() => unsubscribe);
    const view = render(<DraftsView />);
    await act(async () => {});
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  // Resume and Publish land on the same route — the composer with the draft
  // rehydrated; only the user's intent differs.
  it("routes Resume to the composer with the draft id", async () => {
    installSkipper();
    await renderDrafts();
    await screen.findByText("web:feat: rate-limit the webhook");

    fireEvent.click(screen.getAllByRole("button", { name: "Resume" })[0]);
    expect(push).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&draft=draft-1");
  });

  it("routes Publish to the same composer href", async () => {
    installSkipper();
    await renderDrafts();
    await screen.findByText("web:feat: rate-limit the webhook");

    fireEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]);
    expect(push).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&draft=draft-1");
  });

  it("routes on the title too", async () => {
    installSkipper();
    await renderDrafts();

    fireEvent.click(await screen.findByText("web:feat: rate-limit the webhook"));
    expect(push).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&draft=draft-1");
  });

  // An auto-saved draft (#272) sits in the same list, tagged so the user can
  // tell what they chose to keep from what the app kept for them.
  it("tags the unfinished rows and leaves the saved ones bare", async () => {
    installSkipper({ drafts: [UNFINISHED_QUICK, DRAFTS[0]] });
    await renderDrafts();
    await screen.findByText("web:fix: the topbar jumps");

    expect(screen.getAllByText("unfinished")).toHaveLength(1);
    const saved = screen.getByText("web:feat: rate-limit the webhook").closest("td")!;
    expect(within(saved).queryByText("unfinished")).toBeNull();
  });

  it("resumes an unfinished quick draft back into the quick path", async () => {
    installSkipper({ drafts: [UNFINISHED_QUICK] });
    await renderDrafts();
    await screen.findByText("web:fix: the topbar jumps");

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(push).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&mode=quick&draft=draft-3");
  });

  it("resumes an unfinished chat draft into the chat path", async () => {
    installSkipper({ drafts: [UNFINISHED_CHAT] });
    await renderDrafts();
    await screen.findByText("web:feat: shepherd the PR");

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(push).toHaveBeenCalledWith("/compose?owner=acme&name=widgets&draft=draft-4");
  });

  it("asks before deleting and does nothing until confirmed", async () => {
    const { remove } = installSkipper();
    await renderDrafts();
    await screen.findByText("web:feat: rate-limit the webhook");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(await screen.findByText("Delete this draft?")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(screen.queryByText("Delete this draft?")).toBeNull());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes the confirmed draft and refetches the list", async () => {
    const { list, remove } = installSkipper();
    await renderDrafts();
    await screen.findByText("web:feat: rate-limit the webhook");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    list.mockResolvedValue([DRAFTS[1]]);
    // The other row still offers its own Delete — confirm inside this one.
    const confirming = (await screen.findByText("Delete this draft?")).closest("td")!;
    await act(async () => {
      fireEvent.click(within(confirming).getByRole("button", { name: "Delete" }));
    });

    expect(remove).toHaveBeenCalledWith("draft-1");
    await waitFor(() =>
      expect(screen.queryByText("web:feat: rate-limit the webhook")).toBeNull(),
    );
    expect(screen.getByText("Untitled draft")).toBeTruthy();
  });

  it("confirms one row at a time", async () => {
    installSkipper();
    await renderDrafts();
    await screen.findByText("web:feat: rate-limit the webhook");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    expect(screen.getAllByText("Delete this draft?")).toHaveLength(1);
    // The untouched row keeps its normal actions.
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
  });

  it("shows the empty state with its hint when nothing is saved", async () => {
    installSkipper({ drafts: [] });
    await renderDrafts();

    expect(await screen.findByText("No saved drafts.")).toBeTruthy();
    expect(
      screen.getByText("Save a composer conversation to pick it up later, on this machine."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("gates the page outside the desktop app", async () => {
    await renderDrafts();
    expect(await screen.findByText("Drafts are available in the desktop app.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
