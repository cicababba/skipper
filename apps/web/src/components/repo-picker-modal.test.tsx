import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RepoPickerModal } from "./repo-picker-modal";

function installSkipper(linked: { key: string }[]) {
  const listRepos = vi.fn().mockResolvedValue({ linked, unlinked: [] });
  (window as unknown as { skipper: unknown }).skipper = { orchestrator: { listRepos } };
  return { listRepos };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { skipper?: unknown }).skipper;
});

describe("RepoPickerModal", () => {
  it("lists the linked repos and hands the picked one back split into owner/name", async () => {
    installSkipper([{ key: "acme/widgets" }, { key: "acme/gears" }]);
    const onPick = vi.fn();
    render(<RepoPickerModal onPick={onPick} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "acme/gears" }));
    expect(onPick).toHaveBeenCalledWith({ owner: "acme", name: "gears" });
  });

  // Unlinked repos have no local checkout, so the composer's agent has nothing
  // to read — they must not be offered.
  it("offers only linked repos", async () => {
    const { listRepos } = installSkipper([{ key: "acme/widgets" }]);
    render(<RepoPickerModal onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "acme/widgets" });
    expect(listRepos).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "acme/unlinked" })).toBeNull();
  });

  it("explains the empty case", async () => {
    installSkipper([]);
    render(<RepoPickerModal onPick={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/No linked repository yet/)).toBeTruthy();
  });

  it("closes on cancel", async () => {
    installSkipper([]);
    const onClose = vi.fn();
    render(<RepoPickerModal onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
