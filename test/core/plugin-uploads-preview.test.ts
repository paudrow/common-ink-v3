import { describe, expect, it } from "vitest";
import { firstLines, MOST_PIXELS, pageFit, pagesSaid, pagesShown, previewOf } from "../../src/web/plugins/uploads/previewing.ts";
import { cardHeight } from "../../src/web/plugins/uploads/sizing.ts";

describe("what a file is previewed as", () => {
  it("is decided by what a person calls it, and for text by its name's ending", () => {
    const of = (name: string, type: string) => previewOf({ name, type });
    expect([
      of("dot.png", "image/png"),
      of("drawing.svg", "image/svg+xml"),
      of("clip.webm", "video/webm"),
      of("memo.wav", "audio/wav"),
      of("paper.pdf", "application/pdf"),
      of("cities.csv", "application/octet-stream"),
      of("cities.tsv", "application/octet-stream"),
      of("readme.md", "application/octet-stream"),
      of("notes.txt", "application/octet-stream"),
      of("page.html", "application/octet-stream"),
      of("fake.pdf", "application/octet-stream"),
      of("archive.zip", "application/octet-stream"),
    ]).toEqual([
      { shows: "picture" },
      { shows: "picture" },
      { shows: "player", media: "video" },
      { shows: "player", media: "audio" },
      { shows: "pages" },
      { shows: "rows", separator: "," },
      { shows: "rows", separator: "\t" },
      { shows: "lines" },
      { shows: "lines" },
      { shows: "lines" },
      { shows: "icon" },
      { shows: "icon" },
    ]);
  });
});

describe("a PDF's pages in a preview", () => {
  it("are at most three in a note, one in the Uploads page's panel and thirty over the app", () => {
    expect([pagesShown(12, "note"), pagesShown(12, "panel"), pagesShown(12, "overlay"), pagesShown(2, "note"), pagesShown(500, "overlay"), pagesShown(0, "note")]).toEqual([3, 1, 12, 2, 30, 0]);
  });

  it("say how many there are, and how many of them are shown when that is fewer", () => {
    expect([pagesSaid(1, 1), pagesSaid(2, 2), pagesSaid(5, 3), pagesSaid(3, 1), pagesSaid(1200, 30)]).toEqual(["1 page", "2 pages", "5 pages, the first 3 shown", "3 pages, the first one shown", "1,200 pages, the first 30 shown"]);
  });

  it("are drawn at the height asked for at the screen's pixel ratio, at their own shape", () => {
    expect(pageFit({ width: 612, height: 792 }, 264, 2)).toEqual({ scale: (264 * 2) / 792, pixels: { width: 408, height: 528 }, css: { width: 204, height: 264 } });
  });

  it("are never drawn with more than four million pixels, however large the page", () => {
    const poster = pageFit({ width: 14400, height: 14400 }, 1800, 2);
    expect(poster.pixels.width * poster.pixels.height).toBeLessThanOrEqual(MOST_PIXELS);
    expect(poster.pixels).toEqual({ width: 2000, height: 2000 });
    expect(poster.css).toEqual({ width: 1800, height: 1800 });
    const strip = pageFit({ width: 200_000, height: 10 }, 260, 2);
    expect(strip.pixels.width * strip.pixels.height).toBeLessThanOrEqual(MOST_PIXELS);
  });
});

describe("the first lines of text", () => {
  it("are as many as asked for, with whether there are more, whatever ends its lines", () => {
    expect(firstLines("one\r\ntwo\rthree\nfour\n", 3)).toEqual({ lines: ["one", "two", "three"], more: true });
    expect(firstLines("one\ntwo\n", 3)).toEqual({ lines: ["one", "two"], more: false });
    expect(firstLines("one\ntwo\nthree", 3)).toEqual({ lines: ["one", "two", "three"], more: false });
    expect(firstLines("", 3)).toEqual({ lines: [], more: false });
  });
});

describe("a file's card below its line", () => {
  it("is its head over a preview as tall as what it shows, known before the file is read, and its head alone with nothing to show", () => {
    const of = (name: string, type: string) => cardHeight(previewOf({ name, type }));
    expect([of("paper.pdf", "application/pdf"), of("dot.png", "image/png"), of("clip.webm", "video/webm"), of("memo.wav", "audio/wav"), of("cities.csv", "text/plain"), of("notes.txt", "text/plain"), of("archive.zip", "application/zip"), cardHeight(null)]).toEqual([326, 282, 282, 98, 240, 222, 42, 42]);
  });
});
