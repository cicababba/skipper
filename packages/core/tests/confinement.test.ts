import { describe, it, expect } from "vitest";
import {
  toClaudePathRoot,
  scopedWriteRules,
  writeApprovalRules,
  buildConfinementSettingsArgs,
  confinementEnv,
  type RunConfinement,
} from "../src/llm/confinement";

describe("toClaudePathRoot", () => {
  it("prefixes // and drops the leading slash of an absolute posix path", () => {
    expect(toClaudePathRoot("/home/user/wt", "linux")).toBe("//home/user/wt");
  });

  it("strips a trailing separator", () => {
    expect(toClaudePathRoot("/home/user/wt/", "linux")).toBe("//home/user/wt");
  });

  it("forces forward slashes (Windows-style separators)", () => {
    expect(toClaudePathRoot("/tmp/a\\b\\c", "linux")).toBe("//tmp/a/b/c");
  });

  it("keeps the drive letter of a win32 path", () => {
    expect(toClaudePathRoot("C:\\Users\\cicab\\AppData\\wt\\issue-1", "win32")).toBe(
      "//C:/Users/cicab/AppData/wt/issue-1",
    );
  });

  it("strips a trailing backslash on win32", () => {
    expect(toClaudePathRoot("C:\\Users\\cicab\\wt\\", "win32")).toBe("//C:/Users/cicab/wt");
  });
});

describe("scopedWriteRules", () => {
  it("emits root-scoped Edit and Write rules", () => {
    expect(scopedWriteRules("/wt/issue-1", "linux")).toEqual([
      "Edit(//wt/issue-1/**)",
      "Write(//wt/issue-1/**)",
    ]);
  });
});

// #278: on Windows the CLI matches no path-scoped write rule shape at all
// (anthropics/claude-code#67849), so the grant there depends on the guard hook.
describe("writeApprovalRules", () => {
  it("scopes the rules to the run root on posix, guarded or not", () => {
    const scoped = ["Edit(//wt/issue-1/**)", "Write(//wt/issue-1/**)"];
    expect(writeApprovalRules("/wt/issue-1", true, "linux")).toEqual(scoped);
    expect(writeApprovalRules("/wt/issue-1", false, "linux")).toEqual(scoped);
  });

  it("grants bare Edit/Write on win32 when the guard hook enforces the root", () => {
    expect(writeApprovalRules("C:\\wt\\issue-1", true, "win32")).toEqual(["Edit", "Write"]);
  });

  it("keeps the scoped (deny-by-default) rules on win32 without a guard hook", () => {
    expect(writeApprovalRules("C:\\wt\\issue-1", false, "win32")).toEqual([
      "Edit(//C:/wt/issue-1/**)",
      "Write(//C:/wt/issue-1/**)",
    ]);
  });
});

describe("buildConfinementSettingsArgs", () => {
  it("returns [] when there is no CLI bundle to launch the guard from", () => {
    const conf: RunConfinement = { runRoot: "/wt/issue-1", denyRoots: ["/repo"] };
    expect(buildConfinementSettingsArgs(conf)).toEqual([]);
  });

  it("builds a PreToolUse guard hook with Edit|Write and Bash matchers", () => {
    const conf: RunConfinement = {
      runRoot: "/wt/issue-1",
      denyRoots: ["/home/me/repo", "/other/repo"],
      cliBundlePath: "/app/skipper.bundle.cjs",
    };
    const args = buildConfinementSettingsArgs(conf);
    expect(args[0]).toBe("--settings");
    const settings = JSON.parse(args[1]);
    const hooks = settings.hooks.PreToolUse;
    expect(hooks.map((h: { matcher: string }) => h.matcher)).toEqual(["Edit|Write", "Bash"]);
    const command = hooks[0].hooks[0].command;
    expect(command).toContain("skipper.bundle.cjs");
    expect(command).toContain("guard");
    expect(command).toContain('--root "/wt/issue-1"');
    expect(command).toContain('--deny "/home/me/repo"');
    expect(command).toContain('--deny "/other/repo"');
    // Same command backs both matchers — it branches on tool_name from stdin.
    expect(hooks[1].hooks[0].command).toBe(command);
    expect(command).not.toContain("--protect");
  });

  it("emits a --protect arg per protect root (#278)", () => {
    const conf: RunConfinement = {
      runRoot: "/home/me/wt/issue-1",
      denyRoots: ["/home/me/repo"],
      protectRoots: ["/home/me", "/data"],
      cliBundlePath: "/app/skipper.bundle.cjs",
    };
    const command = JSON.parse(buildConfinementSettingsArgs(conf)[1]).hooks.PreToolUse[0].hooks[0]
      .command;
    expect(command).toContain('--protect "/home/me"');
    expect(command).toContain('--protect "/data"');
  });
});

describe("confinementEnv", () => {
  it("returns the base env untouched with no confinement", () => {
    const base = { FOO: "bar" };
    expect(confinementEnv(undefined, base)).toBe(base);
  });

  it("returns the base env untouched when there is no CLI bundle", () => {
    const base = { FOO: "bar" };
    expect(confinementEnv({ runRoot: "/wt", denyRoots: ["/repo"] }, base)).toBe(base);
  });

  it("adds ELECTRON_RUN_AS_NODE when the guard hook is active", () => {
    const conf: RunConfinement = {
      runRoot: "/wt",
      denyRoots: ["/repo"],
      cliBundlePath: "/app/skipper.bundle.cjs",
    };
    const env = confinementEnv(conf, { FOO: "bar" });
    expect(env).toMatchObject({ FOO: "bar", ELECTRON_RUN_AS_NODE: "1" });
  });
});
