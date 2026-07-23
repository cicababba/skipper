import { describe, expect, it } from "vitest";
import { bullet, fenceBlock, joinBlocks, pct } from "./md";

describe("fenceBlock", () => {
  it("wraps plain content in a three-backtick fence with no language", () => {
    expect(fenceBlock("hello")).toBe("```\nhello\n```");
  });

  it("applies the language tag on the opening fence", () => {
    expect(fenceBlock("x - y", "diff")).toBe("```diff\nx - y\n```");
  });

  it("escalates the fence to survive an embedded triple-backtick run", () => {
    const out = fenceBlock("before\n```\nafter", "diff");
    expect(out).toBe("````diff\nbefore\n```\nafter\n````");
  });

  it("escalates one past the longest embedded run", () => {
    const out = fenceBlock("````");
    expect(out.startsWith("`````\n")).toBe(true);
    expect(out.endsWith("\n`````")).toBe(true);
  });
});

describe("joinBlocks", () => {
  it("joins with a blank line by default", () => {
    expect(joinBlocks(["a", "b"])).toBe("a\n\nb");
  });

  it("honors a custom separator", () => {
    expect(joinBlocks(["a", "b"], "\n")).toBe("a\nb");
  });

  it("drops null, undefined, empty and whitespace-only entries", () => {
    expect(joinBlocks(["a", null, undefined, "", "   ", "b"])).toBe("a\n\nb");
  });

  it("returns an empty string when nothing survives", () => {
    expect(joinBlocks([null, undefined, "  "])).toBe("");
  });
});

describe("pct", () => {
  it("renders a whole percent", () => {
    expect(pct(0.87)).toBe("87%");
  });

  it("rounds to the nearest whole percent", () => {
    expect(pct(0.865)).toBe("87%");
    expect(pct(0.333)).toBe("33%");
  });

  it("handles the bounds", () => {
    expect(pct(0)).toBe("0%");
    expect(pct(1)).toBe("100%");
  });
});

describe("bullet", () => {
  it("renders a bold-label definition item", () => {
    expect(bullet("Model", "claude")).toBe("- **Model:** claude");
  });
});
