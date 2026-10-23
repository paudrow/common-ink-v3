import { linesOutsideCode } from "./lines.ts";
import { linkedPerson, linksOn, writtenLink } from "./links.ts";
import { addressSpans, blanked, codeSpans } from "./spans.ts";

/**
 * A mention is a link to a person: `[[person:target]]`, or `[[person:target|words]]` to show words
 * of its own in place of the person's name.
 *
 *     [[person:k3j5h8d9f0a1]]   a member of the workspace, by their id
 *     [[person:Sam Okafor]]     anyone else, by name alone
 *
 * A target that is an id names a person, and a mention is of a member for as long as that person is
 * one: it is then shown as their name is now. Any other mention is a name and nothing more, which is
 * all a note holds of a contact. One in code, or in a link's address, is text.
 * docs/adr/0019-everything-a-note-opens-is-a-link.md has why.
 */
export interface WrittenMention {
  from: number;
  to: number;
  target: string;
  /** The words written after the `|`, shown in place of the person's name, or null. */
  label: string | null;
}

const ID = /^[a-z0-9]{12}$/;
const UNWRITABLE = /[[\]|\s]+/g;
/** Characters that don't show and can change how what follows is laid out: zero-width ones, and the ones that turn text right to left. */
const UNSEEN = /\p{Cf}+/gu;

/** Whether a mention's target reads as a person's id. Whether that person is a member is the workspace's to say. */
export const isPersonId = (target: string) => ID.test(target);

/** A name as it is read: without the characters that don't show, so no name is nothing to look at, and none turns the line around. */
export const readableName = (name: string) => name.replace(UNSEEN, "").trim();

/** A name as a mention can hold it: without brackets, `|`, line breaks, or characters that don't show. */
const writable = (name: string) => readableName(name.replace(UNWRITABLE, " "));

/**
 * How a mention is written: of a member by their id, or of anyone else by name, with `label` to show
 * in place of the name where it is given. Empty for a name with nothing to write.
 */
export function writtenMention(person: { id?: string | null; name: string }, label?: string | null): string {
  const target = person.id || writable(person.name);
  return target ? writtenLink(`person:${target}`, label && writable(label)) : "";
}

const PERSON = "[[person:";

/** The mentions on one line of a note, which starts at `offset`. Those inside inline code and in a link's address are left out. */
export function mentionsOn(line: string, offset = 0): WrittenMention[] {
  if (!line.includes(PERSON)) return [];
  const code = blanked(line, codeSpans(line), " ");
  return linksOn(blanked(code, addressSpans(code), " "), offset).flatMap(({ from, to, target, display }) => {
    const who = readableName(linkedPerson(target) ?? "");
    return who ? [{ from, to, target: who, label: readableName(display ?? "") || null }] : [];
  });
}

/** Every mention in a note's text, outside code. */
export function mentionsIn(text: string): WrittenMention[] {
  if (!text.includes(PERSON)) return [];
  return [...linesOutsideCode(text)].flatMap(({ line, from }) => mentionsOn(line, from));
}

/** What a mention is matched by: the person's id, or for a name alone the name in lower case. */
export const mentionKey = (mention: Pick<WrittenMention, "target">) => (isPersonId(mention.target) ? mention.target : mention.target.toLowerCase());

/** What a filter or a change names someone by, as `mentionKey` would: a person's id, or a name ignoring case. */
export const personKey = (who: string) => mentionKey({ target: readableName(who) });

/** The name a mention is of someone by, or null for a person's id, whose name only the list of members tells. */
export const mentionName = (mention: Pick<WrittenMention, "target">) => (isPersonId(mention.target) ? null : mention.target);

/** The text with each mention written as `to` answers for it, and left as it is where `to` answers nothing. */
export function rementioned(text: string, to: (mention: WrittenMention) => string | undefined): string {
  let out = "";
  let at = 0;
  for (const mention of mentionsIn(text)) {
    const written = to(mention);
    if (written === undefined) continue;
    out += text.slice(at, mention.from) + written;
    at = mention.to;
  }
  return out + text.slice(at);
}

/** What the index holds of a note's mentions: for each line, who is mentioned on it, each once, with the name they are mentioned by, or nothing for an id. */
export type MentionIndex = [line: number, who: string, name: string][];

export function mentionIndex(text: string): MentionIndex {
  if (!text.includes(PERSON)) return [];
  const rows: MentionIndex = [];
  for (const { line, index } of linesOutsideCode(text)) {
    const seen = new Set<string>();
    for (const mention of mentionsOn(line)) {
      const who = mentionKey(mention);
      if (seen.has(who)) continue;
      seen.add(who);
      rows.push([index, who, mentionName(mention) ?? ""]);
    }
  }
  return rows;
}
