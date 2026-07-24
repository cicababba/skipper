import { describe, expect, it } from "vitest";
import { exportFilename } from "./filename";

describe("exportFilename", () => {
  it("builds <repo>-<key>-<artifact>.md for a GitHub numeric key", () => {
    expect(exportFilename({ owner: "acme", name: "widget" }, "42", "plan")).toBe(
      "widget-42-plan.md",
    );
  });

  it("slugifies a Jira key", () => {
    expect(exportFilename({ owner: "acme", name: "proj" }, "PROJ-123", "review")).toBe(
      "proj-proj-123-review.md",
    );
  });

  it("sanitizes odd repo-name characters and trims dashes", () => {
    expect(exportFilename({ owner: "acme", name: "my repo!@#" }, "42", "dossier")).toBe(
      "my-repo-42-dossier.md",
    );
  });

  it("preserves dots and existing dashes in the repo name", () => {
    expect(exportFilename({ owner: "acme", name: "web.app-ui" }, "7", "worktree")).toBe(
      "web.app-ui-7-worktree.md",
    );
  });
});
