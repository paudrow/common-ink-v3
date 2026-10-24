import type { Contact, DuplicatePair, SameBy } from "./protocol.ts";
import { folded } from "./query.ts";

/** The fewest digits a phone number is matched by: fewer is an extension or a short code, which many people share. */
const PHONE_DIGITS = 7;

const emailKey = (email: string) => email.trim().toLowerCase();
const digitsOf = (phone: string) => phone.replace(/\D/g, "");

/** How a pair is named, whichever way round it is found: its data source and its two ids in order. */
export const pairKey = (sourceId: string, a: string, b: string) => [sourceId, ...[a, b].sort()].join(" ");

/**
 * The pairs of one data source's contacts that look like the same person: they share an email
 * address or a phone number, or have the same name, ignoring case and accents. Phone numbers match
 * when one's digits end with the other's, so +1 555 0142 is 555 0142. A pair is listed once, with
 * every way the two are the same, in the order the contacts were given.
 */
export function duplicatePairs(contacts: readonly Contact[]): DuplicatePair[] {
  const found = new Map<string, { pair: [Contact, Contact]; sameBy: Set<SameBy> }>();
  const order = new Map(contacts.map((c, i) => [c, i]));
  const add = (a: Contact, b: Contact, by: SameBy) => {
    if (a === b || a.sourceId !== b.sourceId || a.id === b.id) return;
    const pair: [Contact, Contact] = order.get(a)! < order.get(b)! ? [a, b] : [b, a];
    const key = pairKey(a.sourceId, a.id, b.id);
    const entry = found.get(key) ?? { pair, sameBy: new Set<SameBy>() };
    entry.sameBy.add(by);
    found.set(key, entry);
  };
  const grouped = (by: SameBy, keysOf: (c: Contact) => string[]) => {
    const groups = new Map<string, Contact[]>();
    for (const contact of contacts) for (const key of new Set(keysOf(contact))) groups.set(`${contact.sourceId} ${key}`, [...(groups.get(`${contact.sourceId} ${key}`) ?? []), contact]);
    return [...groups.values()].filter((group) => group.length > 1).map((group) => ({ by, group }));
  };
  for (const { by, group } of [...grouped("email", (c) => c.emails.map((e) => emailKey(e.value)).filter(Boolean)), ...grouped("name", (c) => [folded(c.name)].filter(Boolean))]) {
    for (const [i, a] of group.entries()) for (const b of group.slice(i + 1)) add(a, b, by);
  }
  // Numbers are grouped by their last digits, then matched within a group by how they end.
  const phones = (c: Contact) => c.phones.map((p) => digitsOf(p.value)).filter((d) => d.length >= PHONE_DIGITS);
  for (const { group } of grouped("phone", (c) => phones(c).map((d) => d.slice(-PHONE_DIGITS)))) {
    for (const [i, a] of group.entries()) for (const b of group.slice(i + 1)) if (phones(a).some((x) => phones(b).some((y) => x.endsWith(y) || y.endsWith(x)))) add(a, b, "phone");
  }
  const BY: readonly SameBy[] = ["email", "phone", "name"];
  return [...found.values()]
    .map(({ pair, sameBy }) => ({ sourceId: pair[0].sourceId, contacts: pair, sameBy: BY.filter((by) => sameBy.has(by)) }))
    .sort((x, y) => order.get(x.contacts[0])! - order.get(y.contacts[0])! || order.get(x.contacts[1])! - order.get(y.contacts[1])!);
}
