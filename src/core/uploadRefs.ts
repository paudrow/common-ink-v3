import { linesOutsideCode } from "./lines.ts";
import { blanked, codeSpans } from "./spans.ts";

/**
 * A note refers to an upload by an embed whose config starts with the upload's id: `::image{id 640x480}`,
 * `::video{id 640x360 medium}`, `::audio{id}`, or `::file{id}`. The embed's name is what says the id is an
 * upload's, since a note's id is written the same way. Anything after the id is how it is shown,
 * and the upload's name is never in the note.
 */
export const UPLOAD_EMBEDS = ["image", "video", "audio", "file"] as const;
export type UploadEmbed = (typeof UPLOAD_EMBEDS)[number];

/**
 * How wide a picture or a video is drawn. A note writes `small`, `medium` or `large` after its size,
 * and nothing for `full`, which is what anything else written there is read as.
 */
export const SIZE_WORDS = ["small", "medium", "large", "full"] as const;
export type SizeWord = (typeof SIZE_WORDS)[number];

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

/** How wide an embed's config says it is drawn: the word after the size, or after the id where there is no size. */
export function sizeWordIn(config: string): SizeWord {
  const word = /^[a-z0-9]{12}(?:[ \t]+\d{1,5}x\d{1,5})?[ \t]+([a-z]+)(?:[ \t]|$)/.exec(config)?.[1];
  return SIZE_WORDS.find((w) => w === word) ?? "full";
}

/** An embed's config drawn `word` wide, keeping its id and its size; anything else it said goes. A config naming no upload is left as it is. */
export function withSizeWord(config: string, word: SizeWord): string {
  const id = uploadIn(config);
  if (!id) return config;
  const size = SIZED.exec(config);
  return `${id}${size ? ` ${size[1]}x${size[2]}` : ""}${word === "full" ? "" : ` ${word}`}`;
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
