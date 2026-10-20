import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { blockAt, heightOf, heldMiddle, heldScroll, litLines, paragraphAt, roomFor } from "../../src/web/plugins/typewriter/hold.ts";

const TEXT = ["# Title", "", "One line,", "and its next.", "   ", "Alone.", "", "", "Last one", "ends here."].join("\n");
const state = EditorState.create({ doc: TEXT });
/** Where line `n` starts, plus `into` letters. */
const at = (n: number, into = 0) => state.doc.line(n).from + into;

describe("typewriter mode's paragraph", () => {
  it("is the run of lines with words around the cursor's, bounded by blank lines and the note's ends", () => {
    expect(paragraphAt(state, at(1, 3))).toEqual({ first: 1, last: 1 });
    expect(paragraphAt(state, at(3))).toEqual({ first: 3, last: 4 });
    expect(paragraphAt(state, at(4, 13))).toEqual({ first: 3, last: 4 });
    expect(paragraphAt(state, at(6, 2))).toEqual({ first: 6, last: 6 });
    expect(paragraphAt(state, at(10))).toEqual({ first: 9, last: 10 });
  });

  it("is a blank line alone when the cursor is on one, and a line of spaces is blank", () => {
    expect(paragraphAt(state, at(2))).toEqual({ first: 2, last: 2 });
    expect(paragraphAt(state, at(5, 1))).toEqual({ first: 5, last: 5 });
    expect(paragraphAt(state, at(8))).toEqual({ first: 8, last: 8 });
  });

  it("is the whole note when nothing in it is blank, and the one empty line of an empty note", () => {
    expect(paragraphAt(EditorState.create({ doc: "a\nb\nc" }), 2)).toEqual({ first: 1, last: 3 });
    expect(paragraphAt(EditorState.create({ doc: "" }), 0)).toEqual({ first: 1, last: 1 });
  });
});

describe("typewriter mode's lit lines with no syntax tree", () => {
  /** The note with these ranges selected, each as anchor and head. */
  const selected = (...ranges: [number, number][]) => EditorState.create({ doc: TEXT, selection: EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))), extensions: EditorState.allowMultipleSelections.of(true) });

  it("are the cursor's paragraph alone when nothing is selected", () => {
    expect(litLines(selected([at(4, 2), at(4, 2)]))).toEqual([{ first: 3, last: 4 }]);
    expect(litLines(selected([at(7), at(7)]))).toEqual([{ first: 7, last: 7 }]);
  });

  it("are every paragraph a selection touches, from the one it starts in to the one it ends in, whichever way it was made", () => {
    expect(litLines(selected([at(3, 1), at(6, 2)]))).toEqual([{ first: 3, last: 6 }]);
    expect(litLines(selected([at(6, 2), at(3, 1)]))).toEqual([{ first: 3, last: 6 }]);
    expect(litLines(selected([at(4, 3), at(5)]))).toEqual([{ first: 3, last: 5 }]);
    expect(litLines(selected([at(2), at(10, 4)]))).toEqual([{ first: 2, last: 10 }]);
  });

  it("are each cursor's paragraph with more than one, joined where they meet", () => {
    expect(litLines(selected([at(1), at(1)], [at(9), at(9)]))).toEqual([{ first: 1, last: 1 }, { first: 9, last: 10 }]);
    expect(litLines(selected([at(9), at(9)], [at(3), at(3)], [at(5), at(5)]))).toEqual([{ first: 3, last: 5 }, { first: 9, last: 10 }]);
  });
});

