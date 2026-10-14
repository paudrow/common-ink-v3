import type { ContactCard } from "../../plugin-api.ts";

/** One thing a contact's card says, as a page lists it: what it is, and each value it has. */
export interface Field {
  /** Which of the contact's fields it is, which a change to it would name. */
  key: "emails" | "phones" | "organization" | "addresses" | "birthday" | "urls" | "notes";
  label: string;
  values: string[];
  /** How a value is followed, where it can be: mail, a call, a page. */
  href?: (value: string) => string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A birthday as written, YYYY-MM-DD or --MM-DD, as words: 21 April 1990, or 21 April. */
export function birthdayWords(birthday: string): string {
  const [, year, month, day] = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(birthday) ?? [];
  const name = MONTHS[Number(month) - 1];
  if (!name) return birthday;
  return `${Number(day)} ${name}${year && year !== "-" ? ` ${Number(year)}` : ""}`;
}

/** What a contact's card lists, in the order shown: only what it has. */
export function fieldsOf(card: ContactCard): Field[] {
  const work = [card.title, card.organization].filter(Boolean).join(", ");
  const all: Field[] = [
    { key: "emails", label: "Email", values: card.emails, href: (email) => `mailto:${email}` },
    { key: "phones", label: "Phone", values: card.phones, href: (phone) => `tel:${phone.replace(/[^\d+]/g, "")}` },
    { key: "organization", label: "Work", values: work ? [work] : [] },
    { key: "addresses", label: "Address", values: card.addresses },
    { key: "birthday", label: "Birthday", values: card.birthday ? [birthdayWords(card.birthday)] : [] },
    { key: "urls", label: "Website", values: card.urls, href: (url) => url },
    { key: "notes", label: "Notes", values: card.notes ? [card.notes] : [] },
  ];
  return all.filter((field) => field.values.length > 0);
}

/** A person's initials, for where they have no picture. */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("") || "?";
