import { describe, expect, it } from "vitest";
import { blame, reline, runsOfLines } from "../../src/core/blame.ts";
import { changesBetween, toDoc } from "../../src/core/text.ts";

/** The revision that last wrote each line, after a note was written as each text in turn. */
function blameOf(...texts: string[]): number[] {
  const changes = texts.map((text, i) => changesBetween(texts[i - 1] ?? "", text));
  return blame(changes);
}

describe("who wrote each line", () => {
  it("names the change that wrote each line", () => {
    expect(blameOf("a", "a\nb", "a\nb\nc")).toEqual([1, 2, 3]);
    expect(blameOf("b", "a\nb")).toEqual([2, 1]);
  });

  it("names the change that last edited a line, and leaves the lines around it", () => {
    expect(blameOf("a\nb\nc", "a\nbee\nc")).toEqual([1, 2, 1]);
    expect(blameOf("one two three\nfour", "one 2 three\nfour", "one 2 3\nfour")).toEqual([3, 1]);
  });

  it("takes a word taken out of a line for an edit of that line", () => {
    expect(blameOf("one two\nthree", "one\nthree")).toEqual([2, 1]);
  });

  it("leaves the lines around lines taken out or put in as they were", () => {
    expect(blameOf("a\nb\nc", "a\nc")).toEqual([1, 1]);
    expect(blameOf("a\nb", "a\n\nb")).toEqual([1, 2, 1]);
    expect(blameOf("a\nb", "a\nb\n")).toEqual([1, 1, 2]);
    expect(blameOf("a\nb\nc", "a\nx\ny\nc")).toEqual([1, 2, 2, 1]);
  });

  it("takes joining two lines or splitting one for an edit of them", () => {
    expect(blameOf("a\nb\nc", "ab\nc")).toEqual([2, 1]);
    expect(blameOf("ab\nc", "a\nb\nc")).toEqual([2, 2, 1]);
  });

  it("names several edits of one line in one change once", () => {
    expect(blameOf("a b c\nd", "x b y\nd")).toEqual([2, 1]);
  });

  it("has no lines for a note with no text", () => {
    expect(blame([])).toEqual([]);
    expect(blameOf("a\nb", "")).toEqual([]);
    expect(blameOf("a", "", "b")).toEqual([3]);
  });

  it("gives back a line that was taken out to the change that put it back", () => {
    expect(blameOf("a\nb\nc", "a\nc", "a\nb\nc")).toEqual([1, 3, 1]);
  });

  it("counts runs of lines one change wrote", () => {
    expect(runsOfLines([1, 1, 3, 2, 2, 2])).toEqual([
      { from: 1, to: 2, revision: 1 },
      { from: 3, to: 3, revision: 3 },
      { from: 4, to: 6, revision: 2 },
    ]);
    expect(runsOfLines([])).toEqual([]);
  });
});

describe("moving who wrote each line over an edit", () => {
  const step = (lines: string[], before: string, after: string) => reline(lines, changesBetween(before, after), toDoc(before), "new");

  it("marks the lines an edit writes and keeps the rest", () => {
    expect(step(["a", "b", "c"], "x\ny\nz", "x\nY\nz")).toEqual(["a", "new", "c"]);
    expect(step(["a", "b"], "x\ny", "x\nw\ny")).toEqual(["a", "new", "b"]);
    expect(step(["a", "b"], "x\ny", "y")).toEqual(["b"]);
    expect(step([], "", "x\ny")).toEqual(["new", "new"]);
    expect(step(["a"], "x", "")).toEqual([]);
  });

  it("comes to what reading the whole history does, one edit at a time", () => {
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const words = ["a", "b", "", "c d", "e"];
    for (let trial = 0; trial < 60; trial++) {
      const texts: string[] = [];
      let lines = Array.from({ length: random(5) }, () => words[random(words.length)]!);
      for (let i = 0; i < 8; i++) {
        const at = random(lines.length + 1);
        const what = random(4);
        if (what === 0) lines = [...lines.slice(0, at), words[random(words.length)]!, ...lines.slice(at)];
        else if (what === 1) lines = lines.filter((_, n) => n !== at);
        else if (what === 2 && lines.length) lines = lines.map((line, n) => (n === at ? `${line}${words[random(words.length)]}` : line));
        else lines = [...lines.slice(0, at), ...lines.slice(at + 1).reverse()];
        texts.push(lines.join("\n"));
      }
      let stepped: number[] = [];
      for (const [i, text] of texts.entries()) stepped = reline(stepped, changesBetween(texts[i - 1] ?? "", text), toDoc(texts[i - 1] ?? ""), i + 1);
      const whole = blameOf(...texts);
      expect(stepped, texts.join(" | ")).toEqual(whole);
      const final = texts.at(-1)!;
      expect(whole).toHaveLength(final ? final.split("\n").length : 0);
    }
  });
});
