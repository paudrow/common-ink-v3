import type { Contact, ContactCard, ContactChange, ContactLine, DuplicatePair, LabelledField, SameBy } from "./protocol.ts";
import { folded } from "./query.ts";

/** The fewest digits a phone number is matched by: fewer is an extension or a short code, which many people share. */
const PHONE_DIGITS = 7;

const emailKey = (email: string) => email.trim().toLowerCase();
/** A number's digits without a leading 0, so a number dialled at home, 020 7946 0000, ends as the same number dialled abroad, +44 20 7946 0000. */
const digitsOf = (phone: string) => phone.replace(/\D/g, "").replace(/^0+/, "");

/** How a pair is named, whichever way round it is found: its data source and its two ids in order. */
export const pairKey = (sourceId: string, a: string, b: string) => [sourceId, ...[a, b].sort()].join(" ");

/**
 * The pairs of one data source's contacts that look like the same person: they share an email
 * address or a phone number, or have the same name, ignoring case and accents. Phone numbers match
 * when one's digits end with the other's, so +1 555 0142 is 555 0142 and +44 20 7946 0000 is 020 7946 0000. A pair is listed once, with
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

/** What two lines of a field are compared by: an address in any case, a number by its digits, a page without its last slash. */
const LINE_KEY: Record<LabelledField, (value: string) => string> = {
  emails: emailKey,
  phones: (value) => digitsOf(value) || value.trim(),
  addresses: (value) => folded(value),
  urls: (value) => value.trim().toLowerCase().replace(/\/+$/, ""),
};

/** The fewest digits a number has without its country code for one with it to be the same number when combining: a whole national number. */
const NATIONAL_DIGITS = 9;

/**
 * Whether two lines are one when two contacts are combined. Stricter than matching contacts, since a
 * line taken for another is dropped: a number is the same only as itself, or with a country code of
 * up to three digits before a whole national number, so 555 0142 is kept beside 415 555 0142.
 */
export const sameLine = (field: LabelledField, a: string, b: string) => {
  const [x, y] = [LINE_KEY[field](a), LINE_KEY[field](b)];
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return field === "phones" && /^\d+$/.test(x + y) && short.length >= NATIONAL_DIGITS && long.length - short.length <= 3 && long.endsWith(short);
};

/** The main contact's lines, then each of the other's that isn't one of them. A line both have keeps the main's label, or takes the other's where the main's has none. */
function joined(field: LabelledField, main: readonly ContactLine[], other: readonly ContactLine[]): ContactLine[] {
  const lines = main.map((line) => ({ ...line }));
  for (const line of other) {
    const same = lines.find((l) => sameLine(field, l.value, line.value));
    if (!same) lines.push({ ...line });
    else same.type ??= line.type;
  }
  return lines;
}

/** Both notes where they differ, the main's first; one where the other already holds it. */
export function joinedNotes(main: string | null, other: string | null): string | null {
  if (!main?.trim()) return other;
  if (!other?.trim() || main.includes(other.trim())) return main;
  if (other.includes(main.trim())) return other;
  return `${main.trimEnd()}\n\n${other.trim()}`;
}

/**
 * Two contacts as one: the main contact, with every email, phone, address and website of the other
 * it doesn't have, and the other's notes after its own. Where a field holds one value, the main's
 * wins and the other's fills it only where the main has none: the name, the organization and title
 * together, and the birthday. The picture is the main's.
 */
export function combinedContact(main: ContactCard, other: ContactCard): ContactCard {
  const work = main.organization || main.title ? main : other;
  return {
    ...main,
    name: main.name.trim() ? main.name : other.name,
    emails: joined("emails", main.emails, other.emails),
    phones: joined("phones", main.phones, other.phones),
    addresses: joined("addresses", main.addresses, other.addresses),
    urls: joined("urls", main.urls, other.urls),
    organization: work.organization,
    title: work.title,
    birthday: main.birthday ?? other.birthday,
    notes: joinedNotes(main.notes, other.notes),
  };
}

/** A contact's fields as a change writes them, each as a whole: what makes another contact this one. */
export const contactFields = ({ name, emails, phones, organization, title, addresses, birthday, urls, notes }: ContactCard): ContactChange & { name: string } => ({ name, emails, phones, organization, title, addresses, birthday, urls, notes });

/** What merging `other` into `main` changes of `main`: each field `combinedContact` makes other than it was, and no other. */
export function mergeChange(main: ContactCard, other: ContactCard): ContactChange {
  const was: ContactChange = contactFields(main);
  return Object.fromEntries(Object.entries(contactFields(combinedContact(main, other))).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(was[key as keyof ContactChange])));
}
