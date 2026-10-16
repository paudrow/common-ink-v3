import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH } from "../../src/web/plugin-api.ts";
import { shownTable, tableOf } from "../../src/web/plugins/uploads/delimited.ts";
import { fileIn, filePath, openingOf } from "../../src/web/plugins/uploads/opening.ts";
import { asNote, formatOf, textOf } from "../../src/web/plugins/uploads/reading.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("how a file opens", () => {
  it("is decided by what a person calls it: a picture, a video, a recording or a PDF in a preview, text in the app, anything else a download", () => {
    const of = (name: string, type: string) => openingOf({ name, type });
    expect([
      of("dot.png", "image/png"),
      of("clip.webm", "video/webm"),
      of("memo.wav", "audio/wav"),
      of("paper.pdf", "application/pdf"),
      of("notes.txt", "application/octet-stream"),
      of("table.csv", "application/octet-stream"),
      of("readme.md", "application/octet-stream"),
      of("archive.zip", "application/octet-stream"),
    ]).toEqual(["preview", "preview", "preview", "preview", "app", "app", "app", "download"]);
  });

  it("never opens HTML or SVG as a page: HTML is text read in the app, an SVG is a picture, and a PDF's name with other bytes is a download", () => {
    expect(openingOf({ name: "page.html", type: "application/octet-stream" })).toBe("app");
    expect(openingOf({ name: "drawing.svg", type: "image/svg+xml" })).toBe("preview");
    expect(openingOf({ name: "fake.pdf", type: "application/octet-stream" })).toBe("download");
  });

  it("previews a PDF in the app whether or not there is a site kept for files, and changes nothing else", () => {
    const kinds = [["dot.png", "image/png"], ["paper.pdf", "application/pdf"], ["notes.txt", "application/octet-stream"], ["archive.zip", "application/octet-stream"]] as const;
    expect(kinds.map(([name, type]) => openingOf({ name, type }))).toEqual(["preview", "preview", "app", "download"]);
  });

  it("in the app is at the file's own address, which names only the upload's id", () => {
    expect(filePath("abcdefgh1234")).toBe("/file/abcdefgh1234");
    expect(fileIn("/file/abcdefgh1234")).toBe("abcdefgh1234");
    expect([fileIn("/file"), fileIn("/file/"), fileIn("/file/ABC"), fileIn("/file/abcdefgh1234/x"), fileIn("/uploads/abcdefgh1234")]).toEqual([null, null, null, null, null]);
  });
});

describe("a file read as text", () => {
  it("is its words when its bytes are UTF-8, and not text at all when they aren't or hold a NUL", () => {
    expect(textOf(utf8("Grüße, 世界 ✓"), 19)).toEqual({ kind: "text", text: "Grüße, 世界 ✓", cut: false });
    expect(textOf(Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69), 5)).toEqual({ kind: "text", text: "hi", cut: false });
    expect(textOf(Uint8Array.of(0x68, 0xff, 0x69), 3)).toEqual({ kind: "binary" });
    expect(textOf(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 8)).toEqual({ kind: "binary" });
    expect(textOf(utf8("a\u0000b"), 3)).toEqual({ kind: "binary" });
    expect(textOf(new Uint8Array(0), 0)).toEqual({ kind: "text", text: "", cut: false });
  });

  it("is cut where the bytes read stop, and a character cut in two there is left out rather than taken for a fault", () => {
    const whole = utf8("ab✓");
    expect(textOf(whole.subarray(0, 4), 5)).toEqual({ kind: "text", text: "ab", cut: true });
    expect(textOf(whole.subarray(0, 2), 5)).toEqual({ kind: "text", text: "ab", cut: true });
    expect(textOf(Uint8Array.of(0x61, 0xff), 10)).toEqual({ kind: "binary" });
    // The whole file read, with a character cut short at its end, is not text.
    expect(textOf(whole.subarray(0, 4), 4)).toEqual({ kind: "binary" });
  });

  it("is drawn as markdown, as a table, or as code, by its name's ending", () => {
    expect(["a.md", "B.MARKDOWN", "t.csv", "t.tsv", "d.json", "x.log", "n.txt", "p.py", "page.html"].map(formatOf)).toEqual([
      { format: "markdown" },
      { format: "markdown" },
      { format: "table", separator: "," },
      { format: "table", separator: "\t" },
      { format: "code" },
      { format: "code" },
      { format: "code" },
      { format: "code" },
      { format: "code" },
    ]);
  });

  it("is copied into a note as it is for markdown and plain text, and as a block of code under the file's name for anything else", () => {
    expect(asNote("plan.md", "# Plan\n\nGo.\n")).toBe("# Plan\n\nGo.\n");
    expect(asNote("minutes.txt", "What was said.")).toBe("What was said.");
    expect(asNote("data.json", '{"a": 1}\n')).toBe('# data.json\n\n```json\n{"a": 1}\n```\n');
    expect(asNote("table.csv", "a,b\n1,2")).toBe("# table.csv\n\n```csv\na,b\n1,2\n```\n");
    expect(asNote("app.log", "ok")).toBe("# app.log\n\n```\nok\n```\n");
    expect(asNote("fence.md.txt", "x")).toBe("x");
    // A fence in the file is never taken for the end of the block.
    expect(asNote("readme.sh", "echo ```\n````")).toBe("# readme.sh\n\n`````sh\necho ```\n````\n`````\n");
  });

  it("is not offered as a note when it wouldn't fit in one", () => {
    expect(asNote("big.txt", "x".repeat(MAX_NOTE_LENGTH))).toBe("x".repeat(MAX_NOTE_LENGTH));
    expect(asNote("big.txt", "x".repeat(MAX_NOTE_LENGTH + 1))).toBeNull();
    expect(asNote("big.json", "x".repeat(MAX_NOTE_LENGTH - 10))).toBeNull();
  });
});

