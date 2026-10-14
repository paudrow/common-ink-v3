import { describe, expect, it } from "vitest";
import { choicesFor, picking, tagged, typedTag, type Opened, type Picking, type PickingEvent } from "../../src/web/plugins/todos/picking.ts";

const run = (events: PickingEvent[], from: Picking = null) => events.reduce(picking, from);
const open = (row: string, chip: Opened): PickingEvent => ({ type: "open", row, chip });
const closed = (row: string, chip: Opened): PickingEvent => ({ type: "closed", row, chip });

describe("which todo's chip has its popover open", () => {
  it("is the chip last opened, and nothing once its popover closes", () => {
    expect(run([open("a/2", "due")])).toEqual({ row: "a/2", chip: "due" });
    expect(run([open("a/2", "due"), closed("a/2", "due")])).toBeNull();
  });

  it("is one at a time: opening another chip moves it there, and the one before closing after that changes nothing", () => {
    expect(run([open("a/2", "due"), open("a/2", "importance"), closed("a/2", "due")])).toEqual({ row: "a/2", chip: "importance" });
    expect(run([open("a/2", "due"), open("b/0", "due"), closed("a/2", "due")])).toEqual({ row: "b/0", chip: "due" });
  });

  it("closes when the open chip is opened again, and its popover closing after that leaves it closed", () => {
    expect(run([open("a/2", "due"), open("a/2", "due")])).toBeNull();
    expect(run([open("a/2", "due"), open("a/2", "due"), closed("a/2", "due")])).toBeNull();
  });

  it("counts a last-done chip's list of completions as one more, so it too closes the one open", () => {
    expect(run([open("a/2", "every"), open("a/2", "done"), closed("a/2", "every")])).toEqual({ row: "a/2", chip: "done" });
  });

  it("is not opened by a popover that closes while nothing is open", () => {
    expect(run([closed("a/2", "due")])).toBeNull();
  });
});

describe("what a chip's popover offers", () => {
  const now = "2026-10-14";

  it("for a due date: today, tomorrow, a week on with its date, and clearing one that is set, the one it says now marked", () => {
    expect(choicesFor("due", { due: "2026-10-15", importance: 0, every: null }, now)).toEqual([
      { label: "Today", change: { due: "2026-10-14" }, current: false },
      { label: "Tomorrow", change: { due: "2026-10-15" }, current: true },
      { label: "Next week", detail: "Oct 21", change: { due: "2026-10-21" }, current: false },
      { label: "Clear", change: { due: null }, current: false },
    ]);
    expect(choicesFor("due", { due: null, importance: 0, every: null }, now).map((c) => c.label)).toEqual(["Today", "Tomorrow", "Next week"]);
  });

  it("for importance: every level, most first, the one it has marked", () => {
    expect(choicesFor("importance", { due: null, importance: 2, every: null }, now)).toEqual([
      { label: "!!!", change: { importance: 3 }, current: false },
      { label: "!!", change: { importance: 2 }, current: true },
      { label: "!", change: { importance: 1 }, current: false },
      { label: "Normal", change: { importance: 0 }, current: false },
    ]);
  });

  const picks = (current?: string) =>
    [
      ["Daily", "1d"],
      ["Every weekday", "mon,tue,wed,thu,fri"],
      ["Weekly", "1w"],
      ["Every 2 weeks", "2w"],
      ["Monthly", "1m"],
      ["Yearly", "1y"],
    ].map(([label, every]) => ({ label, change: { every }, current: every === current }));

  it("for a recurrence: the six common rules, the one in force marked, then Skip this one with the day it moves to, and Stop recurring", () => {
    expect(choicesFor("every", { due: "2026-10-14", importance: 0, every: "1w" }, now)).toEqual([
      ...picks("1w"),
      { label: "Skip this one", detail: "due Oct 21", change: { skip: true }, current: false },
      { label: "Stop recurring", change: { every: null }, current: false },
    ]);
  });

  it("for a todo that doesn't recur yet: only the six rules", () => {
    expect(choicesFor("every", { due: "2026-10-14", importance: 0, every: null }, now)).toEqual(picks());
  });

  it("for a rule on its last time: no Skip, since there is no later one to move to, and Stop", () => {
    expect(choicesFor("every", { due: "2026-10-14", importance: 0, every: "1d-times-1" }, now)).toEqual([...picks(), { label: "Stop recurring", change: { every: null }, current: false }]);
  });

  it("for a rule that lands in another year: the skip says the year", () => {
    expect(choicesFor("every", { due: "2026-12-20", importance: 0, every: "1m" }, now).find((c) => c.label === "Skip this one")?.detail).toBe("due Jan 20, 2027");
  });
});

describe("adding a tag from a row", () => {
  it("takes a typed tag with or without its #, and nothing that can't be one tag", () => {
    expect(["home", "#home", "  #Home/garden-2 ", "a_b"].map(typedTag)).toEqual(["home", "home", "Home/garden-2", "a_b"]);
    expect(["", "#", "12", "two words", "#a#b", "a.b", "-a"].map(typedTag)).toEqual([null, null, null, null, null, null, null]);
  });

  it("writes the tag after the words, once, whatever case it is in there already", () => {
    expect(tagged("Call the bank", "money")).toBe("Call the bank #money");
    expect(tagged("Call the bank #Money", "money")).toBe("Call the bank #Money");
    expect(tagged("", "money")).toBe("#money");
  });
});
