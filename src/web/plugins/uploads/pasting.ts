import { MAX_UPLOAD_BYTES } from "../../plugin-api.ts";
import { formatBytes } from "./sizing.ts";

/** As much of a paste or a drop as says what it carries: a `DataTransfer` is one. */
export interface Carried<F> {
  types: readonly string[];
  files: ArrayLike<F>;
}

/**
 * The files a paste is for uploading. A paste that carries no file is text, and so is one that
 * carries text both plain and formatted beside a picture: that is what a spreadsheet or a document
 * puts on the clipboard for the cells or words that were copied, with a picture of them. A
 * screenshot, a picture copied from a page, and a file copied from a folder are files.
 */
export function pastedFiles<F>({ types, files }: Carried<F>): F[] {
  if (!files.length) return [];
  return types.includes("text/plain") && types.includes("text/html") ? [] : Array.from(files);
}

/** The files a drop carries. Text dragged from elsewhere carries none. */
export const droppedFiles = <F>({ files }: Carried<F>): F[] => Array.from(files);

/** Why a file can't be sent, said before any of it is, or null when it can. */
export function refusal(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name} is empty, so there is nothing to upload.`;
  return file.size > MAX_UPLOAD_BYTES ? `${file.name} is ${formatBytes(file.size)}. A file can be at most ${formatBytes(MAX_UPLOAD_BYTES)}.` : null;
}

/** A line of a note: where it starts, what it says, and whether it is the note's last. */
export interface OnLine {
  from: number;
  text: string;
  last: boolean;
}

/**
 * The edit that puts `written` on a line of its own at the line it was pasted or dropped on: in
 * place of a blank line, and otherwise on a new line under it. `after` is where the line below
 * starts, which the edit makes when there is none.
 */
export function onItsOwnLine(written: string, line: OnLine): { from: number; to: number; insert: string; end: number; after: number } {
  const blank = !line.text.trim();
  const to = line.from + line.text.length;
  const from = blank ? line.from : to;
  const lead = blank ? "" : "\n";
  const end = from + lead.length + written.length;
  return { from, to, insert: `${lead}${written}${line.last ? "\n" : ""}`, end, after: end + 1 };
}
