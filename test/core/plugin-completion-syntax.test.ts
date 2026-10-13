import { describe, expect, it } from "vitest";
import { picksAtOnce, placed, typedAfter } from "../../src/web/completionSyntax.ts";

describe("what was typed after a trigger", () => {
  it("is read at the start of a line and after a space", () => {
    expect(typedAfter("/", "/")).toBe("");
    expect(typedAfter("/ti", "/")).toBe("ti");
    expect(typedAfter("Add a /kan", "/")).toBe("kan");
    expect(typedAfter("- [ ] /t", "/")).toBe("t");
    expect(typedAfter("\t/t", "/")).toBe("t");
    expect(typedAfter("ask @ad", "@")).toBe("ad");
  });

  it("is nothing in the middle of a word, a URL, a path, a date, or a fraction", () => {
    for (const before of ["and/or", "https://example.com/pa", "https:/", "https://", "see http://x", "src/web/plugins", "~/notes", "10/10", "1/2", "(/t", "a /b/c"]) {
      expect([before, typedAfter(before, "/")]).toEqual([before, null]);
    }
    expect(typedAfter("ada@example", "@")).toBeNull();
  });

  it("ends at a space, unless the completion takes spaces", () => {
    expect(typedAfter("/timer now", "/")).toBeNull();
    expect(typedAfter("a / b", "/")).toBeNull();
    expect(typedAfter("see [[Road map", "[[", true)).toBe("Road map");
    expect(typedAfter("see [[Road map", "[[")).toBeNull();
    expect(typedAfter("see [[ Road", "[[", true)).toBeNull();
    expect(typedAfter("[[a]] and [[b", "[[", true)).toBe("b");
  });
});

describe("whether Enter picks as soon as the list shows", () => {
  it("does at the start of a line, and after words once the letters the completion asks for are typed", () => {
    expect(picksAtOnce("/", "", "/", 2)).toBe(true);
    expect(picksAtOnce("  /b", "b", "/", 2)).toBe(true);
    expect(picksAtOnce("A /", "", "/", 2)).toBe(false);
    expect(picksAtOnce("A /B", "B", "/", 2)).toBe(false);
    expect(picksAtOnce("- [ ] /t", "t", "/", 2)).toBe(false);
    expect(picksAtOnce("A /bo", "bo", "/", 2)).toBe(true);
  });

  it("does anywhere for a completion that asks for none", () => {
    expect(picksAtOnce("ask @", "", "@")).toBe(true);
    expect(picksAtOnce("see [[R", "R", "[[")).toBe(true);
  });
});

describe("placing a picked item", () => {
  const timer = { label: "Timer", insert: "::timer{5m}", select: [8, 10] as const };
  const board = { label: "Kanban board", insert: ":::kanban{}\n## To do\n:::", block: true };

  it("puts an inline item where the trigger was, with its selection or the cursor after it", () => {
    expect(placed(timer, { from: 10, to: 13, before: "Tea ", after: " now", last: false })).toEqual({ from: 10, to: 13, insert: "::timer{5m}", anchor: 18, head: 20 });
    expect(placed({ label: "Stopwatch", insert: "::stopwatch{}" }, { from: 0, to: 2, before: "", after: "", last: true })).toMatchObject({ insert: "::stopwatch{}", anchor: 13, head: 13 });
  });

  it("gives a block lines of its own and leaves the cursor on the line after it", () => {
    // Alone on the last line: a line is added for the cursor.
    expect(placed(board, { from: 20, to: 24, before: "", after: "", last: true })).toEqual({ from: 20, to: 24, insert: `${board.insert}\n`, anchor: 20 + board.insert.length + 1, head: 20 + board.insert.length + 1 });
    // Alone on a line with more below: the cursor goes to the line that is there.
    expect(placed(board, { from: 20, to: 24, before: "", after: "", last: false })).toEqual({ from: 20, to: 24, insert: board.insert, anchor: 20 + board.insert.length + 1, head: 20 + board.insert.length + 1 });
    // After text: the text keeps its line.
    expect(placed(board, { from: 20, to: 24, before: "Plan: ", after: "", last: true })).toMatchObject({ from: 20, insert: `\n${board.insert}\n` });
    // Before text: the text goes to the line after, with the cursor.
    expect(placed(board, { from: 20, to: 24, before: "", after: "rest", last: false })).toMatchObject({ insert: `${board.insert}\n`, anchor: 20 + board.insert.length + 1 });
    // After only blank space: the blank space goes, since a block starts its line.
    expect(placed(board, { from: 22, to: 24, before: "  ", after: "", last: true })).toMatchObject({ from: 20, to: 24, insert: `${board.insert}\n` });
  });
});
