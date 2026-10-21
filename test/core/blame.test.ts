import { describe, expect, it } from "vitest";
import { blame, reline, runsOfLines, tickedLines } from "../../src/core/blame.ts";
import { reverting, settledRevert, type Choice, type Recorded } from "../../src/core/history.ts";
import type { Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween, toDoc } from "../../src/core/text.ts";

/** A revert of the changes named, with each of its conflicts settled as chosen, or every later edit kept. */
interface Revert {
  revert: number[];
  how?: Reverts["how"];
  choices?: Choice[];
}

/** A note written as each text in turn, and reverted at each revert, as the app records reverts. */
function noteOf(steps: readonly (string | Revert)[]): { text: string; history: Recorded[] } {
  const history: Recorded[] = [];
  let text = "";
  for (const step of steps) {
    const revision = history.length + 1;
    if (typeof step === "string") {
      history.push({ revision, reverts: null, changes: changesBetween(text, step) });
      text = step;
      continue;
    }
    const reverts: Reverts = { how: step.how ?? "revert", revisions: step.revert };
    const found = reverting(history, reverts, text);
    const { changes, resolution } = settledRevert(found, text, step.choices ?? found.conflicts.map(() => "keep"));
    history.push({ revision, reverts, changes, resolution });
    text = applyChanges(changes, text);
  }
  return { text, history };
}

/** The revision that last wrote each line, after the note `steps` make. */
function blameOf(...steps: (string | Revert)[]): number[] {
  return blame(noteOf(steps).history);
}

/** Each line of the note `steps` make, after the revision that last wrote it. */
function linesOf(...steps: (string | Revert)[]): string[] {
  const { text, history } = noteOf(steps);
  const by = blame(history);
  return text ? text.split("\n").map((line, i) => `${by[i]} ${line}`) : [];
}

/** Random histories of a few edits each, the same every run: whole lines put in, taken out, edited and moved. */
function* randomHistories(count: number): Generator<string[]> {
  let seed = 7;
  const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const words = ["a", "b", "", "c d", "e"];
  for (let trial = 0; trial < count; trial++) {
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
    yield texts;
  }
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

describe("who wrote each line a revert brings back", () => {
  it("gives a line a revert puts back to the change that wrote it", () => {
    expect(linesOf("a", "a\nb", "a\nb\nc", "a\nc", { revert: [4] })).toEqual(["1 a", "2 b", "3 c"]);
  });

  it("gives a line a revert edits back to the change that wrote it as it was", () => {
    expect(linesOf("one\ntwo", "one\ntwo, more", "one\nTWO, more", { revert: [3] })).toEqual(["1 one", "2 two, more"]);
    expect(linesOf("one two\nthree", "one 2\nthree", "one 2\nthree, four", { revert: [2] })).toEqual(["1 one two", "3 three, four"]);
  });

  it("gives the lines of a note reverted to a revision to the changes that wrote them by then", () => {
    expect(linesOf("a", "a\nb", "x\nb", "x", { revert: [3, 4] })).toEqual(["1 a", "2 b"]);
  });

  it("gives lines a revert of a revert puts back to the change the first revert took out", () => {
    expect(linesOf("a\nb", "a\nb\nc", { revert: [2] }, { revert: [3] })).toEqual(["1 a", "1 b", "2 c"]);
    expect(linesOf("a\nb\nc", "a\nc", { revert: [2] }, { revert: [3] }, { revert: [4] })).toEqual(["1 a", "1 b", "1 c"]);
    expect(linesOf("a\nb", "a\nB", { revert: [2], how: "undo" }, { revert: [3], how: "redo" })).toEqual(["1 a", "2 B"]);
  });

  it("gives a line a revert writes anew, by hand or mixed with a later edit, to the revert, and a line it puts back as it was to who wrote it", () => {
    const history = ["a\nb", "a\nB", "a\nBee"];
    expect(linesOf(...history, { revert: [2], choices: [{ text: "b, by hand" }] })).toEqual(["1 a", "4 b, by hand"]);
    expect(linesOf(...history, { revert: [2], choices: [{ text: "b\nby hand" }] })).toEqual(["1 a", "1 b", "4 by hand"]);
    expect(linesOf(...history, { revert: [2], choices: ["back"] })).toEqual(["1 a", "1 b"]);
    expect(linesOf(...history, { revert: [2], choices: ["keep"] })).toEqual(["1 a", "3 Bee"]);
    expect(linesOf("a\nb", "a\nB", "a\nB!", { revert: [2] })).toEqual(["1 a", "4 b!"]);
  });

  it("gives back who wrote each line before a change when that change is reverted", () => {
    for (const texts of randomHistories(60)) {
      for (let last = 1; last <= texts.length; last++) {
        const upTo = texts.slice(0, last);
        expect(blameOf(...upTo, { revert: [last] }), upTo.join(" | ")).toEqual(blameOf(...upTo.slice(0, -1)));
      }
    }
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
    for (const texts of randomHistories(60)) {
      let stepped: number[] = [];
      for (const [i, text] of texts.entries()) stepped = reline(stepped, changesBetween(texts[i - 1] ?? "", text), toDoc(texts[i - 1] ?? ""), i + 1);
      const whole = blameOf(...texts);
      expect(stepped, texts.join(" | ")).toEqual(whole);
      const final = texts.at(-1)!;
      expect(whole).toHaveLength(final ? final.split("\n").length : 0);
    }
  });
});

describe("when each done todo was ticked", () => {
  /** The revision that ticked each line of the note the texts make, one change after another from an empty note. */
  const ticked = (...texts: string[]) => tickedLines(texts.map((text, i) => changesBetween(i ? texts[i - 1]! : "", text)));

  it("is the change that ticked it, kept through an edit of its words in the same save as a line written above it", () => {
    expect(ticked("x\n- [ ] b", "x\n- [x] b", "x\nnew line\n- [x] b edited")).toEqual([0, 0, 2]);
  });

  it("is never another todo's: a save that takes out one ticked line and edits the next gives the edited one that save's date", () => {
    expect(ticked("- [ ] a\n- [ ] b", "- [x] a\n- [ ] b", "- [x] a\n- [x] b", "- [x] b edited")).toEqual([4]);
  });

  it("is new when a todo is ticked again, and none for an open one", () => {
    expect(ticked("- [ ] a\n- [ ] b", "- [x] a\n- [ ] b", "- [ ] a\n- [ ] b", "- [x] a\n- [ ] b")).toEqual([4, 0]);
  });
});
