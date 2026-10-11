/** A fenced code block as a note writes it. */
export interface Fenced {
  /** What follows the opening fence, up to the first space: the language, by its name or a file ending. */
  language: string;
  /** The lines between the fences, without the indent the opening fence has. */
  code: string;
  /** Where the code starts and ends in the block's text. */
  from: number;
  to: number;
  /** Whether the block has its closing fence. One without runs to the end of the note. */
  closed: boolean;
}

const OPENING = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/** Reads a fenced code block from its text, which starts at its opening fence. Null for text that doesn't. */
export function fencedIn(text: string): Fenced | null {
  const lines = text.split("\n");
  const opening = OPENING.exec(lines[0]!);
  if (!opening) return null;
  const [, indent, fence, language] = opening as unknown as [string, string, string, string];
  const last = lines.length > 1 ? lines[lines.length - 1]!.trim() : "";
  const closed = last.length >= fence.length && last === fence[0]!.repeat(last.length);
  const body = lines.slice(1, closed ? -1 : undefined);
  const from = Math.min(lines[0]!.length + 1, text.length);
  const to = closed ? text.length - lines[lines.length - 1]!.length - 1 : text.length;
  const outdent = new RegExp(`^ {0,${indent.length}}`);
  return { language, code: body.map((line) => line.replace(outdent, "")).join("\n"), from, to: Math.max(from, to), closed };
}
