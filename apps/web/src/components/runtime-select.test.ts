// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentRuntimeId, RuntimeAvailability } from "@skipper/shared";
import { getRuntimeAvailability } from "@/lib/runtime-availability";
import { RuntimeSelect } from "./runtime-select";

vi.mock("@/lib/runtime-availability", () => ({ getRuntimeAvailability: vi.fn() }));

const mockedGetAvailability = vi.mocked(getRuntimeAvailability);

afterEach(cleanup);

const availability = (installed: AgentRuntimeId[]): RuntimeAvailability => ({
  "claude-cli": installed.includes("claude-cli"),
  "codex-cli": installed.includes("codex-cli"),
  "copilot-cli": installed.includes("copilot-cli"),
  "gemini-cli": installed.includes("gemini-cli"),
});

function renderSelect(props: {
  value: AgentRuntimeId;
  resolved: RuntimeAvailability | null;
  onChange?: (r: AgentRuntimeId) => void;
  disabled?: boolean;
}) {
  const { resolved, ...rest } = props;
  mockedGetAvailability.mockResolvedValue(resolved);
  const onChange = props.onChange ?? vi.fn();
  const utils = render(createElement(RuntimeSelect, { ...rest, onChange }));
  return { ...utils, onChange };
}

const combobox = () => screen.getByRole("combobox") as HTMLSelectElement;
const optionLabels = () =>
  within(combobox())
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("RuntimeSelect", () => {
  // No probe outside Electron: every runtime stays selectable.
  it("lists all four runtimes unfiltered when availability is unknown", async () => {
    renderSelect({ value: "claude-cli", resolved: null });
    await waitFor(() => expect(mockedGetAvailability).toHaveBeenCalled());
    expect(optionLabels()).toEqual(["Claude Code", "Codex", "Copilot", "Gemini"]);
    expect(combobox().disabled).toBe(false);
  });

  it("narrows the list to the installed CLIs and marks an absent saved runtime", async () => {
    renderSelect({
      value: "claude-cli",
      resolved: availability(["codex-cli", "gemini-cli"]),
    });
    await screen.findByText("Claude Code (not installed)");
    expect(optionLabels()).toEqual(["Claude Code (not installed)", "Codex", "Gemini"]);
    expect(combobox().value).toBe("claude-cli");
    expect(combobox().disabled).toBe(false);
  });

  it("fires onChange with the picked runtime", async () => {
    const { onChange } = renderSelect({
      value: "claude-cli",
      resolved: availability(["claude-cli", "codex-cli"]),
    });
    await waitFor(() => expect(optionLabels()).toHaveLength(2));

    fireEvent.change(combobox(), { target: { value: "codex-cli" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("codex-cli");
  });

  // Nothing to pick and nothing to run: the empty state explains itself instead
  // of rendering an empty select.
  it("disables the select and explains itself when no CLI is installed", async () => {
    renderSelect({ value: "gemini-cli", resolved: availability([]) });
    await screen.findByText(
      "No agent CLI found. Install Claude Code, Codex, Copilot or Gemini CLI and restart Skipper.",
    );
    expect(optionLabels()).toEqual(["Gemini (not installed)"]);
    expect(combobox().disabled).toBe(true);
  });

  it("stays disabled when the caller disables it", async () => {
    renderSelect({ value: "claude-cli", resolved: null, disabled: true });
    await waitFor(() => expect(mockedGetAvailability).toHaveBeenCalled());
    expect(combobox().disabled).toBe(true);
  });
});
