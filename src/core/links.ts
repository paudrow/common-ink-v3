import { linesOutsideCode } from "./lines.ts";
import { blanked, codeSpans } from "./spans.ts";

/**
 * A link as a note writes it: `[[target]]` or `[[target|display text]]`, for anything a note opens.
 * A note stores the target as the linked note's id, which never changes, so a link follows its note
 * through every rename. A day is `[[2026-10-23]]` (dateLinks.ts), and everything else is named by
 * its kind: `[[folder:id]]`, `[[event:ref]]`, `[[email:ref]]`, and `[[person:id]]` for a member or `[[person:Name]]`
 * for anyone else (mentions.ts). Without display text a link shows what it is to as it is called
 * now. A target that is none of these is a title somebody wrote by hand, and links nothing until it
 * is resolved. docs/adr/0019-everything-a-note-opens-is-a-link.md has why.
 */
export interface WrittenLink {
  from: number;
  to: number;
  target: string;
  /** The words shown in place of the linked note's title, or null to show the title. */
  display: string | null;
}

const LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;
const ID = /^[a-z0-9]{12}$/;

export const isNoteId = (target: string) => ID.test(target);

/** What may follow each kind's prefix: a folder's, an event reference's or an email reference's id, and a person's id or name. */
const KINDS = { folder: ID, event: ID, email: ID, person: /\S/ } as const;

type Kind = keyof typeof KINDS;

const KIND = /^([a-z]+):(.+)$/;

/** The kind a link's target names and what it names it by, as `[[event:ref]]` writes it, or null for a target that names no kind. */
export function kindOf(target: string): { kind: Kind; to: string } | null {
  const [, kind, to] = KIND.exec(target) ?? [];
  return kind && Object.hasOwn(KINDS, kind) && KINDS[kind as Kind].test(to!) ? { kind: kind as Kind, to: to!.trim() } : null;
}

/** Whether a link's target starts with a kind's prefix, as `[[event:Lunch]]` does: what it is to is that kind's, and it is never a note's title. */
export const namesKind = (target: string) => Object.hasOwn(KINDS, KIND.exec(target)?.[1] ?? "");

const linked = (kind: Kind) => (target: string) => {
  const found = kindOf(target);
  return found?.kind === kind ? found.to : null;
};

/** The folder a link's target is to, as `[[folder:id]]` writes it, or null where it is to no folder. */
export const linkedFolder = linked("folder");

/** The event reference a link's target is to, as `[[event:ref]]` writes it, or null where it is to no event. */
export const linkedEvent = linked("event");

/** The email reference a link's target is to, as `[[email:ref]]` writes it, or null where it is to no thread. */
export const linkedEmail = linked("email");

/** Who a link's target is to, a person's id or a name, as `[[person:…]]` writes it, or null where it is to nobody. */
export const linkedPerson = linked("person");

/** How a link to a folder is written: by the folder's id, so it follows the folder through every rename. */
export const writtenFolderLink = (folderId: string) => `[[folder:${folderId}]]`;

/** How a link to an event is written: by the reference record.refer made, with words of its own to show where it has them. */
export const writtenEventLink = (ref: string, display?: string | null) => writtenLink(`event:${ref}`, display);

/** How a link to an email thread, or one message in it, is written: by its reference alone, so the note says nothing of the mail. */
export const writtenEmailLink = (ref: string, display?: string | null) => writtenLink(`email:${ref}`, display);

/** How a link is written. */
export const writtenLink = (target: string, display?: string | null) => (display ? `[[${target}|${display}]]` : `[[${target}]]`);

/** The links on one line of a note, which starts at `offset`. Those inside inline code are left out. */
export function linksOn(line: string, offset = 0): WrittenLink[] {
  if (!line.includes("[[")) return [];
  const read = blanked(line, codeSpans(line), " ");
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
