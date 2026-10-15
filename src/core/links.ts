import { linesOutsideCode } from "./lines.ts";

/**
 * A link as a note writes it: `[[target]]` or `[[target|display text]]`. A note stores the target
 * as the linked note's id, which never changes, so a link follows its note through every rename.
 * A target that isn't an id is a title somebody wrote by hand, and links nothing until it is resolved.
 */
export interface WrittenLink {
  from: number;
  to: number;
  target: string;
  /** The words shown in place of the linked note's title, or null to show the title. */
  display: string | null;
}

const LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;
const INLINE_CODE = /(`+)(?!`)[^]*?(?<!`)\1(?!`)/g;
const ID = /^[a-z0-9]{12}$/;

export const isNoteId = (target: string) => ID.test(target);

/** How a link is written. */
export const writtenLink = (target: string, display?: string | null) => (display ? `[[${target}|${display}]]` : `[[${target}]]`);

/** The links on one line of a note, which starts at `offset`. Those inside inline code are left out. */
export function linksOn(line: string, offset = 0): WrittenLink[] {
  if (!line.includes("[[")) return [];
  const read = line.replace(INLINE_CODE, (code) => " ".repeat(code.length));
  return [...read.matchAll(LINK)].flatMap((match) => {
    const target = match[1]!.trim();
    const from = offset + match.index;
    return target ? [{ from, to: from + match[0].length, target, display: match[2]?.trim() || null }] : [];
  });
}

/** Every link in a note's text, outside code. */
export function linksIn(text: string): WrittenLink[] {
  if (!text.includes("[[")) return [];
  return [...linesOutsideCode(text)].flatMap(({ line, from }) => linksOn(line, from));
}

/** The ids of the notes a note's text links to, each once, in the order they first appear. */
export const linkedIds = (text: string) => [...new Set(linksIn(text).map((link) => link.target).filter(isNoteId))];

/** The text with each link's target written as `to` answers for it, and left as it is where `to` answers nothing. */
export function retargeted(text: string, to: (target: string) => string | undefined): string {
  let out = "";
  let at = 0;
  for (const link of linksIn(text)) {
    const target = to(link.target);
    if (target === undefined) continue;
    out += text.slice(at, link.from) + writtenLink(target, link.display);
    at = link.to;
  }
  return out + text.slice(at);
}
