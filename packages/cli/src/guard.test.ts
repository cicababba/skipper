import { describe, it, expect } from "vitest";
import { evaluateGuard } from "./guard.js";

const opts = { root: "/wt/issue-1", deny: ["/home/me/repo"], protect: [] };

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
      { root: "/wt", deny: ["/home/me/repo/"], protect: [] },
    );
    expect(v.block).toBe(true);
  });

  it("allows a Bash command that stays clear of every deny root", () => {
    expect(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: "pnpm test" } }, opts).block,
    ).toBe(false);
  });
});

// #278: Bash is the coder's write fallback when Edit/Write are denied, so the Bash
// branch must confine writes too — protect roots block any path token that lands
// under them without staying inside the run root.
describe("evaluateGuard — Bash protect roots", () => {
  const wt = "/home/me/.config/Skipper/worktrees/repo/issue-1";
  const guarded = { root: wt, deny: ["/home/me/repo"], protect: ["/home/me"] };

  it("blocks a command touching a protected path outside the run root", () => {
    const v = evaluateGuard(
      { tool_name: "Bash", tool_input: { command: "cp x.ts /home/me/other/place/x.ts" } },
      guarded,
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/reaches outside the worktree/);
  });

  it("allows an absolute path inside the run root even though it sits under a protect root", () => {
    const v = evaluateGuard(
      { tool_name: "Bash", tool_input: { command: `perl -0pi -e 's/a/b/' ${wt}/src/a.ts` } },
      guarded,
    );
    expect(v.block).toBe(false);
  });

  it("allows a path token ending at a shell delimiter inside the run root", () => {
    const v = evaluateGuard(
      { tool_name: "Bash", tool_input: { command: `cat "${wt}/src/a.ts"; ls ${wt};` } },
      guarded,
    );
    expect(v.block).toBe(false);
  });

  it("allows a relative command", () => {
    expect(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: "pnpm test src/a.ts" } }, guarded)
        .block,
    ).toBe(false);
  });

  it("blocks a home shorthand that expands outside the run root", () => {
    for (const command of ["cat ~/notes.txt", "cat $HOME/notes.txt", "type %USERPROFILE%\\notes.txt"]) {
      expect(evaluateGuard({ tool_name: "Bash", tool_input: { command } }, guarded).block).toBe(true);
    }
  });

  it("allows a home shorthand that expands inside the run root", () => {
    const v = evaluateGuard(
      {
        tool_name: "Bash",
        tool_input: { command: "cat ~/.config/Skipper/worktrees/repo/issue-1/src/a.ts" },
      },
      guarded,
    );
    expect(v.block).toBe(false);
  });

  it("checks win32 drive-letter literals with pure string normalization", () => {
    const winWt = "C:\\Users\\me\\AppData\\Roaming\\Skipper\\worktrees\\repo\\issue-1";
    const winOpts = { root: winWt, deny: [], protect: ["C:\\Users\\me"] };
    expect(
      evaluateGuard(
        { tool_name: "Bash", tool_input: { command: `type ${winWt}\\src\\a.ts` } },
        winOpts,
      ).block,
    ).toBe(false);
    expect(
      evaluateGuard(
        { tool_name: "Bash", tool_input: { command: "type C:\\Users\\me\\Desktop\\x.txt" } },
        winOpts,
      ).block,
    ).toBe(true);
  });

  it("leaves system paths outside every protect root alone", () => {
    expect(
      evaluateGuard({ tool_name: "Bash", tool_input: { command: "/usr/bin/git status" } }, guarded)
        .block,
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
