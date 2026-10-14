import { describe, expect, it } from "vitest";
import { choicesFor, fieldsOf, pickerLabel, picking, tagged, typedTag, type Picking, type PickingEvent } from "../../src/web/plugins/todos/picking.ts";

const run = (events: PickingEvent[], from: Picking = null) => events.reduce(picking, from);
const open = (row: string, chip: "due" | "importance"): PickingEvent => ({ type: "open", row, chip });
const closed = (row: string, chip: "due" | "importance"): PickingEvent => ({ type: "closed", row, chip });

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

  it("is not opened by a popover that closes while nothing is open", () => {
    expect(run([closed("a/2", "due")])).toBeNull();
  });
});

describe("what a chip's popover offers", () => {
  const now = "2026-10-14";

  it("for a due date: today, tomorrow, a week on with its date, and clearing one that is set, the one it says now marked", () => {
    expect(choicesFor("due", { due: "2026-10-15", importance: 0 }, now)).toEqual([
      { label: "Today", change: { due: "2026-10-14" }, current: false },
      { label: "Tomorrow", change: { due: "2026-10-15" }, current: true },
      { label: "Next week", detail: "Oct 21", change: { due: "2026-10-21" }, current: false },
      { label: "Clear", change: { due: null }, current: false },
    ]);
    expect(choicesFor("due", { due: null, importance: 0 }, now).map((c) => c.label)).toEqual(["Today", "Tomorrow", "Next week"]);
  });

  it("for importance: every level, most first, the one it has marked", () => {
    expect(choicesFor("importance", { due: null, importance: 2 }, now)).toEqual([
      { label: "!!!", change: { importance: 3 }, current: false },
      { label: "!!", change: { importance: 2 }, current: true },
      { label: "!", change: { importance: 1 }, current: false },
      { label: "Normal", change: { importance: 0 }, current: false },
    ]);
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

describe("what a row's fields button lists", () => {
  const now = "2026-10-14";

  it("each thing its chips set, in their order, with what it is now", () => {
    expect(fieldsOf({ due: "2026-10-15", importance: 2, words: "Call the bank #money #home" }, now)).toEqual([
      { chip: "importance", name: "Importance", value: "!!" },
      { chip: "due", name: "Due date", value: "Tomorrow" },
      { chip: "tag", name: "Tags", value: "#money #home" },
    ]);
  });

  it("nothing for what isn't set", () => {
    expect(fieldsOf({ due: null, importance: 0, words: "Call the bank" }, now).map((f) => f.value)).toEqual([null, null, null]);
  });

  it("is one of what a row's popover can be open for, and is called by the todo's words", () => {
    expect(run([{ type: "open", row: "a/2", chip: "fields" }, open("a/2", "due"), { type: "closed", row: "a/2", chip: "fields" }])).toEqual({ row: "a/2", chip: "due" });
    expect(pickerLabel("fields", "Call the bank")).toBe("Fields of Call the bank");
  });
});
