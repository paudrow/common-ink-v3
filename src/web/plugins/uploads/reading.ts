import { MAX_NOTE_LENGTH } from "../../plugin-api.ts";

/** How much of a file is read to be shown in the app. A longer one shows its start and says so. */
export const SHOWN_BYTES = 2 * 1024 * 1024;

/** How many rows of a CSV or TSV are drawn as a table. */
export const SHOWN_ROWS = 1000;

/** How many columns of one are drawn, and how many cells in all, so a file of very wide rows draws as quickly as one of many. */
export const SHOWN_COLUMNS = 50;
export const SHOWN_CELLS = 20_000;

/** A file's start as read: its words, and whether there is more of the file than they are, or bytes that are no text. */
export type ReadText = { kind: "text"; text: string; cut: boolean } | { kind: "binary" };

/**
 * The words in the first bytes of a file of `size` bytes, read as UTF-8 and nothing else. A byte that
 * isn't UTF-8, or a NUL, makes it no text. Where the bytes stop short of the file, a character cut
 * in two at their end is left out.
 */
export function textOf(bytes: Uint8Array, size: number): ReadText {
  const cut = bytes.length < size;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut });
  } catch {
    return { kind: "binary" };
  }
  return text.includes("\u0000") ? { kind: "binary" } : { kind: "text", text, cut };
}

const endingOf = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** How a text file is drawn: markdown as a note is, a CSV or TSV as a table, and anything else as code, coloured where its language is known. */
export type Format = { format: "markdown" } | { format: "table"; separator: "," | "\t" } | { format: "code" };

export function formatOf(name: string): Format {
  const ending = endingOf(name);
  if (ending === "md" || ending === "markdown") return { format: "markdown" };
  if (ending === "csv" || ending === "tsv") return { format: "table", separator: ending === "csv" ? "," : "\t" };
  return { format: "code" };
}

/**
 * The text a new note copied from a file holds: markdown and plain text as they are, and anything
 * else as a block of code in its language under the file's name, so it reads as it was. Null when
 * that is more than a note can hold.
 */
export function asNote(name: string, text: string): string | null {
  const ending = endingOf(name);
  let written = text;
  if (ending !== "md" && ending !== "markdown" && ending !== "txt") {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
    const fence = "`".repeat(longest + 1);
    written = `# ${name}\n\n${fence}${ending === "log" ? "" : ending}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`;
  }
  return written.length <= MAX_NOTE_LENGTH ? written : null;
}
