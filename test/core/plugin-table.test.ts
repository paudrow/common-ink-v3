import { describe, expect, it } from "vitest";
import { addColumn, addRow, parseTable, pipedPart, removeColumn, removeRow, serializeTable, setCell } from "../../src/web/plugins/tables/table.ts";

const PRETTY = ["| Name  | Qty | Note      |", "| ----- | --: | :-------: |", "| Pens  | 12  | blue      |", "| Paper | 500 | a \\| b    |", "|       |     | **heavy** |"].join("\n");

describe("a table", () => {
  it("is read into a header, how each column is aligned, and rows of what the cells say", () => {
    expect(parseTable(PRETTY)).toEqual({
      aligns: [null, "right", "center"],
      rows: [
        ["Name", "Qty", "Note"],
        ["Pens", "12", "blue"],
        ["Paper", "500", "a | b"],
        ["", "", "**heavy**"],
      ],
    });
  });

  it("that is written with its columns lined up is written the same again", () => {
    expect(serializeTable(parseTable(PRETTY)!)).toBe(PRETTY);
  });

  it("that is written loosely says the same after being written again", () => {
    const loose = "Name|Qty\n:-|-:\nPens|12\n|Paper|500|\n";
    const again = serializeTable(parseTable(loose)!);

    expect(again).toBe("| Name  | Qty |\n| :---- | --: |\n| Pens  | 12  |\n| Paper | 500 |");
    expect(parseTable(again)).toEqual(parseTable(loose));
  });

  it("keeps a cell that a short header would leave out, by widening the table", () => {
    expect(parseTable("| a | b |\n| - | - |\n| 1 | 2 | 3 |")).toEqual({ aligns: [null, null, null], rows: [["a", "b", ""], ["1", "2", "3"]] });
  });

  it("isn't read from text that isn't one, or from one that is indented or quoted", () => {
    for (const text of ["just words", "| a | b |", "| a | b |\n| c | d |", "| a | b |\n| - |", "  | a |\n  | - |", "> | a |\n> | - |", "words\n| - |", "| a |\n| - |\nwords after"]) expect(parseTable(text), text).toBeNull();
  });

  it("is drawn down to the first line with no pipe, which stays a line of text under it", () => {
    expect(pipedPart("| a | b |\n| - | - |\n| 1 | 2 |\nwords after\n| 3 | 4 |")).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(pipedPart("| a |\n| - |\nwords after")).toBe("| a |\n| - |");
    expect(pipedPart("| a |\n| - |\n| 1 |")).toBe("| a |\n| - |\n| 1 |");
    expect(parseTable(pipedPart("| a | b |\n| - | - |\n| 1 | 2 |\nwords after"))).toEqual({ aligns: [null, null], rows: [["a", "b"], ["1", "2"]] });
  });
});

describe("editing a table", () => {
  const table = parseTable("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |")!;
  const written = (t: typeof table) => serializeTable(t).split("\n");

  it("changes one cell and leaves the rest", () => {
    expect(written(setCell(table, [2, 1], "four | 4"))).toEqual(["| a   | b         |", "| --- | --------- |", "| 1   | 2         |", "| 3   | four \\| 4 |"]);
    expect(parseTable(serializeTable(setCell(table, [0, 0], "A")))!.rows).toEqual([["A", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("writes a line break typed into a cell as a space, so the row stays one line", () => {
    expect(written(setCell(table, [1, 0], "one\ntwo"))[2]).toBe("| one two | 2   |");
  });

  it("adds an empty row after a row, and an empty column after a column", () => {
    expect(addRow(table, 1).rows).toEqual([["a", "b"], ["1", "2"], ["", ""], ["3", "4"]]);
    expect(addColumn(table, 0)).toEqual({ aligns: [null, null, null], rows: [["a", "", "b"], ["1", "", "2"], ["3", "", "4"]] });
  });

  it("removes a row or a column, but never the header or the last column", () => {
    expect(removeRow(table, 1).rows).toEqual([["a", "b"], ["3", "4"]]);
    expect(removeRow(table, 0)).toBe(table);
    expect(removeColumn(table, 0).rows).toEqual([["b"], ["2"], ["4"]]);
    expect(removeColumn(removeColumn(table, 0), 0).rows).toEqual([["b"], ["2"], ["4"]]);
  });
});
