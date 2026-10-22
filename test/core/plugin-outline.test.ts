import { describe, expect, it } from "vitest";
import { applied, indent, indentOf, itemAt, linesOf, move, outdent } from "../../src/web/plugins/bullets/outline.ts";

const OUTLINE = ["# Trip", "", "- pack", "  - socks", "    - wool", "  - maps", "- book", "  - train", "", "- go", "", "After."].join("\n");
const lineOf = (text: string, says: string) => text.split("\n").findIndex((line) => line.trim() === says);
const edit = (text: string, says: string, make: (lines: ReturnType<typeof linesOf>, n: number) => ReturnType<typeof indent>) => {
  const made = make(linesOf(text), lineOf(text, says));
  return made && applied(text, made);
};
/** The text after the edit on the lines from the one that says `first` through the one that says `last`, as a selection over them would make it. */
const across = (text: string, first: string, last: string, make: (lines: ReturnType<typeof linesOf>, n: number, last: number) => ReturnType<typeof indent>) => {
  const made = make(linesOf(text), lineOf(text, first), lineOf(text, last));
  return made && applied(text, made);
};
const down = (lines: ReturnType<typeof linesOf>, n: number, last = n) => move(lines, n, 1, last);
const up = (lines: ReturnType<typeof linesOf>, n: number, last = n) => move(lines, n, -1, last);

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

  it("is written as spaces when its bullet is moved in or out", () => {
    expect(applied("- a\n\t- child\n\t\t- deeper", outdent(linesOf("- a\n\t- child\n\t\t- deeper"), 1)!)).toBe("- a\n- child\n    - deeper");
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
    expect(edit("1. one\n2. two\n   - under", "2. two", indent)).toBe("1. one\n   1. two\n      - under");
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

describe("a selection over several bullets of one list", () => {
  const LIST = ["- a", "- b", "  - under b", "- c", "- d"].join("\n");

  it("moves them together, with what is under them", () => {
    expect(across(LIST, "- b", "- c", down)).toBe(["- a", "- d", "- b", "  - under b", "- c"].join("\n"));
    expect(across(LIST, "- b", "- c", up)).toBe(["- b", "  - under b", "- c", "- a", "- d"].join("\n"));
  });

  it("indents them together under the bullet before the first, and outdents them together", () => {
    const indented = ["- a", "  - b", "    - under b", "  - c", "- d"].join("\n");

    expect(across(LIST, "- b", "- c", indent)).toBe(indented);
    expect(across(indented, "- b", "- c", outdent)).toBe(LIST);
  });

  it("takes the bullets of the first one's list that start in the selection, each with what is under it", () => {
    expect(across(LIST, "- b", "- under b", indent)).toBe(["- a", "  - b", "    - under b", "- c", "- d"].join("\n"));
  });
});

describe("a numbered list", () => {
  it("is numbered in order again when an item moves, starting where it started", () => {
    expect(edit("1. one\n2. two\n3. three", "3. three", up)).toBe("1. one\n2. three\n3. two");
    expect(edit("3. one\n4. two\n5. three", "3. one", down)).toBe("3. two\n4. one\n5. three");
    expect(edit("1) one\n2) two", "1) one", down)).toBe("1) two\n2) one");
  });

  it("keeps the numbers of a list under a moved item as they were", () => {
    expect(edit("1. one\n   7. seven\n   8. eight\n2. two", "2. two", up)).toBe("1. two\n2. one\n   7. seven\n   8. eight");
  });

  it("numbers both lists when an item is indented: the one it left, and the one it joins or begins under the item above", () => {
    expect(edit("1. one\n2. two\n3. three\n4. four", "2. two", indent)).toBe("1. one\n   1. two\n2. three\n3. four");
    expect(edit("1. one\n   1. under\n2. two\n3. three", "2. two", indent)).toBe("1. one\n   1. under\n   2. two\n2. three");
  });

  it("numbers the list it joins, the list it left, and the items after it, which go under it, when an item is outdented", () => {
    expect(edit("1. one\n   1. a\n   2. b\n   3. c\n2. two", "2. b", outdent)).toBe("1. one\n   1. a\n2. b\n   1. c\n3. two");
  });

  it("goes back to how it was when an item is indented and outdented again", () => {
    const text = "1. one\n2. two\n3. three";

    expect(edit(edit(text, "2. two", indent)!, "1. two", outdent)).toBe(text);
  });

  it("takes what is under an item along when its number grows a column", () => {
    const text = ["1. one", "2. two", "3. three", "4. four", "5. five", "6. six", "7. seven", "8. eight", "9. nine", "10. ten", "    - under ten", "11. eleven"].join("\n");
    const nine = text.replace("9. nine\n10. ten\n    - under ten\n11. eleven", "9. ten\n   - under ten\n10. nine\n11. eleven");

    expect(edit(text, "10. ten", up)).toBe(nine);
    expect(edit(nine, "10. nine", up)).toBe(text);
  });

  it("leaves a bulleted list beside it alone, and is not numbered across a bullet", () => {
    expect(edit("- a\n- b\n\n1. one\n2. two", "- b", up)).toBe("- b\n- a\n\n1. one\n2. two");
    expect(edit("1. one\n- dash\n1. again\n2. more", "2. more", up)).toBe("1. one\n- dash\n1. more\n2. again");
  });

  it("is numbered in order across the blank lines of a loose list", () => {
    expect(edit("1. one\n\n2. two\n\n3. three", "3. three", up)).toBe("1. one\n\n2. three\n\n3. two");
  });

  it("is numbered on its own when a bullet moved past it leaves it a list of its own, and as one when a bullet moved out of it joins it", () => {
    expect(edit("- x\n1. a\n2. b", "1. a", up)).toBe("1. a\n- x\n1. b");
    expect(edit("- x\n1. a\n- y\n3. b", "- y", up)).toBe("- x\n- y\n1. a\n2. b");
  });

  it("changes only the lines whose numbers change", () => {
    const made = move(linesOf("1. one\n2. two\n3. three\n4. four\n5. five"), 4, -1)!;

    expect([made.from, made.to, made.lines]).toEqual([3, 5, ["4. five", "5. four"]]);
  });

  it("numbers todos in it like any item", () => {
    expect(edit("1. [ ] one\n2. [x] two", "2. [x] two", up)).toBe("1. [x] two\n2. [ ] one");
  });
});

describe("a numbered list written with one number on every item", () => {
  it("keeps it when an item moves", () => {
    expect(edit("1. one\n1. two\n1. three", "1. three", up)).toBe("1. one\n1. three\n1. two");
    expect(edit("3. one\n3. two", "3. one", down)).toBe("3. two\n3. one");
  });

  it("keeps it in the list an item leaves and the list it joins, and gives the item that number", () => {
    expect(edit("1. one\n1. two\n1. three\n1. four", "1. three", indent)).toBe("1. one\n1. two\n   1. three\n1. four");
    expect(edit("1. one\n2. two\n   1. a\n   1. b\n3. three", "3. three", indent)).toBe("1. one\n2. two\n   1. a\n   1. b\n   1. three");
    expect(edit("1. one\n   1. a\n   1. b\n2. two\n3. three", "2. two", indent)).toBe("1. one\n   1. a\n   1. b\n   1. two\n2. three");
  });

  it("gives that number to an item that joins a list of one from a list written that way", () => {
    expect(edit("1. one\n   1. a\n1. two\n1. three", "1. two", indent)).toBe("1. one\n   1. a\n   1. two\n1. three");
    expect(edit("1. one\n   1. a\n   1. b\n   1. c\n1. two", "1. b", outdent)).toBe("1. one\n   1. a\n1. b\n   1. c\n1. two");
  });

  it("is still numbered in order when only the item that moved in shares the number", () => {
    expect(edit("1. one\n   1. a\n   2. b", "1. a", outdent)).toBe("1. one\n2. a\n   1. b");
    expect(edit("- one\n  1. a\n1. two", "1. two", indent)).toBe("- one\n  1. a\n  2. two");
  });

  it("takes what is under an item along when the number it is given is a column shorter", () => {
    expect(edit("1. one\n2. two\n   1. a\n   1. b\n10. ten\n    - under ten", "10. ten", indent)).toBe("1. one\n2. two\n   1. a\n   1. b\n   1. ten\n      - under ten");
  });
});

describe("the two rules for indenting", () => {
  it("the first item of a list has nothing to go under, numbered or not", () => {
    expect(edit("1. one\n2. two", "1. one", indent)).toBeNull();
    expect(edit("- [ ] one\n- [ ] two", "- [ ] one", indent)).toBeNull();
  });

  it("an item goes in one level past the item above it and no further, however many times it is indented", () => {
    const once = edit("- a\n- b", "- b", indent)!;

    expect(once).toBe("- a\n  - b");
    expect(edit(once, "- b", indent)).toBeNull();
    expect(edit("- a\n  - x\n  - b", "- b", indent)).toBe("- a\n  - x\n    - b");
  });

  it("an item under nothing has nowhere to outdent to", () => {
    expect(edit("1. one\n2. two", "2. two", outdent)).toBeNull();
  });
});
