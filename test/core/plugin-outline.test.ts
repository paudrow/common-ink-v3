import { describe, expect, it } from "vitest";
import { applied, indent, indentOf, itemAt, linesOf, move, outdent } from "../../src/web/plugins/bullets/outline.ts";

const OUTLINE = ["# Trip", "", "- pack", "  - socks", "    - wool", "  - maps", "- book", "  - train", "", "- go", "", "After."].join("\n");
const lineOf = (text: string, says: string) => text.split("\n").findIndex((line) => line.trim() === says);
const edit = (text: string, says: string, make: (lines: ReturnType<typeof linesOf>, n: number) => ReturnType<typeof indent>) => {
  const made = make(linesOf(text), lineOf(text, says));
  return made && applied(text, made);
};

describe("a bullet", () => {
  it("has under it the lines after it that are further in", () => {
    const lines = linesOf(OUTLINE);

    expect(itemAt(lines, lineOf(OUTLINE, "- pack"))).toMatchObject({ line: 2, end: 6, indent: 0, inside: 2 });
    expect(itemAt(lines, lineOf(OUTLINE, "- socks"))).toMatchObject({ line: 3, end: 5, indent: 2 });
    expect(itemAt(lines, lineOf(OUTLINE, "- book"))).toMatchObject({ line: 6, end: 8 });
    expect(itemAt(lines, lineOf(OUTLINE, "- go"))).toMatchObject({ line: 9, end: 10 });
    expect(itemAt(lines, 0)).toBeNull();
    expect(itemAt(lines, 11)).toBeNull();
  });

  it("counts what is under a numbered item from past its number", () => {
    expect(itemAt(linesOf("10. ten\n    - under"), 0)).toMatchObject({ end: 2, inside: 4 });
  });
});

describe("a tab before a bullet", () => {
  it("runs to the next multiple of four columns, as CommonMark counts it", () => {
    expect(["\t- a", "  \t- a", "    - a", " \t \t- a", "- a"].map(indentOf)).toEqual([4, 4, 4, 8, 0]);
  });

  it("puts a bullet under the one above it, beside one written with spaces", () => {
    const text = "- a\n\t- tab child\n  - space child\n- b";

    // The tab child is four columns in, further than the space child, so the space child is not under it.
    expect(itemAt(linesOf(text), 0)).toMatchObject({ end: 3 });
    expect(itemAt(linesOf(text), 1)).toMatchObject({ indent: 4, end: 2 });
    expect(itemAt(linesOf(text), 2)).toMatchObject({ indent: 2, end: 3 });
  });

  it("is written as spaces when its bullet is moved in or out, and says how far the text moved along the line", () => {
    const text = "- a\n\t- child\n\t\t- deeper";
    const made = outdent(linesOf(text), 1)!;

    expect(applied(text, made)).toBe("- a\n- child\n    - deeper");
    expect(made.shift).toBe(-1);
    expect(applied("- a\n- b\n\t- c", indent(linesOf("- a\n- b\n\t- c"), 1)!)).toBe("- a\n  - b\n      - c");
  });
});

describe("moving a bullet", () => {
  it("down takes what is under it past the next bullet and what is under that", () => {
    expect(edit(OUTLINE, "- pack", (l, n) => move(l, n, 1))).toBe(["# Trip", "", "- book", "  - train", "- pack", "  - socks", "    - wool", "  - maps", "", "- go", "", "After."].join("\n"));
  });

  it("up and then down again leaves the note as it was", () => {
    for (const says of ["- book", "- go", "- maps"]) {
      const up = edit(OUTLINE, says, (l, n) => move(l, n, -1))!;
      expect(up, says).not.toBe(OUTLINE);
      expect(edit(up, says, (l, n) => move(l, n, 1)), says).toBe(OUTLINE);
    }
  });

  it("keeps a blank line between two bullets between them", () => {
    expect(edit(OUTLINE, "- go", (l, n) => move(l, n, -1))).toBe(["# Trip", "", "- pack", "  - socks", "    - wool", "  - maps", "- go", "", "- book", "  - train", "", "After."].join("\n"));
  });

  it("stays among its own siblings: the first doesn't move up, the last doesn't move down, and neither leaves its parent", () => {
    expect(edit(OUTLINE, "- pack", (l, n) => move(l, n, -1))).toBeNull();
    expect(edit(OUTLINE, "- go", (l, n) => move(l, n, 1))).toBeNull();
    expect(edit(OUTLINE, "- socks", (l, n) => move(l, n, -1))).toBeNull();
    expect(edit(OUTLINE, "- maps", (l, n) => move(l, n, 1))).toBeNull();
    expect(edit(OUTLINE, "- train", (l, n) => move(l, n, 1))).toBeNull();
  });

  it("says where each line it moved has gone, so the cursor and the folds go with them", () => {
    const made = move(linesOf(OUTLINE), lineOf(OUTLINE, "- pack"), 1)!;

    expect([2, 3, 4, 5, 6, 7].map(made.after)).toEqual([4, 5, 6, 7, 2, 3]);
    expect(move(linesOf(OUTLINE), lineOf(OUTLINE, "- go"), -1)!.after(9)).toBe(6);
  });
});

describe("indenting a bullet", () => {
  it("puts it under the bullet before it, with what is under it", () => {
    expect(edit(OUTLINE, "- book", indent)).toBe(["# Trip", "", "- pack", "  - socks", "    - wool", "  - maps", "  - book", "    - train", "", "- go", "", "After."].join("\n"));
  });

  it("goes as far in as the bullet above writes its own text", () => {
    expect(edit("1. one\n2. two\n   - under", "2. two", indent)).toBe("1. one\n   2. two\n      - under");
  });

  it("does nothing for the first bullet of a list, which has nothing to go under", () => {
    expect(edit(OUTLINE, "- pack", indent)).toBeNull();
    expect(edit(OUTLINE, "- socks", indent)).toBeNull();
    expect(edit(OUTLINE, "After.", indent)).toBeNull();
  });

  it("and outdenting it again leaves the note as it was", () => {
    for (const says of ["- book", "- maps", "- go"]) expect(edit(edit(OUTLINE, says, indent)!, says, outdent), says).toBe(OUTLINE);
  });
});

describe("outdenting a bullet", () => {
  it("puts it beside the bullet it was under, with what is under it", () => {
    expect(edit(OUTLINE, "- socks", outdent)).toBe(["# Trip", "", "- pack", "- socks", "  - wool", "  - maps", "- book", "  - train", "", "- go", "", "After."].join("\n"));
  });

  it("does nothing for a bullet that is under nothing", () => {
    expect(edit(OUTLINE, "- pack", outdent)).toBeNull();
  });
});
