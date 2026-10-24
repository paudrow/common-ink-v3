import type { MailAddress, MailRuleFields } from "./protocol.ts";

/*
 * Skip rules: what a member asks of mail for it not to be kept, as a mail app's filters ask. A rule
 * is read against the message that would be kept, which for a forward is the message forwarded, as
 * its sender wrote it: its sender, its recipients, its headers. The member who forwarded it is never
 * what a rule is read against.
 */

/** What a rule is read against: a message as it is kept. */
export interface Ruled {
  from: MailAddress;
  to: readonly MailAddress[];
  cc: readonly MailAddress[];
  subject: string;
  text: string;
  listId: string | null;
  attachments: number;
}

/** The words and "quoted phrases" a field of a rule holds, in lower case. */
export function termsOf(field: string): string[] {
  return [...field.toLowerCase().matchAll(/"([^"]*)"?|([^\s"]+)/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The addresses and domains a `from` or `to` holds, apart by commas, spaces or OR. */
const addressesOf = (field: string) =>
  field
    .toLowerCase()
    .split(/\s+or\s+|[\s,;]+/)
    .map((part) => part.replace(/^[<"]+|[>"]+$/g, ""))
    .filter((part) => part && part !== "@");

/**
 * Whether an address is one a rule names: the address itself, or one at a domain it names, `@domain`
 * or `domain`, or a domain inside it, as `example.com` names `news.example.com`.
 */
export function addressNamed(address: string, named: string): boolean {
  const said = address.toLowerCase();
  const at = named.indexOf("@");
  if (at > 0) return said === named;
  const domain = named.replace(/^@/, "");
  const theirs = said.slice(said.lastIndexOf("@") + 1);
  return theirs === domain || theirs.endsWith(`.${domain}`);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether text holds a term as words of its own: "sale" is in "a sale!", and not in "wholesale". */
const holds = (text: string, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(term)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/** Whether a rule asks anything of a message: one with every field empty would match all mail. */
export const asksAnything = (rule: MailRuleFields) => rule.hasAttachment || [rule.from, rule.to, rule.subject, rule.hasWords, rule.doesntHave, rule.list].some((field) => field.trim() !== "");

/** Whether a rule matches a message: everything it asks, each field it fills, is so of the message. */
export function skips(rule: MailRuleFields, m: Ruled): boolean {
  if (!asksAnything(rule)) return false;
  const from = addressesOf(rule.from);
  if (from.length && !from.some((named) => addressNamed(m.from.address, named))) return false;
  const to = addressesOf(rule.to);
  if (to.length && ![...m.to, ...m.cc].some((a) => to.some((named) => addressNamed(a.address, named)))) return false;
  const subject = termsOf(rule.subject);
  if (subject.length && !subject.every((term) => holds(m.subject, term))) return false;
  const words = `${m.subject}\n${m.text}`;
  if (!termsOf(rule.hasWords).every((term) => holds(words, term))) return false;
  if (termsOf(rule.doesntHave).some((term) => holds(words, term))) return false;
  const list = rule.list.trim().toLowerCase().replace(/^<|>$/g, "");
  if (list && !m.listId?.toLowerCase().includes(list)) return false;
  if (rule.hasAttachment && m.attachments === 0) return false;
  return true;
}

/** What "Skip mail like this" starts a rule with, from a message: its mailing list where it came through one, and otherwise its sender. */
export const ruleLike = (m: Pick<Ruled, "from" | "listId">): MailRuleFields => {
  const list = /<([^<>]+)>/.exec(m.listId ?? "")?.[1] ?? m.listId?.trim() ?? "";
  return { from: list ? "" : m.from.address, to: "", subject: "", hasWords: "", doesntHave: "", list, hasAttachment: false };
};
