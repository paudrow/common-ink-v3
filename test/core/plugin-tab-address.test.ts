import { describe, expect, it } from "vitest";
import { EMPTY_LAYOUT, keptLayout } from "../../src/web/plugins/tabs/editorLayout.ts";
import { keepsATab } from "../../src/web/router.ts";

describe("an address nothing is at", () => {
  it("is opened as a tab only where the stored layout would keep that tab, so it can never cost the other tabs on reload", () => {
    for (const path of ["/nowhere", "/nowhere/at/all", "/history", "/a b", "/x?y", "//foo", "//", "///a", "//evil.example/x"]) {
      const layout = { groups: [{ id: "1", tabs: [{ kind: "note", id: "aaaaaaaaaaaa", preview: false }, { kind: "page", id: path, path, preview: true }], active: { kind: "page", id: path, path } }], focusedGroupId: "1" };
      expect([path, keepsATab(path)]).toEqual([path, keptLayout(layout) !== EMPTY_LAYOUT]);
    }
    expect(["//foo", "//", "/nowhere"].map(keepsATab)).toEqual([false, false, true]);
  });
});
