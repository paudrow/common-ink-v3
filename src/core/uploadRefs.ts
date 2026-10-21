import { linesOutsideCode } from "./lines.ts";
import { blanked, codeSpans } from "./spans.ts";

/**
 * A note refers to an upload by an embed whose config starts with the upload's id: `::image{id 640x480}`,
 * `::image{id 640x480 42% crop=120,40,800,600}`, `::video{id 640x360 medium}`, `::audio{id}`, or `::file{id}`. The embed's
 * name is what says the id is an upload's, since a note's id is written the same way. Anything after
 * the id is how it is shown, and the upload's name is never in the note.
 */
export const UPLOAD_EMBEDS = ["image", "video", "audio", "file"] as const;
export type UploadEmbed = (typeof UPLOAD_EMBEDS)[number];

/**
 * The words a note writes for how wide a picture or a video is drawn, each with its share of the
 * note's column. `full` is written as nothing.
 */
export const SIZE_WORDS = ["small", "medium", "large", "full"] as const;
export type SizeWord = (typeof SIZE_WORDS)[number];
export const SIZE_SHARE: Record<SizeWord, number> = { small: 1 / 3, medium: 1 / 2, large: 3 / 4, full: 1 };

const REF = new RegExp(`(?<!:)::(${UPLOAD_EMBEDS.join("|")})\\{([a-z0-9]{12})(?:[ \\t][^{}\\n]*)?\\}`, "g");

/** The upload an embed's config names, or null when it names none. */
export const uploadIn = (config: string): string | null => /^([a-z0-9]{12})(?:[ \t]|$)/.exec(config)?.[1] ?? null;

/** How an embed of an upload is written. `size` is the room kept for a picture or a video, which the app measures. */
export const writtenUpload = (embed: UploadEmbed, id: string, size?: { width: number; height: number } | null) =>
  `::${embed}{${id}${size ? ` ${Math.round(size.width)}x${Math.round(size.height)}` : ""}}`;

const SIZED = /^[a-z0-9]{12}[ \t]+(\d{1,5})x(\d{1,5})(?=[ \t]|$)/;

/** The size an embed's config gives after the id, as `640x480`. */
export function sizeIn(config: string): { width: number; height: number } | null {
  const size = SIZED.exec(config);
  if (!size) return null;
  const [width, height] = [Number(size[1]), Number(size[2])];
  return width > 0 && height > 0 ? { width, height } : null;
}

const PERCENT = /^(\d{1,3})%$/;

/** A word that says how wide a picture or a video is drawn, as its share of the column, or null for any other word. */
function shareOf(word: string): number | null {
  const percent = PERCENT.exec(word);
  if (percent) return Number(percent[1]) >= 1 && Number(percent[1]) <= 100 ? Number(percent[1]) / 100 : null;
  return SIZE_WORDS.includes(word as SizeWord) ? SIZE_SHARE[word as SizeWord] : null;
}

/**
 * How much of the note's column an embed's config says it is drawn across, more than 0 and up to 1:
 * the first word after the id that is a size word or a whole percent from `1%` to `100%`. With
 * none it is the whole column.
 */
export function shareIn(config: string): number {
  if (!uploadIn(config)) return 1;
  for (const word of config.split(/[ \t]+/).slice(1)) {
    const share = shareOf(word);
    if (share !== null) return share;
  }
  return 1;
}

/**
 * An embed's config drawn `share` of the column wide, written right after its size: a size word when
 * the share is one at a whole percent, nothing for the whole column, and otherwise the whole percent
 * nearest it. Its id, its size and every other word stay as they were. A config naming no upload is
 * left as it is.
 */
export function withShare(config: string, share: number): string {
  if (!uploadIn(config)) return config;
  const [id, ...words] = config.split(/[ \t]+/);
  const size = words[0] && /^\d{1,5}x\d{1,5}$/.test(words[0]) ? words.shift()! : null;
  const percent = Math.max(1, Math.min(100, Math.round(share * 100)));
  const word = SIZE_WORDS.find((w) => Math.round(SIZE_SHARE[w] * 100) === percent);
  const width = word === "full" ? null : (word ?? `${percent}%`);
  return [id, size, width, ...words.filter((w) => shareOf(w) === null)].filter(Boolean).join(" ");
}

/** A part of a picture, in its own pixels from its top left corner. */
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CROP = /^crop=(\d{1,5}),(\d{1,5}),(\d{1,5}),(\d{1,5})$/;

/**
 * The part of its picture an embed's config draws: the first word after the id written
 * `crop=X,Y,WIDTH,HEIGHT`, in the pixels of the size after the id, and only as much of it as is in
 * the picture. Null where there is no such word, no size, nothing of the picture in it, or all of it.
 */
export function cropIn(config: string): Crop | null {
  const size = sizeIn(config);
  const word = config.split(/[ \t]+/).slice(1).find((w) => CROP.test(w));
  if (!size || !word) return null;
  const [x, y, width, height] = CROP.exec(word)!.slice(1).map(Number) as [number, number, number, number];
  const [left, top] = [Math.min(x, size.width), Math.min(y, size.height)];
  const crop = { x: left, y: top, width: Math.min(x + width, size.width) - left, height: Math.min(y + height, size.height) - top };
  if (crop.width <= 0 || crop.height <= 0) return null;
  return crop.width === size.width && crop.height === size.height ? null : crop;
}

/**
 * An embed's config drawing `crop` of its picture, in whole pixels within the size after the id,
 * written after its size, and after its width where that follows the size. Null, or all of the
 * picture, writes none. Its id, its size, its width and every other word stay as they were. A
 * config naming no upload, or with no size, is left as it is.
 */
export function withCrop(config: string, crop: Crop | null): string {
  const size = sizeIn(config);
  if (!size) return config;
  const [id, ...words] = config.split(/[ \t]+/).filter((w) => !CROP.test(w));
  const lead = words[1] !== undefined && shareOf(words[1]) !== null ? 2 : 1;
  const clamp = (n: number, most: number) => Math.max(0, Math.min(most, Math.round(n)));
  const [x, y] = [clamp(crop?.x ?? 0, size.width - 1), clamp(crop?.y ?? 0, size.height - 1)];
  const [right, bottom] = [clamp((crop?.x ?? 0) + (crop?.width ?? size.width), size.width), clamp((crop?.y ?? 0) + (crop?.height ?? size.height), size.height)];
  const whole = !crop || (x === 0 && y === 0 && right === size.width && bottom === size.height);
  const word = whole ? [] : [`crop=${x},${y},${Math.max(1, right - x)},${Math.max(1, bottom - y)}`];
  return [id, ...words.slice(0, lead), ...word, ...words.slice(lead)].join(" ");
}

/** The ids of the uploads a note's text refers to outside code, each once, in the order they first appear. */
export function uploadIds(text: string): string[] {
  if (!text.includes("::")) return [];
  const ids = new Set<string>();
  for (const { line } of linesOutsideCode(text)) {
    if (!line.includes("::")) continue;
    for (const match of blanked(line, codeSpans(line), " ").matchAll(REF)) ids.add(match[2]!);
  }
  return [...ids];
}
