import { fileClass, type Upload } from "../../plugin-api.ts";
import { formatOf } from "./reading.ts";

/**
 * What a file is previewed as: a picture; a player for a video or a recording; the first pages of a
 * PDF, drawn by pdf.js; the first rows of a CSV or TSV; the first lines of markdown or other text;
 * and, for anything else, a large icon of its type.
 */
export type Preview = { shows: "picture" } | { shows: "player"; media: "video" | "audio" } | { shows: "pages" } | { shows: "rows"; separator: "," | "\t" } | { shows: "lines" } | { shows: "icon" };

export function previewOf(upload: Pick<Upload, "name" | "type">): Preview {
  switch (fileClass(upload)) {
    case "image":
      return { shows: "picture" };
    case "video":
      return { shows: "player", media: "video" };
    case "audio":
      return { shows: "player", media: "audio" };
    case "pdf":
      return { shows: "pages" };
    case "text": {
      const format = formatOf(upload.name);
      return format.format === "table" ? { shows: "rows", separator: format.separator } : { shows: "lines" };
    }
    case "other":
      return { shows: "icon" };
  }
}

/** Where a preview is drawn: in a note below the line that writes the file, in the Uploads page's panel, or over the app. */
export type Place = "note" | "panel" | "overlay";

/** How much of a file a preview shows in each place, and how tall its pages are drawn there in CSS pixels. */
export const SHOWS: Record<Place, { pages: number; pageHeight: number; lines: number; rows: number; bytes: number }> = {
  note: { pages: 3, pageHeight: 260, lines: 8, rows: 6, bytes: 64 * 1024 },
  panel: { pages: 1, pageHeight: 300, lines: 14, rows: 10, bytes: 64 * 1024 },
  overlay: { pages: 30, pageHeight: 900, lines: 400, rows: 200, bytes: 512 * 1024 },
};

/** How many of a PDF's `count` pages are drawn in `place`. */
export const pagesShown = (count: number, place: Place): number => Math.max(0, Math.min(count, SHOWS[place].pages));

/** What a preview says of a PDF beside its pages: how many it has, and how many of them it shows when that is fewer. */
export function pagesSaid(count: number, shown: number): string {
  const all = `${count.toLocaleString()} ${count === 1 ? "page" : "pages"}`;
  return shown < count ? `${all}, the first ${shown === 1 ? "one" : shown} shown` : all;
}

/** The most pixels one page is drawn with, whatever its size and the screen's: a poster-sized page costs what a letter does. */
export const MOST_PIXELS = 4_000_000;

/**
 * The scale a page `width` by `height` points is drawn at to be `cssHeight` pixels tall on a screen
 * of `ratio` device pixels to a CSS pixel, at most {@link MOST_PIXELS} in all, and the size of its
 * canvas and of the canvas on the page.
 */
export function pageFit(page: { width: number; height: number }, cssHeight: number, ratio: number): { scale: number; pixels: { width: number; height: number }; css: { width: number; height: number } } {
  const css = { width: (page.width * cssHeight) / page.height, height: cssHeight };
  let scale = (cssHeight * ratio) / page.height;
  const area = page.width * page.height * scale * scale;
  if (area > MOST_PIXELS) scale *= Math.sqrt(MOST_PIXELS / area);
  return { scale, pixels: { width: Math.max(1, Math.floor(page.width * scale)), height: Math.max(1, Math.floor(page.height * scale)) }, css };
}

/** The first `most` lines of `text`, and whether there is more of it than they are. */
export function firstLines(text: string, most: number): { lines: string[]; more: boolean } {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return { lines: lines.slice(0, most), more: lines.length > most };
}
