import { readNote } from "./embedSyntax.ts";

/**
 * Each line of a note that is words of the note, with where it starts and which line it is, counted
 * from 0: not one in a fenced code block or a fence, and not an embed's content unless that is
 * markdown, as a board's is. A form's content is JSON, so it is not the note's prose. Indented lines
 * are not taken for code: a bullet nested three deep is indented as far as a code block is.
 */
export function* linesOutsideCode(text: string): Generator<{ line: string; from: number; index: number }> {
  for (const { line, from, index, is } of readNote(text).lines) if (is === "prose" || is === "markdown") yield { line, from, index };
}
