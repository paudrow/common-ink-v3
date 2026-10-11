import { describe, expect, it } from "vitest";
import { lineDiff, MAX_DIFF_LINES } from "../../src/core/diff.ts";
import { changesBetween } from "../../src/core/text.ts";

const diff = (before: string, after: string) => lineDiff(before, changesBetween(before, after));
const marks = (before: string, after: string) => diff(before, after).hunks.map((h) => h.lines.map((l) => `${{ same: " ", add: "+", del: "-" }[l.kind]}${l.text}`));

describe("a line diff", () => {
  it("shows a changed word as its whole line removed and added, with the lines around it", () => {
    expect(marks("one\ntwo\nthree\nfour\nfive\nsix", "one\ntwo\nthree\nFOUR\nfive\nsix")).toEqual([[" two", " three", "-four", "+FOUR", " five", " six"]]);
  });

  it("shows a line added after another as one added line, not a rewrite of its neighbour", () => {
    expect(marks("# Plan", "# Plan\nStep one")).toEqual([[" # Plan", "+Step one"]]);
    expect(marks("a\nc", "a\nb\nc")).toEqual([[" a", "+b", " c"]]);
    expect(marks("", "# New\nmore")).toEqual([["+# New", "+more"]]);
    expect(marks("# Old\nmore", "")).toEqual([["-# Old", "-more"]]);
  });

  it("shows a removed line, and two lines joined into one", () => {
    expect(marks("a\nb\nc", "a\nc")).toEqual([[" a", "-b", " c"]]);
    expect(marks("a\nb", "ab")).toEqual([["-a", "-b", "+ab"]]);
  });

  it("splits changes far apart into hunks that say where they start, and joins ones close together", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const edited = lines.map((l, i) => (i === 1 || i === 15 ? l.toUpperCase() : l));
    edited.splice(5, 0, "added");

    const far = lineDiff(lines.join("\n"), changesBetween(lines.join("\n"), edited.join("\n")));

    expect(far.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
      [1, 1],
      [14, 15],
    ]);
    expect(far.hunks[0]!.lines.map((l) => l.kind).join(" ")).toBe("same del add same same same add same same");
    expect([far.added, far.removed]).toEqual([3, 2]);
  });

  it("counts every changed line but leaves out the lines past its limit", () => {
    const long = Array.from({ length: MAX_DIFF_LINES + 50 }, (_, i) => `row ${i}`).join("\n");

    const added = diff("# Title", `# Title\n${long}`);

    expect(added.added).toBe(MAX_DIFF_LINES + 50);
    expect(added.hunks.flatMap((h) => h.lines)).toHaveLength(MAX_DIFF_LINES);
    expect(added.omitted).toBe(51);
  });

  it("is empty for a change that changes nothing", () => {
    expect(diff("same", "same")).toEqual({ hunks: [], added: 0, removed: 0, omitted: 0 });
  });
});
