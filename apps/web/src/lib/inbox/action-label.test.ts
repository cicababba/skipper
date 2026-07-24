import { describe, expect, it } from "vitest";
import { inbox } from "@/lib/i18n/inbox";
import { actionLabel } from "./action-label";
import type { ItemAction } from "./actions";

// The helper only ever reads t.inbox.actions, so the surrounding areas are irrelevant.
// No cast: this has to stay assignable to the helper's Pick<AppDict, "inbox">, which
// makes the test a compile-time parity check between AppDict.inbox and the dictionaries.
const dict = (lang: keyof typeof inbox) => ({ inbox: inbox[lang] });

describe("actionLabel", () => {
  it("reads 'Open PR' when the item has no PR yet (#225)", () => {
    const action: ItemAction = { id: "openPr", kind: "openPr" };
    expect(actionLabel(action, dict("en"))).toBe("Open PR");
  });

  it("reads 'Push to PR #N' when the action carries a PR number (#225)", () => {
    const action: ItemAction = { id: "openPr", kind: "openPr", prNumber: 42 };
    expect(actionLabel(action, dict("en"))).toBe("Push to PR #42");
  });

  it("localizes both shapes", () => {
    for (const lang of ["it", "fr", "es"] as const) {
      const t = dict(lang);
      expect(actionLabel({ id: "openPr", kind: "openPr" }, t)).toBe(inbox[lang].actions.openPr);
      expect(actionLabel({ id: "openPr", kind: "openPr", prNumber: 7 }, t)).toContain("#7");
    }
  });

  it("falls back to the plain dictionary entry for every other action", () => {
    expect(actionLabel({ id: "untrack", kind: "untrack" }, dict("en"))).toBe("Untrack");
    expect(actionLabel({ id: "close", kind: "closeDialog" }, dict("en"))).toBe("Close");
  });
});
