import { describe, expect, it } from "vitest";
import { choicesFor, clicked, picking, repeatOf, repeats, sameRule, tagged, typedTag, type Opened, type Picking, type PickingEvent } from "../../src/web/plugins/todos/picking.ts";

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
    expect(choicesFor("due", { state: "open", due: "2026-10-15", importance: 0, every: null }, now)).toEqual([
      { label: "Today", change: { due: "2026-10-14" }, current: false },
      { label: "Tomorrow", change: { due: "2026-10-15" }, current: true },
      { label: "Next week", detail: "Oct 21", change: { due: "2026-10-21" }, current: false },
      { label: "Clear", change: { due: null }, current: false },
    ]);
    expect(choicesFor("due", { state: "open", due: null, importance: 0, every: null }, now).map((c) => c.label)).toEqual(["Today", "Tomorrow", "Next week"]);
  });

  it("for a todo that repeats: Skip to the date it moves to, before Clear, and with the year when it is another", () => {
    expect(choicesFor("due", { state: "open", due: "2026-10-14", importance: 0, every: "1w" }, now).slice(3)).toEqual([
      { label: "Skip to Oct 21", change: { skip: true }, current: false },
      { label: "Clear", change: { due: null }, current: false },
    ]);
    expect(choicesFor("due", { state: "open", due: "2026-12-20", importance: 0, every: "1m" }, now)[3]!.label).toBe("Skip to Jan 20, 2027");
    // One abandoned or in the backlog waits until it is open, so it has nothing to skip.
    expect(choicesFor("due", { state: "backlog", due: "2026-10-14", importance: 0, every: "1w" }, now).slice(3)).toEqual([{ label: "Clear", change: { due: null }, current: false }]);
    // The last time of a rule that ends has no later one to skip to.
    expect(choicesFor("due", { state: "open", due: "2026-10-14", importance: 0, every: "1d-times-1" }, now).map((c) => c.label)).toEqual(["Today", "Tomorrow", "Next week", "Clear"]);
  });

  it("for priority: High, Medium and Low in words, then None, the one it has marked", () => {
    expect(choicesFor("importance", { state: "open", due: null, importance: 2, every: null }, now)).toEqual([
      { label: "High", change: { importance: 3 }, current: false },
      { label: "Medium", change: { importance: 2 }, current: true },
      { label: "Low", change: { importance: 1 }, current: false },
      { label: "None", change: { importance: 0 }, current: false },
    ]);
  });
});

describe("what the Repeat popover lists", () => {
  it("is Doesn't repeat, the common rules with the days a due date gives them, and Custom", () => {
    // 14 October 2026 is a Wednesday.
    expect(repeats("2026-10-14")).toEqual([
      { label: "Doesn't repeat", every: null },
      { label: "Daily", every: "1d" },
      { label: "Weekdays", every: "mon,tue,wed,thu,fri" },
      { label: "Weekly on Wednesday", every: "1w" },
      { label: "Monthly on the 14th", every: "1m" },
      { label: "Yearly", every: "1y" },
      { label: "Custom", every: null, custom: true },
    ]);
    expect(repeats(null).map((r) => r.label)).toEqual(["Doesn't repeat", "Daily", "Weekdays", "Weekly", "Monthly", "Yearly", "Custom"]);
  });

  it("checks the one a rule is, however it is written, Doesn't repeat for none, and Custom for any other", () => {
    const listed = repeats("2026-10-14");
    expect([null, "1d", "1w", "mon,tue,wed,thu,fri", "1m", "1y", "2w", "1w-times-3", "3d-after-done", "sometimes"].map((every) => repeatOf(every, listed).label)).toEqual([
      "Doesn't repeat",
      "Daily",
      "Weekly on Wednesday",
      "Weekdays",
      "Monthly on the 14th",
      "Yearly",
      "Custom",
      "Custom",
      "Custom",
      "Custom",
    ]);
  });

  it("knows a rule written another way, and none, as the same", () => {
    expect([sameRule(null, null), sameRule("1w", "1w"), sameRule("fri,mon", "mon,fri"), sameRule("1w", null), sameRule(null, "1w"), sameRule("1w", "2w"), sameRule("sometimes", "never")]).toEqual([true, true, true, false, false, false, false]);
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

describe("a todo's box", () => {
  it("is checked off by a click when it is open, and opened again when it is anything else", () => {
    expect((["open", "done", "abandoned", "backlog"] as const).map(clicked)).toEqual(["done", "open", "open", "open"]);
  });
});
