import { describe, expect, it } from "vitest";
import { CLOSED, layoutOf, reduce, restored, showing, type Side, type SideAction } from "../../src/web/inspectorState.ts";

const PANELS = ["history", "backlinks", "info"];
const after = (from: Side, ...actions: SideAction[]) => actions.reduce((side, action) => reduce(side, action, PANELS), from);
const FRESH: Side = { panel: "info", open: true, pinned: true };
const pick = (panel: string): SideAction => ({ type: "pick", panel });

describe("the inspector's panel", () => {
  it("opens over the page from its icon, and goes on a press elsewhere or Escape, or on its icon again", () => {
    const open = after(CLOSED, pick("info"));
    expect(open).toEqual({ panel: "info", open: true, pinned: false });
    expect(layoutOf(open, PANELS)).toBe("temporary");

    expect(after(open, { type: "dismiss" })).toEqual({ panel: "info", open: false, pinned: false });
    expect(after(open, pick("info"))).toEqual({ panel: "info", open: false, pinned: false });
  });

  it("changes to another panel from that panel's icon, staying open", () => {
    expect(after(CLOSED, pick("info"), pick("history"))).toEqual({ panel: "history", open: true, pinned: false });
  });

  it("stays through a press elsewhere once pinned, and is closed by its own icon", () => {
    const pinned = after(CLOSED, pick("history"), { type: "pin" });
    expect(layoutOf(pinned, PANELS)).toBe("pinned");
    expect(after(pinned, { type: "dismiss" })).toBe(pinned);
    expect(after(pinned, pick("backlinks"))).toEqual({ panel: "backlinks", open: true, pinned: true });
    expect(after(pinned, pick("history"))).toEqual({ panel: "history", open: false, pinned: true });
  });

  it("opens as it was last used: the same panel, pinned if it was pinned", () => {
    const closedPinned = after(CLOSED, pick("backlinks"), { type: "pin" }, pick("backlinks"));
    expect(after(closedPinned, { type: "toggle" })).toEqual({ panel: "backlinks", open: true, pinned: true });
    expect(after(closedPinned, pick("info"))).toEqual({ panel: "info", open: true, pinned: true });

    const unpinned = after(closedPinned, { type: "toggle" }, { type: "pin" }, { type: "toggle" });
    expect(after(unpinned, { type: "toggle" })).toEqual({ panel: "backlinks", open: true, pinned: false });
  });

  it("opens on the first panel for a member who has used none, and does nothing where there are none", () => {
    expect(after(CLOSED, { type: "toggle" })).toEqual({ panel: "history", open: true, pinned: false });
    expect(reduce(CLOSED, { type: "toggle" }, [])).toBe(CLOSED);
    expect(reduce(CLOSED, { type: "fold", folded: false }, [])).toBe(CLOSED);
    expect(after(CLOSED, pick("gone"))).toBe(CLOSED);
  });

  it("is beside the page when its edge is dragged out of the bar, and closed when dragged in", () => {
    const out = after(CLOSED, pick("info"), { type: "dismiss" }, { type: "fold", folded: false });
    expect(out).toEqual({ panel: "info", open: true, pinned: true });
    expect(after(out, { type: "fold", folded: true })).toEqual({ panel: "info", open: false, pinned: true });
    expect(after(CLOSED, { type: "fold", folded: true })).toBe(CLOSED);
  });

  it("shows nothing while the panel last used belongs to a plugin that is off, and opens on the first there is", () => {
    const side: Side = { panel: "word-count", open: true, pinned: true };
    expect(showing(side, PANELS)).toBe(null);
    expect(layoutOf(side, PANELS)).toBe("closed");
    expect(after(side, { type: "toggle" })).toEqual({ panel: "history", open: true, pinned: true });
    expect(after(side, { type: "dismiss" })).toBe(side);
  });
});

describe("the inspector as it was kept in the browser", () => {
  it("comes back pinned and open, and closed if it lay over the page", () => {
    expect(restored({ panel: "info", open: true, pinned: true }, FRESH)).toEqual({ panel: "info", open: true, pinned: true });
    expect(restored({ panel: "history", open: true, pinned: false }, FRESH)).toEqual({ panel: "history", open: false, pinned: false });
    expect(restored({ panel: "history", open: false, pinned: true }, FRESH)).toEqual({ panel: "history", open: false, pinned: true });
  });

  it("begins as a member's first time does from nothing kept, or from something else kept under its name", () => {
    expect(restored(null, FRESH)).toBe(FRESH);
    expect(restored(true, FRESH)).toBe(FRESH);
    expect(restored({ panel: 3, open: true, pinned: true }, FRESH)).toBe(FRESH);
    expect(restored({ panel: null, open: true, pinned: true }, FRESH)).toEqual({ panel: null, open: false, pinned: true });
  });
});
