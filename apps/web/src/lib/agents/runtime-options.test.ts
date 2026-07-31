import { describe, expect, it } from "vitest";
import type { RuntimeAvailability } from "@skipper/shared";
import { missingRuntimes, noneInstalled, runtimeOptionsFor } from "./runtime-options";

const availability = (installed: string[]): RuntimeAvailability => ({
  "claude-cli": installed.includes("claude-cli"),
  "codex-cli": installed.includes("codex-cli"),
  "copilot-cli": installed.includes("copilot-cli"),
  "gemini-cli": installed.includes("gemini-cli"),
});

describe("runtimeOptionsFor", () => {
  // Outside Electron there is nothing to probe, so nothing is filtered out.
  it("offers every runtime when availability is unknown", () => {
    expect(runtimeOptionsFor(null, "claude-cli")).toEqual([
      { value: "claude-cli", labelKey: "runtimeClaude", installed: true },
      { value: "codex-cli", labelKey: "runtimeCodex", installed: true },
      { value: "copilot-cli", labelKey: "runtimeCopilot", installed: true },
      { value: "gemini-cli", labelKey: "runtimeGemini", installed: true },
    ]);
  });

  it("keeps the installed subset in menu order", () => {
    expect(
      runtimeOptionsFor(availability(["gemini-cli", "codex-cli"]), "codex-cli").map((o) => o.value),
    ).toEqual(["codex-cli", "gemini-cli"]);
  });

  // The saved pair is never silently rewritten: an absent runtime stays listed
  // and marked, so the user sees what the repo is actually configured with.
  it("keeps the current runtime listed and flagged when it is not installed", () => {
    const options = runtimeOptionsFor(availability(["codex-cli"]), "gemini-cli");
    expect(options).toEqual([
      { value: "codex-cli", labelKey: "runtimeCodex", installed: true },
      { value: "gemini-cli", labelKey: "runtimeGemini", installed: false },
    ]);
  });

  it("leaves only the current runtime when nothing is installed", () => {
    expect(runtimeOptionsFor(availability([]), "claude-cli")).toEqual([
      { value: "claude-cli", labelKey: "runtimeClaude", installed: false },
    ]);
  });
});

describe("noneInstalled", () => {
  it("is true only when every runtime is missing", () => {
    expect(noneInstalled(availability([]))).toBe(true);
    expect(noneInstalled(availability(["copilot-cli"]))).toBe(false);
  });

  it("is false when availability is unknown", () => {
    expect(noneInstalled(null)).toBe(false);
  });
});

describe("missingRuntimes", () => {
  // Nothing to probe means every runtime is on offer, so the hint has nothing
  // left to advertise.
  it("is empty when availability is unknown", () => {
    expect(missingRuntimes(null)).toEqual([]);
  });

  it("is empty when every CLI is installed", () => {
    expect(
      missingRuntimes(availability(["claude-cli", "codex-cli", "copilot-cli", "gemini-cli"])),
    ).toEqual([]);
  });

  it("names exactly the absent runtimes in menu order", () => {
    expect(missingRuntimes(availability(["codex-cli"]))).toEqual([
      { value: "claude-cli", labelKey: "runtimeClaude", installed: false },
      { value: "copilot-cli", labelKey: "runtimeCopilot", installed: false },
      { value: "gemini-cli", labelKey: "runtimeGemini", installed: false },
    ]);
  });
});
