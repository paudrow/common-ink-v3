import type { CompletionItem, Contact, Member, Role, WrittenMention } from "../../plugin-api.ts";
import { isPersonId, mentionName, writtenMention } from "../../plugin-api.ts";
import { AT_ALONE, namable, startsWords } from "../lib/pointing.ts";

/** The people a mention can be of, as the member's own browser knows them: the workspace's members, and the member's own contacts. */
export interface People {
  members: ReadonlyMap<string, Member>;
  /** Null until they are read, which is when the member first types `@`. */
  contacts: readonly Contact[] | null;
}

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
 */
export function offered(typed: string, { members, contacts }: People, meId: string): CompletionItem[] {
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
  return [...fromMembers, ...fromContacts].slice(0, typed ? MOST_OFFERED : AT_ALONE.person);
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
