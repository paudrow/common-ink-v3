/**
 * What an upload's bytes are served as. It is decided here and nowhere else, from the ending of the
 * file's name and the first bytes of the file together, and never from what the browser that sent it
 * said. A file is one of the types below only when both agree. Anything else is kept and handed
 * back as a download of bytes that no browser will read as a page, a script or a picture.
 */
export type UploadKind = "image" | "video" | "audio" | "file";

interface Known {
  type: string;
  kind: Exclude<UploadKind, "file">;
  endings: readonly string[];
  /** Whether a file that starts with `head` is one of these. */
  is: (head: Uint8Array) => boolean;
  /**
   * Whether the bytes may be shown where they are asked for rather than downloaded. An SVG may not:
   * opened as a page it is a document that runs script. It still draws as the source of an image.
   */
  inline: boolean;
}

const ascii = (head: Uint8Array, at: number, text: string) => text.length <= head.length - at && [...text].every((ch, i) => head[at + i] === ch.charCodeAt(0));
const starts = (head: Uint8Array, ...bytes: number[]) => bytes.every((b, i) => head[i] === b);
/** An ISO media file names its brand after `ftyp`. */
const brand = (head: Uint8Array, ...brands: string[]) => ascii(head, 4, "ftyp") && brands.some((b) => ascii(head, 8, b));
const text = (head: Uint8Array) => new TextDecoder().decode(head);

const KNOWN: readonly Known[] = [
  { type: "image/png", kind: "image", endings: ["png"], inline: true, is: (h) => starts(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { type: "image/jpeg", kind: "image", endings: ["jpg", "jpeg"], inline: true, is: (h) => starts(h, 0xff, 0xd8, 0xff) },
  { type: "image/gif", kind: "image", endings: ["gif"], inline: true, is: (h) => ascii(h, 0, "GIF87a") || ascii(h, 0, "GIF89a") },
  { type: "image/webp", kind: "image", endings: ["webp"], inline: true, is: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WEBP") },
  { type: "image/avif", kind: "image", endings: ["avif"], inline: true, is: (h) => brand(h, "avif", "avis") },
  { type: "image/svg+xml", kind: "image", endings: ["svg"], inline: false, is: (h) => /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[^]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text(h)) },
  { type: "video/mp4", kind: "video", endings: ["mp4", "m4v"], inline: true, is: (h) => brand(h, "isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4") },
  { type: "video/quicktime", kind: "video", endings: ["mov"], inline: true, is: (h) => brand(h, "qt  ") },
  { type: "video/webm", kind: "video", endings: ["webm"], inline: true, is: (h) => starts(h, 0x1a, 0x45, 0xdf, 0xa3) },
  { type: "audio/mpeg", kind: "audio", endings: ["mp3"], inline: true, is: (h) => ascii(h, 0, "ID3") || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0) },
  { type: "audio/mp4", kind: "audio", endings: ["m4a"], inline: true, is: (h) => brand(h, "M4A ", "isom", "mp42") },
  { type: "audio/wav", kind: "audio", endings: ["wav"], inline: true, is: (h) => ascii(h, 0, "RIFF") && ascii(h, 8, "WAVE") },
  { type: "audio/ogg", kind: "audio", endings: ["ogg", "oga"], inline: true, is: (h) => ascii(h, 0, "OggS") },
];

/** What every other file is served as. */
export const BYTES = "application/octet-stream";

const BY_TYPE = new Map(KNOWN.map((known) => [known.type, known]));

const endingOf = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** The type a file named `name` that starts with `head` is served as. */
export function typeOf(name: string, head: Uint8Array): string {
  const ending = endingOf(name);
  return KNOWN.find((known) => known.endings.includes(ending) && known.is(head))?.type ?? BYTES;
}

export const kindOf = (type: string): UploadKind => BY_TYPE.get(type)?.kind ?? "file";

/** Whether bytes of this type are shown in place. Everything else is only ever downloaded. */
export const showsInline = (type: string): boolean => BY_TYPE.get(type)?.inline ?? false;

/** As much of a file's start as its type and an image's size are read from. */
export const HEAD_BYTES = 65_536;

const u16 = (h: Uint8Array, at: number) => (h[at]! << 8) | h[at + 1]!;
const u24le = (h: Uint8Array, at: number) => h[at]! | (h[at + 1]! << 8) | (h[at + 2]! << 16);
const u32 = (h: Uint8Array, at: number) => h[at]! * 0x1000000 + ((h[at + 1]! << 16) | (h[at + 2]! << 8) | h[at + 3]!);

function jpegSize(h: Uint8Array): [number, number] | null {
  let at = 2;
  while (at + 9 < h.length && h[at] === 0xff) {
    const marker = h[at + 1]!;
    // A start-of-frame says the picture's size. 0xC4, 0xC8 and 0xCC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [u16(h, at + 7), u16(h, at + 5)];
    at += 2 + u16(h, at + 2);
  }
  return null;
}

function webpSize(h: Uint8Array): [number, number] | null {
  if (h.length < 30) return null;
  if (ascii(h, 12, "VP8X")) return [u24le(h, 24) + 1, u24le(h, 27) + 1];
  if (ascii(h, 12, "VP8 ")) return [(h[26]! | (h[27]! << 8)) & 0x3fff, (h[28]! | (h[29]! << 8)) & 0x3fff];
  if (ascii(h, 12, "VP8L")) {
    const bits = h[21]! | (h[22]! << 8) | (h[23]! << 16) | (h[24]! * 0x1000000);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

/** How wide and tall an image of `type` is, when its start says. Null for anything else. */
export function imageSize(type: string, head: Uint8Array): { width: number; height: number } | null {
  let size: [number, number] | null = null;
  if (type === "image/png" && head.length >= 24) size = [u32(head, 16), u32(head, 20)];
  else if (type === "image/gif" && head.length >= 10) size = [head[6]! | (head[7]! << 8), head[8]! | (head[9]! << 8)];
  else if (type === "image/jpeg") size = jpegSize(head);
  else if (type === "image/webp") size = webpSize(head);
  if (!size || !(size[0] > 0 && size[1] > 0 && size[0] <= 65_535 && size[1] <= 65_535)) return null;
  return { width: size[0], height: size[1] };
}

const MAX_NAME_LENGTH = 200;
/** Half of a character that takes two: what a cut through one leaves, and what no name is made of. */
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * A file's name as it is kept: the last part of what was given, with nothing a path or a header
 * could be made of, and never empty. It is only ever shown and offered as the name to save under.
 */
export function cleanName(given: string): string {
  const last = given.split(/[/\\]/).at(-1) ?? "";
  const clean = last.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069"<>:|?*]/g, "").replace(LONE, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (!clean) return "file";
  if (clean.length <= MAX_NAME_LENGTH) return clean;
  const ending = /\.[A-Za-z0-9]{1,8}$/.exec(clean)?.[0] ?? "";
  return clean.slice(0, MAX_NAME_LENGTH - ending.length).replace(LONE, "") + ending;
}

/** How the name is written in the header that says what to save a download as. */
export const disposition = (type: string, name: string) =>
  `${showsInline(type) ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
