import { sizeIn, type BelowBox, type UploadEmbed, type UploadKind } from "../../plugin-api.ts";

/** The tallest a picture or a video is drawn in a note, in pixels. A taller one is drawn smaller, at its own shape. */
export const TALLEST = 480;

/** The widest one is drawn, in pixels. */
const WIDEST = 640;

/** The room kept for a picture or a video whose embed gives no size. */
export const UNSIZED: BelowBox = { ratio: 16 / 9, maxWidth: 480 };

/** As tall as a browser's own audio controls, with a little room around them. */
export const AUDIO_HEIGHT = 56;

/** The size a video's embed is written with when the browser couldn't read the video's own. */
export const DEFAULT_VIDEO = { width: 640, height: 360 };

/**
 * The room an embed of an upload keeps below its line, from what the note writes alone: the size
 * after the id, never drawn larger than it is or taller than {@link TALLEST}, and narrowed to the
 * note's column at the same shape. Null for a file, which is a chip in its line.
 */
export function boxFor(embed: UploadEmbed, config: string): BelowBox | null {
  if (embed === "file") return null;
  if (embed === "audio") return { height: AUDIO_HEIGHT };
  const size = sizeIn(config);
  if (!size) return UNSIZED;
  const scale = Math.min(1, TALLEST / size.height);
  return { ratio: size.width / size.height, maxWidth: Math.min(WIDEST, Math.max(1, Math.round(size.width * scale))) };
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
