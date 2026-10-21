import { cropIn, SIZE_SHARE, shareIn, sizeIn, type BelowBox, type UploadEmbed, type UploadKind } from "../../plugin-api.ts";
import { SHOWS, type Preview } from "./previewing.ts";

/** The room kept for a picture or a video whose embed gives no size. */
export const UNSIZED: BelowBox = { ratio: 16 / 9, maxWidth: 480 };

/** As tall as a browser's own audio controls, with a little room around them. */
export const AUDIO_HEIGHT = 56;

/** The size a video's embed is written with when the browser couldn't read the video's own. */
export const DEFAULT_VIDEO = { width: 640, height: 360 };

/**
 * The room an embed of an upload keeps below its line, from what the note writes alone: its share
 * of the note's column, at the shape of the size after the id, and never wider than that size. A
 * cropped picture's room is the crop's shape and no wider than the crop. Null for a file, which is
 * a chip in its line.
 */
export function boxFor(embed: UploadEmbed, config: string): BelowBox | null {
  if (embed === "file") return null;
  if (embed === "audio") return { height: AUDIO_HEIGHT };
  const shown = (embed === "image" && cropIn(config)) || sizeIn(config);
  const box = shown ? { ratio: shown.width / shown.height, maxWidth: shown.width } : UNSIZED;
  const share = shareIn(config);
  return share === 1 ? box : { ...box, share };
}

/** The narrowest share of the column the size handle draws a picture or a video at, unless it is narrower itself. */
export const LEAST = 0.1;

/** How near, in pixels, a drag comes to a size word's width before it is that width. */
export const SNAP = 12;

/**
 * How far a picture or a video can be sized: the note's column in pixels, and the share of it the
 * picture is at its widest, which is the whole column or its own width where that is narrower.
 */
export interface Reach {
  column: number;
  most: number;
}

export const reachOf = (column: number, own: number): Reach => ({ column, most: Math.min(1, own / column) });

/**
 * The share of the column a drag to `x` pixels from the picture's left edge draws it at, between the
 * least and its widest. Within {@link SNAP} pixels of a size word's width it is that width, unless
 * `free`. At its widest it is the whole column, which draws it as wide.
 */
export function dragged({ column, most }: Reach, x: number, free: boolean): number {
  const widest = most * column;
  let width = Math.min(widest, Math.max(LEAST * column, x));
  if (!free) {
    const words = Object.values(SIZE_SHARE).map((share) => Math.min(widest, share * column));
    const near = words.reduce((best, w) => (Math.abs(w - width) < Math.abs(best - width) ? w : best));
    if (Math.abs(near - width) <= SNAP) width = near;
  }
  return width >= widest - 0.5 ? 1 : width / column;
}

/**
 * The share one step wider or narrower than `share`, by a twentieth of the column, or a hundredth
 * when `fine`, stopping at a third and at the picture's widest, which is the whole column. Each stop
 * is a share as the note writes it back, so a hundredth that is a size word's whole percent is that
 * word's share. At either end it stays.
 */
export function stepped({ most }: Reach, share: number, by: 1 | -1, fine = false): number {
  const step = fine ? 1 : 5;
  const words = Object.values(SIZE_SHARE);
  const percents = new Set([...Array.from({ length: 100 / step + 1 }, (_, i) => i * step), ...words.map((w) => Math.round(w * 100))]);
  const stops = [...percents]
    .sort((a, b) => a - b)
    .map((p) => words.find((w) => Math.round(w * 100) === p) ?? p / 100)
    .filter((s) => s >= LEAST && s < most)
    .concat(most);
  const at = Math.min(share, most);
  const next = (by > 0 ? stops.find((s) => s > at + 1e-9) : stops.findLast((s) => s < at - 1e-9)) ?? at;
  return next >= most ? 1 : next;
}

const UNITS = ["KB", "MB", "GB"] as const;

/** A file's size as a person reads it: `512 bytes`, `1.5 KB`, `50 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < UNITS.length - 1) {
    amount /= 1024;
    unit++;
  }
  const shown = amount < 10 ? Math.round(amount * 10) / 10 : Math.round(amount);
  // 1023.6 KB rounds to 1024 KB, which is 1 MB.
  return shown >= 1024 && unit < UNITS.length - 1 ? `1 ${UNITS[unit + 1]}` : `${shown} ${UNITS[unit]}`;
}

export const KIND_LABEL: Record<UploadKind, string> = { image: "Image", video: "Video", audio: "Audio", file: "File" };

/** The head of a file's card below its line: its name, what it is, and Download. */
export const CARD_HEAD = 40;

/**
 * How tall a file's card is below its line, edge to edge: its head, and under it the preview of what
 * it is, the first pages of a PDF, a picture, a player, the first lines of text or rows of a table, at
 * a height known before any of it is read, so nothing moves when it comes, however short it turns
 * out. A file with nothing to preview, one that can't be shown and one nothing is known of yet
 * (`null`) are the head alone.
 */
export function cardHeight(preview: Preview | null): number {
  const body = !preview ? 0 : preview.shows === "pages" ? SHOWS.note.pageHeight + 24 : preview.shows === "picture" ? 240 : preview.shows === "player" ? (preview.media === "video" ? 240 : AUDIO_HEIGHT) : preview.shows === "rows" ? (SHOWS.note.rows + 1) * 26 + 16 : preview.shows === "lines" ? SHOWS.note.lines * 20 + 20 : 0;
  return CARD_HEAD + body + 2;
}