describe("a table read from comma- or tab-separated text", () => {
  it("is its rows and cells, with quoted cells holding commas, line breaks and doubled quotes", () => {
    expect(tableOf('name,note\nAda,"says ""hi"", then, leaves"\n"Bob","line one\nline two"\n', ",", 100)).toEqual({
      rows: [
        ["name", "note"],
        ["Ada", 'says "hi", then, leaves'],
        ["Bob", "line one\nline two"],
      ],
      width: 2,
      more: false,
    });
  });

  it("reads CRLF and a lone CR as line breaks, keeps empty cells, and has no row for a last line break", () => {
    expect(tableOf("a,b\r\n1,\r\n,2\r3,4\r\n", ",", 100)).toEqual({
      rows: [
        ["a", "b"],
        ["1", ""],
        ["", "2"],
        ["3", "4"],
      ],
      width: 2,
      more: false,
    });
    expect(tableOf('a,"x\r\ny"', ",", 100).rows).toEqual([["a", "x\r\ny"]]);
  });

  it("draws at most so many columns and so many cells, so a narrow file of very wide rows can't freeze the page", () => {
    const wide = tableOf(`${",".repeat(4999)}\n${"x\n".repeat(300)}`, ",", 1001);
    expect(wide.width).toBe(5000);
    const shown = shownTable(wide, { columns: 50, cells: 2000 });
    expect([shown.width, shown.rows.length, shown.rows.every((row) => row.length === 50), shown.columnsCut, shown.rowsCut]).toEqual([50, 40, true, true, true]);
    expect(shown.rows[1]).toEqual(["x", ...Array.from({ length: 49 }, () => "")]);
    const small = shownTable(tableOf("a,b\n1\n", ",", 1001), { columns: 50, cells: 2000 });
    expect(small).toEqual({ rows: [["a", "b"], ["1", ""]], width: 2, columnsCut: false, rowsCut: false });
  });

  it("keeps ragged rows as they are and is as wide as its widest", () => {
    expect(tableOf("a\nb,c,d\ne,f\n", ",", 100)).toEqual({ rows: [["a"], ["b", "c", "d"], ["e", "f"]], width: 3, more: false });
  });

  it("splits a TSV at tabs only, and reads a quote inside a cell as a quote", () => {
    expect(tableOf("a\tb,c\nsay \"x\"\t2\n", "\t", 100).rows).toEqual([
      ["a", "b,c"],
      ['say "x"', "2"],
    ]);
  });

  it("stops at the row cap and says there were more, but not for a cap met exactly", () => {
    const text = Array.from({ length: 5 }, (_, i) => `r${i},${i}`).join("\n");
    expect(tableOf(text, ",", 3)).toEqual({ rows: [["r0", "0"], ["r1", "1"], ["r2", "2"]], width: 2, more: true });
    expect(tableOf(`${text}\n`, ",", 5).more).toBe(false);
  });

  it("takes what follows a closing quote as part of the cell, and a quote left open as running to the end", () => {
    expect(tableOf('"a"b,c\n"open,d\ne', ",", 10).rows).toEqual([["ab", "c"], ["open,d\ne"]]);
    expect(tableOf("﻿h1,h2\n", ",", 10).rows).toEqual([["h1", "h2"]]);
    expect(tableOf("", ",", 10)).toEqual({ rows: [], width: 0, more: false });
  });
});
