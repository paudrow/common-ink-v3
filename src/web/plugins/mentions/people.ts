import type { CompletionItem, Contact, Member, WrittenMention } from "../../plugin-api.ts";
import { isPersonId, mentionName, writtenMention } from "../../plugin-api.ts";

/** The people a mention can be of, as the member's own browser knows them: the workspace's members, and the member's own contacts. */
export interface People {
  members: ReadonlyMap<string, Member>;
  /** Null until they are read, which is when the member first types `@`. */
  contacts: readonly Contact[] | null;
}

const MOST_OFFERED = 50;
/** A name is a few words. More than this after an `@` is prose that happens to follow one. */
const MOST_WORDS = 4;

// Accents are left out of the comparison, so "zoe" finds Zoë.
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const wordsOf = (text: string) => plain(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether every word typed starts a word of one of `texts`. */
export function startsWords(typed: string, texts: readonly string[]): boolean {
  const words = texts.flatMap(wordsOf);
  return wordsOf(typed).every((word) => words.some((w) => w.startsWith(word)));
}

/**
 * What `@` offers for what was typed after it: the members whose name it starts, then the member's
 * contacts whose name, email or organization it starts. A member is written by their id and name,
 * and a contact by name alone: nothing else of a contact goes into the note. A contact's email is
 * matched and never shown: what the list shows is in the page, where any plugin can read it. Nothing for what can't
 * be the start of a name, which closes the list.
 */
export function offered(typed: string, { members, contacts }: People, meId: string): CompletionItem[] {
  if (/[[\]|]/.test(typed) || typed.trim().split(/\s+/).length > MOST_WORDS) return [];
  const emails = new Set([...members.values()].flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])));
  const fromMembers = [...members.values()]
    .filter((m) => startsWords(typed, [m.name]))
    .map((m): CompletionItem => ({ label: m.name || "No name", detail: m.personId === meId ? "You" : "Member", insert: writtenMention({ id: m.personId, name: m.name }), tone: "accent" }));
  const fromContacts = (contacts ?? [])
    // Someone already offered as a member isn't offered again as a contact, where the two can be told to be one.
    .filter((c) => c.name.trim() && !c.emails.some((email) => emails.has(email.toLowerCase())) && startsWords(typed, [c.name, c.organization ?? "", ...c.emails]))
    .map((c): CompletionItem => ({ label: c.name, detail: ["Contact", c.organization].filter(Boolean).join(" · "), insert: writtenMention({ name: c.name }), tone: "muted" }))
    .filter((item) => item.insert);
  return [...fromMembers, ...fromContacts].slice(0, MOST_OFFERED);
}

/** How a mention is shown: a member by their name now, in the theme colour, and anyone else by the name as written, in gray. */
export interface Shown {
  text: string;
  member: boolean;
  hint: string;
}

export function shown(mention: Pick<WrittenMention, "target" | "label">, members: People["members"]): Shown {
  const member = isPersonId(mention.target) ? members.get(mention.target) : undefined;
  if (member) return { text: `@${member.name || "No name"}`, member: true, hint: `${member.name || "No name"}, a member of this workspace` };
  return { text: `@${mentionName(mention)}`, member: false, hint: `${mentionName(mention)}, mentioned by name` };
}

/** The members among `now` that `before` didn't mention, each once: who a change to a note newly mentions. */
export function newlyMentioned(before: Iterable<WrittenMention>, now: Iterable<WrittenMention>, members: People["members"]): Member[] {
  const had = new Set([...before].map((m) => m.target));
  const found = new Map<string, Member>();
  for (const { target } of now) {
    const member = had.has(target) ? undefined : members.get(target);
    if (member) found.set(target, member);
  }
  return [...found.values()];
}
