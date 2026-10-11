import { linesOutsideCode } from "./lines.ts";

/**
 * A mention as a note writes it: `@[[target]]` or `@[[target|name]]`.
 *
 *     @[[k3j5h8d9f0a1|Ada Lovelace]]   a member of the workspace, by their id, with their name when it was written
 *     @[[Sam Okafor]]                  anyone else, by name alone
 *
 * A target that is an id names a person, and a mention is of a member for as long as that person is
 * one: it is then shown as their name is now. Any other mention is a name and nothing more, which is
 * all a note holds of a contact. A mention stands alone: the `@` doesn't follow a letter, a digit,
 * `_` or another `@`, so an address is never one, and neither is `@name` without the brackets.
 * docs/adr/0007-mentions-are-ids-for-members-and-names-for-everyone-else.md has why.
 */
export interface WrittenMention {
  from: number;
  to: number;
  target: string;
  /** The name written after the `|`, or null. */
  label: string | null;
}

const MENTION = /(?<![\p{L}\p{N}_@])@\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/gu;
const INLINE_CODE = /(`+)(?!`)[^]*?(?<!`)\1(?!`)/g;
const ID = /^[a-z0-9]{12}$/;
const ADDRESS = /\]\([^)\n]*\)/g;
const UNWRITABLE = /[[\]|\s]+/g;
/** Characters that don't show and can change how what follows is laid out: zero-width ones, and the ones that turn text right to left. */
const UNSEEN = /\p{Cf}+/gu;

/** Whether a mention's target reads as a person's id. Whether that person is a member is the workspace's to say. */
export const isPersonId = (target: string) => ID.test(target);

/** A name as it is read: without the characters that don't show, so no name is nothing to look at, and none turns the line around. */
export const readableName = (name: string) => name.replace(UNSEEN, "").trim();

/** A name as a mention can hold it: without brackets, `|`, line breaks, or characters that don't show. */
const writable = (name: string) => readableName(name.replace(UNWRITABLE, " "));

/** How a mention is written: of a member by their id and name, or of anyone else by name. Empty for a name with nothing to write. */
export function writtenMention(person: { id?: string | null; name: string }): string {
  const name = writable(person.name);
  if (person.id) return name ? `@[[${person.id}|${name}]]` : `@[[${person.id}]]`;
  return name ? `@[[${name}]]` : "";
}

/** The mentions on one line of a note, which starts at `offset`. Those inside inline code and in a link's address are left out. */
export function mentionsOn(line: string, offset = 0): WrittenMention[] {
  if (!line.includes("@[[")) return [];
  const out = (text: string) => " ".repeat(text.length);
  const read = line.replace(INLINE_CODE, out).replace(ADDRESS, out);
  return [...read.matchAll(MENTION)].flatMap((match) => {
    const target = readableName(match[1]!);
    const from = offset + match.index;
    return target ? [{ from, to: from + match[0].length, target, label: readableName(match[2] ?? "") || null }] : [];
  });
}

/** Every mention in a note's text, outside code. */
export function mentionsIn(text: string): WrittenMention[] {
  if (!text.includes("@[[")) return [];
  return [...linesOutsideCode(text)].flatMap(({ line, from }) => mentionsOn(line, from));
}

/** What a mention is matched by: the person's id, or for a name alone the name in lower case. */
export const mentionKey = (mention: Pick<WrittenMention, "target">) => (isPersonId(mention.target) ? mention.target : mention.target.toLowerCase());

/** What a filter or a change names someone by, as `mentionKey` would: a person's id, or a name ignoring case. */
export const personKey = (who: string) => mentionKey({ target: readableName(who) });

/** The name a mention shows to someone who can't be told who the person is now: as it was written. */
export const mentionName = (mention: Pick<WrittenMention, "target" | "label">) => mention.label ?? mention.target;

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

/** What the index holds of a note's mentions: for each line, who is mentioned on it, each once, with the name as written. */
export type MentionIndex = [line: number, who: string, name: string][];

export function mentionIndex(text: string): MentionIndex {
  if (!text.includes("@[[")) return [];
  const rows: MentionIndex = [];
  for (const { line, index } of linesOutsideCode(text)) {
    const seen = new Set<string>();
    for (const mention of mentionsOn(line)) {
      const who = mentionKey(mention);
      if (seen.has(who)) continue;
      seen.add(who);
      rows.push([index, who, mentionName(mention)]);
    }
  }
  return rows;
}
