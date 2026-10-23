import { describe, expect, it } from "vitest";
import { placed, startsLine, typedAfter } from "../../src/web/completionSyntax.ts";

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
    expect(typedAfter("see [[Road map", "[[", { spaces: true })).toBe("Road map");
    expect(typedAfter("see [[Road map", "[[")).toBeNull();
    expect(typedAfter("see [[ Road", "[[", { spaces: true })).toBeNull();
    expect(typedAfter("[[a]] and [[b", "[[", { spaces: true })).toBe("b");
  });

  it("is read after :: where a note writes an embed, and not in a block's closing :::, a name with :: inside it, or an address", () => {
    expect(["::", "x ::kan", ":::", "std::vector", "fe80::1", "::ti::", "say ::ti me"].map((before) => typedAfter(before, "::"))).toEqual(["", "kan", ":", null, null, null, null]);
  });

  it("is read after anything when the completion opens anywhere", () => {
    for (const before of ["([[Ro", "\"[[Ro", "word[[Ro", "**[[Ro"]) {
      expect([before, typedAfter(before, "[[", { spaces: true, anywhere: true })]).toEqual([before, "Ro"]);
      expect([before, typedAfter(before, "[[", { spaces: true })]).toEqual([before, null]);
    }
    expect(typedAfter("and/or", "/")).toBeNull();
  });
});

describe("whether a trigger starts its line, where Enter picks from the list", () => {
  it("does after nothing, blank space, a quote's mark, or a list item's mark and box", () => {
    for (const [before, typed] of [["/", ""], ["/s", "s"], ["  /b", "b"], ["\t/t", "t"], ["- /t", "t"], ["* /", ""], ["12. /kan", "kan"], ["- [ ] /t", "t"], ["- [x] /time", "time"], ["> /st", "st"], ["> - [ ] /t", "t"]] as const) {
      expect([before, startsLine(before, typed, "/")]).toEqual([before, true]);
    }
  });

  it("doesn't after other words, however much is typed after the trigger", () => {
    for (const [before, typed] of [["A /B", "B"], ["date /time", "time"], ["start /stop", "stop"], ["A /", ""], ["- [ ] Feed /t", "t"], ["# Plan /kanban", "kanban"], ["-x /t", "t"]] as const) {
      expect([before, startsLine(before, typed, "/")]).toEqual([before, false]);
    }
    expect(startsLine("see [[R", "R", "[[")).toBe(false);
    expect(startsLine("[[R", "R", "[[")).toBe(true);
  });
});

describe("placing a picked item", () => {
  const timer = { label: "Timer", insert: "/timer(5m)", select: [7, 9] as const };
  const board = { label: "Kanban board", insert: "/kanban()\n~~~markdown\n## To do\n~~~", block: true };

  it("puts an inline item where the trigger was, with its selection or the cursor after it", () => {
    expect(placed(timer, { from: 10, to: 13, before: "Tea ", after: " now", below: "" })).toEqual({ from: 10, to: 13, insert: "/timer(5m)", anchor: 17, head: 19 });
    expect(placed({ label: "Stopwatch", insert: "/stopwatch()" }, { from: 0, to: 2, before: "", after: "", below: null })).toMatchObject({ insert: "/stopwatch()", anchor: 12, head: 12 });
  });

  it("gives a block lines of its own and leaves the cursor on the line after it", () => {
    // Alone on the last line: a line is added for the cursor.
    expect(placed(board, { from: 20, to: 24, before: "", after: "", below: null })).toEqual({ from: 20, to: 24, insert: `${board.insert}\n`, anchor: 20 + board.insert.length + 1, head: 20 + board.insert.length + 1 });
    // Alone on a line with more below: the cursor goes to the line that is there.
    expect(placed(board, { from: 20, to: 24, before: "", after: "", below: "" })).toEqual({ from: 20, to: 24, insert: board.insert, anchor: 20 + board.insert.length + 1, head: 20 + board.insert.length + 1 });
    // After text: the text keeps its line.
    expect(placed(board, { from: 20, to: 24, before: "Plan: ", after: "", below: null })).toMatchObject({ from: 20, insert: `\n${board.insert}\n` });
    // Before text: the text goes to the line after, with the cursor.
    expect(placed(board, { from: 20, to: 24, before: "", after: "rest", below: "" })).toMatchObject({ insert: `${board.insert}\n`, anchor: 20 + board.insert.length + 1 });
    // After only blank space: the blank space goes, since a block starts its line.
    expect(placed(board, { from: 22, to: 24, before: "  ", after: "", below: null })).toMatchObject({ from: 20, to: 24, insert: `${board.insert}\n` });
  });

  it("takes a quote's or a list item's mark that is all that comes before a block, and keeps a block that asks apart from words under it", () => {
    const heading = { label: "Heading 2", insert: "## ", block: true, select: [3, 3] as const };
    const table = { label: "Table", insert: "| a |\n| - |", block: true, apart: true };
    expect(placed(heading, { from: 22, to: 25, before: "- ", after: "", below: null })).toEqual({ from: 20, to: 25, insert: "## ", anchor: 23, head: 23 });
    expect(placed(table, { from: 20, to: 24, before: "", after: "", below: "Words" })).toEqual({ from: 20, to: 24, insert: "| a |\n| - |\n", anchor: 32, head: 32 });
    expect(placed(table, { from: 20, to: 24, before: "", after: "rest", below: null })).toEqual({ from: 20, to: 24, insert: "| a |\n| - |\n\n", anchor: 33, head: 33 });
    expect(placed(table, { from: 20, to: 24, before: "", after: "", below: "" })).toEqual({ from: 20, to: 24, insert: "| a |\n| - |", anchor: 32, head: 32 });
  });

  it("puts the cursor in a block that says where, adding a line after it only for the rest of its line", () => {
    const heading = { label: "Heading 1", insert: "# ", block: true, select: [2, 2] as const };
    const code = { label: "Code block", insert: "```\n\n```", block: true, select: [4, 4] as const };
    expect(placed(heading, { from: 20, to: 23, before: "", after: "", below: null })).toEqual({ from: 20, to: 23, insert: "# ", anchor: 22, head: 22 });
    expect(placed(heading, { from: 26, to: 29, before: "Plan: ", after: "", below: null })).toEqual({ from: 26, to: 29, insert: "\n# ", anchor: 29, head: 29 });
    expect(placed(code, { from: 20, to: 23, before: "", after: "rest", below: "" })).toEqual({ from: 20, to: 23, insert: "```\n\n```\n", anchor: 24, head: 24 });
  });
});
