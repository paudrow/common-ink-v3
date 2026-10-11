import { linesOutsideCode } from "./lines.ts";

/**
 * A note refers to an upload by an embed whose config starts with the upload's id: `::image{id 640x480}`,
 * `::video{id 640x360}`, `::audio{id}`, or `::file{id}`. The embed's name is what says the id is an
 * upload's, since a note's id is written the same way. Anything after the id is how it is shown,
 * and the upload's name is never in the note.
 */
export const UPLOAD_EMBEDS = ["image", "video", "audio", "file"] as const;
export type UploadEmbed = (typeof UPLOAD_EMBEDS)[number];

const REF = new RegExp(`(?<!:)::(${UPLOAD_EMBEDS.join("|")})\\{([a-z0-9]{12})(?:[ \\t][^{}\\n]*)?\\}`, "g");
const INLINE_CODE = /(`+)(?!`)[^]*?(?<!`)\1(?!`)/g;

/** The upload an embed's config names, or null when it names none. */
export const uploadIn = (config: string): string | null => /^([a-z0-9]{12})(?:[ \t]|$)/.exec(config)?.[1] ?? null;

/** How an embed of an upload is written. `size` is the room kept for a picture or a video. */
export const writtenUpload = (embed: UploadEmbed, id: string, size?: { width: number; height: number } | null) =>
  `::${embed}{${id}${size ? ` ${Math.round(size.width)}x${Math.round(size.height)}` : ""}}`;

/** The size an embed's config gives after the id, as `640x480`. */
export function sizeIn(config: string): { width: number; height: number } | null {
  const size = /^[a-z0-9]{12}[ \t]+(\d{1,5})x(\d{1,5})(?:[ \t]|$)/.exec(config);
  if (!size) return null;
  const [width, height] = [Number(size[1]), Number(size[2])];
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The ids of the uploads a note's text refers to outside code, each once, in the order they first appear. */
export function uploadIds(text: string): string[] {
  if (!text.includes("::")) return [];
  const ids = new Set<string>();
  for (const { line } of linesOutsideCode(text)) {
    if (!line.includes("::")) continue;
    for (const match of line.replace(INLINE_CODE, (code) => " ".repeat(code.length)).matchAll(REF)) ids.add(match[2]!);
  }
  return [...ids];
}
