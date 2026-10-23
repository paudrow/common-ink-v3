import type { CompletionItem, Contact, Member, Role, Source, WrittenMention } from "../../plugin-api.ts";
import { isPersonId, mentionName, readableName, writtenMention } from "../../plugin-api.ts";
import { AT_ALONE, namable, sameName, startsWords } from "../lib/pointing.ts";

/** The people a mention can be of, as the member's own browser knows them: the workspace's members, and the member's own contacts. */
export interface People {
  members: ReadonlyMap<string, Member>;
  /** Whether the reader is told who the members are, as a guest and a share link's reader aren't. */
  told: boolean;
  /** Null until they are read, which is when the member first types `@`. */
  contacts: readonly Contact[] | null;
}

/** Where `@` adds a contact of a name it finds nobody for: `into`, the name of the data source, and `create`, which makes the contact and answers the mention to write, or null where it couldn't. */
export interface Adding {
  into: string;
  create(name: string): Promise<string | null>;
}

/** Where the member adds a contact: their first connected contacts data source that takes changes, or null where there is none. */
export const addingTo = (sources: readonly Source[]) => sources.find((s) => s.kind === "contacts" && s.state === "connected" && s.writable) ?? null;

const MOST_OFFERED = 50;
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

/**
 * What `@` offers for what was typed after it: the members whose name it starts, then the member's
 * contacts whose name, email or organization it starts. A member is written by their id and name,
 * and a contact by name alone: nothing else of a contact goes into the note. A member's preview is
 * their role and the email the member list told. A contact's email is matched and never shown, in
 * the list or its preview: what the list shows is in the page, where any plugin can read it. Nothing
 * for what can't be the start of a name, which closes the list. For nothing typed, a few people,
 * the member first.
 *
 * Where nobody is named the words typed, ignoring case, they have a letter in them, and the member
 * has somewhere to add a contact, `adding`, it offers last to create a contact of that name, which
 * picked is mentioned as any contact is. It is of the kind that comes after every other and waits to be picked on purpose, so
 * Enter never takes it.
 */
export function offered(typed: string, { members, contacts }: People, meId: string, adding: Adding | null = null): CompletionItem[] {
  if (!namable(typed)) return [];
  const emails = new Set([...members.values()].flatMap((m) => (m.email ? [m.email.toLowerCase()] : [])));
  const fromMembers = [...members.values()]
    .toSorted((a, b) => (typed ? 0 : Number(b.personId === meId) - Number(a.personId === meId)))
    .filter((m) => startsWords(typed, [m.name]))
    .map(
      (m): CompletionItem => ({
        kind: "person",
        label: m.name || "No name",
        description: m.personId === meId ? "You" : "Member",
        preview: { facts: [["Role", ROLE_LABEL[m.role]], ...(m.email ? [["Email", m.email] as const] : [])] },
        insert: writtenMention({ id: m.personId, name: m.name }),
        tone: "accent",
      }),
    );
  const fromContacts = (contacts ?? [])
    // Someone already offered as a member isn't offered again as a contact, where the two can be told to be one.
    .filter((c) => c.name.trim() && !c.emails.some((email) => emails.has(email.value.toLowerCase())) && startsWords(typed, [c.name, c.organization ?? "", ...c.emails.map((e) => e.value)]))
    .map((c): CompletionItem => ({ kind: "person", label: c.name, description: ["Contact", c.organization].filter(Boolean).join(" · "), insert: writtenMention({ name: c.name }), tone: "muted" }))
    .filter((item) => item.insert);
  const found = [...fromMembers, ...fromContacts].slice(0, typed ? MOST_OFFERED : AT_ALONE.person);
  const name = readableName(typed.replace(/\s+/g, " "));
  const taken = [...[...members.values()].map((m) => m.name), ...(contacts ?? []).map((c) => c.name)].some((other) => sameName(other, name));
  if (taken || !adding || !/\p{L}/u.test(name)) return found;
  return [...found, { kind: "new", label: `Create contact “${name}”`, description: `New contact in ${adding.into}`, insert: () => adding.create(name) }];
}

/**
 * How a mention is shown: as its own words where it has them, and otherwise a member by their name
 * now, in the theme colour, and anyone else by the name written, in gray. An id that is no member's
 * is someone who has left, to a reader who is told who the members are, and nobody named to anyone
 * else. Hovering it says who it is.
 */
export interface Shown {
  text: string;
  member: boolean;
  hint: string;
}

export function shown(mention: Pick<WrittenMention, "target" | "label">, { members, told }: Pick<People, "members" | "told">): Shown {
  const member = isPersonId(mention.target) ? members.get(mention.target) : undefined;
  if (member) {
    const name = member.name || "No name";
    return { text: `@${mention.label ?? name}`, member: true, hint: `${name}, a member of this workspace` };
  }
  const name = mentionName(mention);
  if (name !== null) return { text: `@${mention.label ?? name}`, member: false, hint: `${name}, mentioned by name` };
  return told
    ? { text: `@${mention.label ?? "A former member"}`, member: false, hint: "Someone who is no longer a member of this workspace" }
    : { text: `@${mention.label ?? "Someone"}`, member: false, hint: "Someone in this workspace, whom only its members are told of" };
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
