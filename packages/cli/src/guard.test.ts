import { describe, it, expect } from "vitest";
import { evaluateGuard } from "./guard.js";

const opts = { root: "/wt/issue-1", deny: ["/home/me/repo"] };

describe("evaluateGuard — Edit/Write file scoping", () => {
  it("allows an Edit on a relative path inside the run root", () => {
    const v = evaluateGuard(
      { tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, cwd: "/wt/issue-1" },
      opts,
    );
    expect(v.block).toBe(false);
  });

  it("blocks a Write to an absolute path outside the run root", () => {
    const v = evaluateGuard(
      { tool_name: "Write", tool_input: { file_path: "/etc/hosts" }, cwd: "/wt/issue-1" },
      opts,
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/outside the worktree/);
  });

  it("resolves a relative path against the hook cwd before checking", () => {
    const v = evaluateGuard(
      { tool_name: "Edit", tool_input: { file_path: "../escape.ts" }, cwd: "/wt/issue-1" },
      opts,
    );
    expect(v.block).toBe(true);
  });

  it("allows an Edit with no file_path (nothing to check)", () => {
    expect(evaluateGuard({ tool_name: "Edit", tool_input: {} }, opts).block).toBe(false);
  });
});

describe("evaluateGuard — Bash deny roots", () => {
  it("blocks a Bash command that references a deny root", () => {
    const v = evaluateGuard(
      { tool_name: "Bash", tool_input: { command: "cat /home/me/repo/secret.ts" } },
      opts,
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/linked checkout/);
  });

  it("blocks a command that reaches the checkout with a trailing separator on the deny root", () => {
    const v = evaluateGuard(
      { tool_name: "Bash", tool_input: { command: "rm -rf /home/me/repo/src" } },
      { root: "/wt", deny: ["/home/me/repo/"] },
    );
    expect(v.block).toBe(true);
  });

  it("allows a Bash command that stays clear of every deny root", () => {
    expect(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, opts).block,
    ).toBe(false);
  });
});

describe("evaluateGuard — fail-open shape", () => {
  it("allows unknown tools", () => {
    expect(evaluateGuard({ tool_name: "Read", tool_input: {} }, opts).block).toBe(false);
  });

  it("allows an empty / malformed payload", () => {
    expect(evaluateGuard({}, opts).block).toBe(false);
  });
});
