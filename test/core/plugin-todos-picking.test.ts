import { EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { choicesFor, clicked, keyed, linesTouched, picking, pressed, pressedAll, pressedWith, repeatOf, repeats, sameRule, tagged, toldOf, typedTag, type Opened, type Picking, type PickingEvent } from "../../src/web/plugins/todos/picking.ts";

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

  it("is put in a state by its key or button, and opened again by the one for the state it is in", () => {
    const from = ["open", "done", "abandoned", "backlog"] as const;
    expect(from.map((state) => pressed(state, "done"))).toEqual(["done", "open", "done", "done"]);
    expect(from.map((state) => pressed(state, "abandoned"))).toEqual(["abandoned", "abandoned", "open", "abandoned"]);
    expect(from.map((state) => pressed(state, "backlog"))).toEqual(["backlog", "backlog", "backlog", "open"]);
  });

  it("is abandoned with ⇧ and moved to the backlog with ⌥, or opened again from there", () => {
    const from = ["open", "done", "abandoned", "backlog"] as const;
    expect(from.map((state) => pressedWith(state, { shiftKey: true, altKey: false }))).toEqual(["abandoned", "abandoned", "open", "abandoned"]);
    expect(from.map((state) => pressedWith(state, { shiftKey: false, altKey: true }))).toEqual(["backlog", "backlog", "backlog", "open"]);
    expect(from.map((state) => pressedWith(state, { shiftKey: false, altKey: false }))).toEqual(["done", "open", "open", "open"]);
  });
});

describe("several todos put in a state at once", () => {
  const todos = (...states: ("open" | "done" | "abandoned" | "backlog")[]) => states.map((state, i) => ({ id: `t${i}`, state }));
  const made = (pairs: (readonly [{ id: string }, string])[]) => pairs.map(([todo, state]) => `${todo.id} ${state}`);

  it("puts in it each that isn't, and leaves those that are", () => {
    expect(made(pressedAll(todos("open", "done", "abandoned"), "done"))).toEqual(["t0 done", "t2 done"]);
  });

  it("opens them all again when every one is in it already", () => {
    expect(made(pressedAll(todos("backlog", "backlog"), "backlog"))).toEqual(["t0 open", "t1 open"]);
  });

  it("is said by how many: one is a task, more are counted", () => {
    expect([toldOf("done", 1), toldOf("abandoned", 3), toldOf("backlog", 2), toldOf("open", 1), toldOf("done", 1, 3)]).toEqual(["Task completed", "3 tasks abandoned", "2 tasks moved to the backlog", "Task opened again", "1 of 3 tasks completed"]);
  });
});

describe("the lines a key for a todo's state acts on", () => {
  // Lines start at 0, 8, 16 and 24.
  const doc = Text.of(["- [ ] a", "- [x] b", "- [ ] c", "- [ ] d"]);
  const touched = (...ranges: [number, number][]) => linesTouched(doc, EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))).ranges);

  it("are the cursor's line, or every line a selection takes in", () => {
    expect(touched([10, 10])).toEqual([8]);
    expect(touched([3, 19])).toEqual([0, 8, 16]);
  });

  it("leave out the line a selection ends at the start of, as selecting whole lines does, but not an empty one there", () => {
    expect(touched([0, 16])).toEqual([0, 8]);
    expect(touched([16, 16])).toEqual([16]);
  });

  it("are each line once, in order, for a selection on each of several lines as a block is", () => {
    expect(touched([26, 27], [1, 2], [4, 5], [10, 11])).toEqual([0, 8, 24]);
  });
});

describe("what a key for a todo's state does to the lines it acts on", () => {
  it("is what `pressed` makes one todo", () => {
    expect(keyed([{ from: 8, state: "open" }], "done")).toEqual({ put: [{ from: 8, state: "done" }] });
    expect(keyed([{ from: 8, state: "done" }], "done")).toEqual({ put: [{ from: 8, state: "open" }] });
    expect(keyed([{ from: 8, state: "backlog" }], "abandoned")).toEqual({ put: [{ from: 8, state: "abandoned" }] });
    expect(keyed([{ from: 8, state: "backlog" }], "backlog")).toEqual({ put: [{ from: 8, state: "open" }] });
  });

  it("puts every todo there in the state, and leaves those in it already, until they all are: then opens them all", () => {
    const mixed = [
      { from: 0, state: "open" },
      { from: 8, state: "done" },
      { from: 16, state: "abandoned" },
    ] as const;
    expect(keyed(mixed, "done")).toEqual({
      put: [
        { from: 0, state: "done" },
        { from: 16, state: "done" },
      ],
    });
    expect(keyed([{ from: 0, state: "done" }, { from: 8, state: "done" }], "done")).toEqual({
      put: [
        { from: 0, state: "open" },
        { from: 8, state: "open" },
      ],
    });
  });

  it("for done, makes open todos of the list items that are none, and leaves the todos as they are; the other states pass the items by", () => {
    const lines = [
      { from: 0, state: "open" },
      { from: 8, box: 10 },
      { from: 14, box: 16 },
    ] as const;
    expect(keyed(lines, "done")).toEqual({ boxed: [10, 16] });
    expect(keyed(lines, "abandoned")).toEqual({ put: [{ from: 0, state: "abandoned" }] });
    expect(keyed([{ from: 8, box: 10 }], "backlog")).toBeNull();
  });

  it("is nothing on lines with no todo", () => {
    expect(keyed([], "done")).toBeNull();
  });
});
