import { expect, test } from "vitest";
import { leadIn, spaced } from "../../src/web/plugins/gfm/lists.ts";

test("what stands before a list item's words is its indent, its mark, the space after, and a task's box", () => {
  expect(leadIn("- words")).toBe("- ");
  expect(leadIn("* words")).toBe("* ");
  expect(leadIn("+   words")).toBe("+   ");
  expect(leadIn("1. words")).toBe("1. ");
  expect(leadIn("10) words")).toBe("10) ");
  expect(leadIn("    - words")).toBe("    - ");
  expect(leadIn("\t- [ ] words")).toBe("\t- [ ] ");
  expect(leadIn("- [x] words")).toBe("- [x] ");
  expect(leadIn("- [X]  words")).toBe("- [X]  ");
  // A box with no space after it is the item's first word, as the checkbox's own rule has it.
  expect(leadIn("- [ ]words")).toBe("- ");
});

test("a line that doesn't begin an item has nothing before its words", () => {
  for (const line of ["words", "-words", "1.words", "  words - more", "> - quoted", "", "---"]) expect(leadIn(line)).toBe("");
});

test("a tab is as many spaces as reach the next stop", () => {
  expect(spaced("\t- ", 4)).toBe("    - ");
  expect(spaced("  \t- ", 4)).toBe("    - ");
  expect(spaced("\t\t1. ", 4)).toBe("        1. ");
  expect(spaced(" \t", 2)).toBe("  ");
  expect(spaced("- ", 4)).toBe("- ");
});
