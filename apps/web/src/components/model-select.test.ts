// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ModelSelect } from "./model-select";

afterEach(cleanup);

function renderSelect(props: {
  value: string;
  onChange?: (m: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const onChange = props.onChange ?? vi.fn();
  const utils = render(createElement(ModelSelect, { ...props, onChange }));
  return { ...utils, onChange };
}

const combobox = () => screen.getByRole("combobox") as HTMLSelectElement;
const textbox = () => screen.getByRole("textbox") as HTMLInputElement;

describe("ModelSelect", () => {
  it("renders the four aliases plus Custom…", () => {
    renderSelect({ value: "sonnet" });
    const options = within(combobox()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Claude Opus",
      "Claude Sonnet",
      "Claude Haiku",
      "Claude Fable",
      "Custom…",
    ]);
    expect(combobox().value).toBe("sonnet");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows Custom… with a prefilled input for an unknown value", () => {
    renderSelect({ value: "claude-opus-4-8" });
    expect(combobox().value).toBe("__custom__");
    expect(textbox().value).toBe("claude-opus-4-8");
  });

  it("reveals the input on Custom… and commits on blur with the trimmed value", () => {
    const { onChange } = renderSelect({ value: "sonnet" });
    fireEvent.change(combobox(), { target: { value: "__custom__" } });
    const input = textbox();
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "c" } });
    fireEvent.change(input, { target: { value: "  claude-opus-4-8  " } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("claude-opus-4-8");
  });

  it("commits the custom value on Enter, trimmed", () => {
    const { onChange } = renderSelect({ value: "sonnet" });
    fireEvent.change(combobox(), { target: { value: "__custom__" } });
    fireEvent.change(textbox(), { target: { value: "  my-model  " } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(textbox(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("my-model");
  });

  it("empty commit does not fire onChange and closes the input when the prior value was an alias", () => {
    const { onChange } = renderSelect({ value: "sonnet" });
    fireEvent.change(combobox(), { target: { value: "__custom__" } });
    fireEvent.blur(textbox());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(combobox().value).toBe("sonnet");
  });

  it("empty commit restores the prior custom id", () => {
    const { onChange } = renderSelect({ value: "my-model" });
    fireEvent.change(textbox(), { target: { value: "" } });
    fireEvent.blur(textbox());
    expect(onChange).not.toHaveBeenCalled();
    expect(textbox().value).toBe("my-model");
    expect(combobox().value).toBe("__custom__");
  });

  it("re-selecting the current alias while in custom mode closes the input and fires onChange", () => {
    const { onChange } = renderSelect({ value: "sonnet" });
    fireEvent.change(combobox(), { target: { value: "__custom__" } });
    expect(screen.queryByRole("textbox")).not.toBeNull();

    fireEvent.change(combobox(), { target: { value: "sonnet" } });
    expect(onChange).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("selecting a different alias from a custom value closes the input and fires onChange", () => {
    const { onChange } = renderSelect({ value: "my-model" });
    expect(screen.queryByRole("textbox")).not.toBeNull();

    fireEvent.change(combobox(), { target: { value: "opus" } });
    expect(onChange).toHaveBeenCalledWith("opus");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("resyncs when the incoming value prop changes", () => {
    const { rerender } = renderSelect({ value: "sonnet" });
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(createElement(ModelSelect, { value: "claude-opus-4-8", onChange: vi.fn() }));
    expect(combobox().value).toBe("__custom__");
    expect(textbox().value).toBe("claude-opus-4-8");

    rerender(createElement(ModelSelect, { value: "haiku", onChange: vi.fn() }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(combobox().value).toBe("haiku");
  });
});