// As the note's editor parses it.
const MARKDOWN = [
  "# Groceries",
  "Some words under it,",
  "on two lines.",
  "",
  "- apples",
  "  and pears, on a second line",
  "  - green",
  "  - red",
  "- bread",
  "",
  "- [ ] milk",
  "- [x] eggs",
  "  still eggs",
  "",
  "> A quote",
  "> of two lines.",
  ">",
  "> Its second paragraph.",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```",
  "code",
  "",
  "more code",
  "```",
].join("\n");
/** The note with these ranges selected, each as anchor and head, and its syntax tree parsed to the end. */
const parsed = (doc: string, ...ranges: [number, number][]) => {
  const state = EditorState.create({
    doc,
    selection: ranges.length ? EditorSelection.create(ranges.map(([anchor, head]) => EditorSelection.range(anchor, head))) : undefined,
    extensions: [markdown({ base: markdownLanguage }), EditorState.allowMultipleSelections.of(true)],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  // The tree parsed reaches the state with its next transaction, as in an editor.
  return state.update({}).state;
};
const notes = parsed(MARKDOWN);
/** Where line `n` of the markdown starts, plus `into` letters. */
const on = (n: number, into = 0) => notes.doc.line(n).from + into;
/** The block of each of `lines`, by its line's middle letter. */
const blocksOf = (...lines: number[]) => lines.map((n) => blockAt(notes, on(n, Math.floor(notes.doc.line(n).length / 2))));

describe("typewriter mode's block", () => {
  it("is a list item's own lines, its wrapped line too, without the bullets inside it or beside it", () => {
    expect(blocksOf(5, 6)).toEqual([{ first: 5, last: 6 }, { first: 5, last: 6 }]);
    expect(blocksOf(7, 8, 9)).toEqual([{ first: 7, last: 7 }, { first: 8, last: 8 }, { first: 9, last: 9 }]);
    expect(blockAt(notes, on(5))).toEqual({ first: 5, last: 6 });
  });

  it("is a todo's own lines, as a list item's", () => {
    expect(blocksOf(11, 12, 13)).toEqual([{ first: 11, last: 11 }, { first: 12, last: 13 }, { first: 12, last: 13 }]);
  });

  it("is a heading alone over the paragraph right under it, and the paragraph's lines", () => {
    expect(blocksOf(1, 2, 3)).toEqual([{ first: 1, last: 1 }, { first: 2, last: 3 }, { first: 2, last: 3 }]);
  });

  it("is a paragraph of a quote, a whole table and a whole code block, with its blank line", () => {
    expect(blocksOf(15, 16, 17, 18)).toEqual([{ first: 15, last: 16 }, { first: 15, last: 16 }, { first: 17, last: 17 }, { first: 18, last: 18 }]);
    expect(blocksOf(20, 22)).toEqual([{ first: 20, last: 22 }, { first: 20, last: 22 }]);
    expect(blocksOf(24, 26, 28)).toEqual([{ first: 24, last: 28 }, { first: 24, last: 28 }, { first: 24, last: 28 }]);
  });

  it("is a blank line alone, between a list's items too", () => {
    expect(blocksOf(4, 10, 14)).toEqual([{ first: 4, last: 4 }, { first: 10, last: 10 }, { first: 14, last: 14 }]);
  });

  it("is the paragraph where the tree isn't parsed yet, far down a long note, and the bullet once it is", () => {
    const doc = Array.from({ length: 600 }, (_, i) => `- item ${i + 1}`).join("\n");
    const unparsed = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) });
    expect(blockAt(unparsed, unparsed.doc.line(590).from)).toEqual({ first: 1, last: 600 });
    expect(blockAt(unparsed, unparsed.doc.line(2).from)).toEqual({ first: 2, last: 2 });
    const whole = parsed(doc);
    expect(blockAt(whole, whole.doc.line(590).from)).toEqual({ first: 590, last: 590 });
  });
});

describe("typewriter mode's lit lines", () => {
  it("are every block a selection touches, from the one it starts in to the one it ends in, across two bullets", () => {
    expect(litLines(parsed(MARKDOWN, [on(9, 3), on(11, 4)]))).toEqual([{ first: 9, last: 11 }]);
    expect(litLines(parsed(MARKDOWN, [on(7, 5), on(6, 2)]))).toEqual([{ first: 5, last: 7 }]);
    expect(litLines(parsed(MARKDOWN, [on(8, 2), on(8, 2)], [on(2), on(2)]))).toEqual([{ first: 2, last: 3 }, { first: 8, last: 8 }]);
  });
});

describe("typewriter mode's height", () => {
  const pane = { top: 100, height: 600, scrollTop: 250 };
  /** A row 20 tall with its middle at `middle` on screen. */
  const row = (middle: number) => ({ top: middle - 10, bottom: middle + 10 });

  it("scrolls by how far the row's middle is from the height", () => {
    expect(heldScroll(pane, row(400), 0.5)).toBe(250);
    expect(heldScroll(pane, row(520), 0.5)).toBe(370);
    expect(heldScroll(pane, row(160), 0.3)).toBe(130);
    expect(heldScroll({ ...pane, scrollTop: 0 }, row(600), 0.8)).toBe(20);
  });

  it("keeps the whole row in the pane: at 0 its top is at the pane's top, at 1 its foot at the pane's foot", () => {
    expect(heldMiddle(pane, 20, 0)).toBe(10);
    expect(heldMiddle(pane, 20, 0.01)).toBe(10);
    expect(heldMiddle(pane, 20, 1)).toBe(590);
    expect(heldScroll(pane, row(400), 0)).toBe(540);
    expect(heldScroll(pane, row(400), 1)).toBe(-40);
  });

  it("reads a line's height in whole percent of the pane, from 0 to 100", () => {
    expect(heightOf(pane, 400)).toBe(50);
    expect(heightOf(pane, 283)).toBe(31);
    expect(heightOf(pane, 102)).toBe(0);
    expect(heightOf(pane, 90)).toBe(0);
    expect(heightOf(pane, 699)).toBe(100);
    expect(heightOf(pane, 750)).toBe(100);
  });

  it("makes room for the first row and the last to reach the height and no further", () => {
    expect(roomFor(pane, 0.5, { size: 20, lead: 4 }, { size: 20, trail: 4 })).toEqual({ above: 286, below: 286 });
    expect(roomFor(pane, 0.25, { size: 40, lead: 0 }, { size: 20, trail: 0 })).toEqual({ above: 130, below: 440 });
    expect(roomFor(pane, 0, { size: 20, lead: 4 }, { size: 20, trail: 4 })).toEqual({ above: 0, below: 576 });
    expect(roomFor(pane, 1, { size: 20, lead: 4 }, { size: 20, trail: 4 })).toEqual({ above: 576, below: 0 });
  });
});
