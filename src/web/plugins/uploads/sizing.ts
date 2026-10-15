import { sizeIn, sizeWordIn, SIZE_WORDS, type BelowBox, type SizeWord, type UploadEmbed, type UploadKind } from "../../plugin-api.ts";

/** The room kept for a picture or a video whose embed gives no size. */
export const UNSIZED: BelowBox = { ratio: 16 / 9, maxWidth: 480 };

/** As tall as a browser's own audio controls, with a little room around them. */
export const AUDIO_HEIGHT = 56;

/** The size a video's embed is written with when the browser couldn't read the video's own. */
export const DEFAULT_VIDEO = { width: 640, height: 360 };

/** How much of the note's column each size word draws a picture or a video across. */
export const SHARE: Record<SizeWord, number> = { small: 1 / 3, medium: 1 / 2, large: 3 / 4, full: 1 };

/**
 * The room an embed of an upload keeps below its line, from what the note writes alone: its share
 * of the note's column, at the shape of the size after the id, and never wider than that size. Null
 * for a file, which is a chip in its line.
 */
export function boxFor(embed: UploadEmbed, config: string): BelowBox | null {
  if (embed === "file") return null;
  if (embed === "audio") return { height: AUDIO_HEIGHT };
  const size = sizeIn(config);
  const box = size ? { ratio: size.width / size.height, maxWidth: size.width } : UNSIZED;
  const share = SHARE[sizeWordIn(config)];
  return share === 1 ? box : { ...box, share };
}

export interface Width {
  word: SizeWord;
  width: number;
}

/**
 * The widths a picture `most` pixels wide can be drawn at in a column `column` wide, narrowest first,
 * each by the word that draws it. Where two words draw it as wide, it is the wider word's.
 */
export function widthsIn(column: number, most: number): Width[] {
  const widths: Width[] = [];
  for (const word of SIZE_WORDS) {
    const width = Math.min(most, column * SHARE[word]);
    if (widths.length && width - widths.at(-1)!.width < 0.5) widths.pop();
    widths.push({ word, width });
  }
  return widths;
}

/** The word whose width is nearest to `width`. */
export const nearest = (widths: readonly Width[], width: number): SizeWord => widths.reduce((best, w) => (Math.abs(w.width - width) < Math.abs(best.width - width) ? w : best)).word;

/** The word one width wider or narrower than the one `word` draws, or the same at either end. */
export function stepped(widths: readonly Width[], word: SizeWord, by: 1 | -1): SizeWord {
  const at = widths.findIndex((w) => SIZE_WORDS.indexOf(w.word) >= SIZE_WORDS.indexOf(word));
  return widths[Math.max(0, Math.min(widths.length - 1, at + by))]!.word;
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
