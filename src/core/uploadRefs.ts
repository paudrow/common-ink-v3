import { linesOutsideCode } from "./lines.ts";
import { blanked, codeSpans } from "./spans.ts";

/**
 * A note refers to an upload by an embed whose config starts with the upload's id: `::image{id 640x480}`,
 * `::image{id 640x480 42%}`, `::video{id 640x360 medium}`, `::audio{id}`, or `::file{id}`. The embed's
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
