import { describe, expect, it } from "vitest";
import { spliceLines } from "../../src/core/text.ts";

describe("splicing lines of a note", () => {
  it("replaces, inserts and deletes whole lines, and keeps a newline after the last line", () => {
    expect(spliceLines("alpha\nbeta\ngamma", [{ from: 1, to: 2, text: "BETA" }])).toBe("alpha\nBETA\ngamma");
    expect(spliceLines("alpha\nbeta\ngamma", [{ from: 1, to: 1, text: "x" }])).toBe("alpha\nx\nbeta\ngamma");
    expect(spliceLines("alpha\nbeta\ngamma", [{ from: 0, to: 1, text: "" }])).toBe("beta\ngamma");
    expect(spliceLines("alpha\nbeta\n", [{ from: 0, to: 1, text: "ALPHA" }])).toBe("ALPHA\nbeta\n");
    expect(spliceLines("alpha\nbeta", [{ from: 0, to: 1, text: "ALPHA\n" }])).toBe("ALPHA\nbeta");
    expect(spliceLines("alpha\nbeta\ngamma", [{ from: 3, to: 3, text: "delta" }])).toBe("alpha\nbeta\ngamma\ndelta");
    expect(spliceLines("", [{ from: 0, to: 0, text: "Hi\n" }])).toBe("Hi");
    expect(spliceLines("alpha\nbeta", [{ from: 0, to: 2, text: "" }])).toBe("");
    expect(spliceLines("alpha\nbeta\n", [{ from: 1, to: 1, text: "\n" }])).toBe("alpha\n\nbeta\n");
    expect(spliceLines("alpha\nbeta", [{ from: 1, to: 2, text: "B\nC\n" }])).toBe("alpha\nB\nC");
  });

  it("applies several ranges to the lines as read, including two that meet", () => {
    expect(spliceLines("a\nb\nc\nd", [{ from: 3, to: 4, text: "D" }, { from: 0, to: 1, text: "A" }])).toBe("A\nb\nc\nD");
    expect(spliceLines("a\nb\nc", [{ from: 0, to: 1, text: "" }, { from: 1, to: 2, text: "B" }])).toBe("B\nc");
  });

  it("replaces a line with more lines than a call can pass as arguments", () => {
    const lines = Array.from({ length: 110_000 }, () => "a");
    expect(spliceLines("keep\nthis", [{ from: 1, to: 2, text: lines.join("\n") }]).split("\n")).toEqual(["keep", ...lines]);
  });

  it("refuses a range outside the note and two that overlap, and changes nothing by being asked", () => {
    expect(() => spliceLines("a\nb", [{ from: 0, to: 3, text: "x" }])).toThrow("This note has 2 lines at that revision, counted from 0.");
    expect(() => spliceLines("a\nb", [{ from: 2, to: 1, text: "x" }])).toThrow("2 to 1 stops first");
    expect(() => spliceLines("a\nb\nc", [{ from: 0, to: 2, text: "x" }, { from: 1, to: 3, text: "y" }])).toThrow("Line ranges 0 to 2 and 1 to 3 overlap.");
    expect(spliceLines("a\nb", [])).toBe("a\nb");
  });
});
