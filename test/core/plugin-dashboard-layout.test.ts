import { describe, expect, it } from "vitest";
import { arrange, readLayout, stepSize, writeLayout, type Layout } from "../../src/web/plugins/dashboard/layout.ts";

const PANELS = new Map([
  ["events", "small"],
  ["todos", "small"],
  ["changes", "wide"],
  ["recent", "small"],
] as const);

const START: Layout = [
  { id: "events", size: "small" },
  { id: "todos", size: "small" },
  { id: "changes", size: "wide" },
];
const ids = (layout: Layout) => layout.map((p) => p.id);

describe("arranging the dashboard", () => {
  it("moves a panel to a place in what is left, either way, and to the ends however far past them it is asked", () => {
    expect(ids(arrange(START, { type: "move", id: "changes", to: 0 }))).toEqual(["changes", "events", "todos"]);
    expect(ids(arrange(START, { type: "move", id: "events", to: 1 }))).toEqual(["todos", "events", "changes"]);
    expect(ids(arrange(START, { type: "move", id: "events", to: 2 }))).toEqual(["todos", "changes", "events"]);
    expect(ids(arrange(START, { type: "move", id: "events", to: 99 }))).toEqual(["todos", "changes", "events"]);
    expect(ids(arrange(START, { type: "move", id: "changes", to: -5 }))).toEqual(["changes", "events", "todos"]);
  });

  it("gives back the same layout for a move that goes nowhere, so nothing is saved for it", () => {
    expect(arrange(START, { type: "move", id: "todos", to: 1 })).toBe(START);
    expect(arrange(START, { type: "resize", id: "todos", size: "small" })).toBe(START);
  });

  it("resizes one panel and leaves the others as they are", () => {
    expect(arrange(START, { type: "resize", id: "todos", size: "tall" })).toEqual([
      { id: "events", size: "small" },
      { id: "todos", size: "tall" },
      { id: "changes", size: "wide" },
    ]);
  });

  it("adds a panel at the end, once, and removes one", () => {
    const added = arrange(START, { type: "add", id: "recent", size: "small" });
    expect(added.at(-1)).toEqual({ id: "recent", size: "small" });
    expect(arrange(added, { type: "add", id: "recent", size: "large" })).toBe(added);
    expect(ids(arrange(added, { type: "remove", id: "todos" }))).toEqual(["events", "changes", "recent"]);
  });

  it("does nothing with a panel it isn't showing", () => {
    expect(arrange(START, { type: "move", id: "recent", to: 0 })).toBe(START);
    expect(arrange(START, { type: "resize", id: "recent", size: "wide" })).toBe(START);
    expect(arrange(START, { type: "remove", id: "recent" })).toBe(START);
  });

  it("steps a size by the arrow keys: right and left for the width, down and up for the height", () => {
    expect(stepSize("small", "ArrowRight")).toBe("wide");
    expect(stepSize("small", "ArrowDown")).toBe("tall");
    expect(stepSize("wide", "ArrowDown")).toBe("large");
    expect(stepSize("large", "ArrowLeft")).toBe("tall");
    expect(stepSize("tall", "ArrowUp")).toBe("small");
    expect(stepSize("small", "ArrowLeft")).toBe("small");
    expect(stepSize("small", "ArrowUp")).toBe("small");
  });
});

describe("reading the saved layout", () => {
  it("reads back what was written", () => {
    const layout = arrange(arrange(START, { type: "resize", id: "events", size: "large" }), { type: "move", id: "changes", to: 0 });
    expect(writeLayout(layout)).toEqual(["changes wide", "events large", "todos small"]);
    expect(readLayout(writeLayout(layout), PANELS)).toEqual(layout);
  });

  it("skips a panel there isn't, as one whose plugin is off, and keeps the others in their order", () => {
    expect(readLayout(["todos small", "clock small", "events wide"], PANELS)).toEqual([
      { id: "todos", size: "small" },
      { id: "events", size: "wide" },
    ]);
  });

  it("shows a panel named twice once, where it is first, and gives a size that isn't one the panel's own", () => {
    expect(readLayout(["changes huge", "events tall", "changes small", "  recent  ", ""], PANELS)).toEqual([
      { id: "changes", size: "wide" },
      { id: "events", size: "tall" },
      { id: "recent", size: "small" },
    ]);
  });

  it("reads nothing from words that name no panel, and shows an empty dashboard", () => {
    expect(readLayout(["toString small", "__proto__ wide", "constructor"], PANELS)).toEqual([]);
  });
});
