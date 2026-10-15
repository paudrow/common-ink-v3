import type { ContactCard, ContactChange } from "../../plugin-api.ts";

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

/** A contact as its form holds it while it is edited: each list as lines, the birthday as its three parts. */
export interface Draft {
  name: string;
  emails: string[];
  phones: string[];
  organization: string;
  title: string;
  addresses: string[];
  birthday: { day: string; month: string; year: string };
  urls: string[];
  notes: string;
}

export const LISTS = ["emails", "phones", "addresses", "urls"] as const;
export type ListKey = (typeof LISTS)[number];

export const MONTH_NAMES = MONTHS;

export function draftOf(card: ContactCard): Draft {
  const [, year = "", month = "", day = ""] = /^(\d{4}|-)-(\d{2})-(\d{2})$/.exec(card.birthday ?? "") ?? [];
  return {
    name: card.name,
    emails: [...card.emails],
    phones: [...card.phones],
    organization: card.organization ?? "",
    title: card.title ?? "",
    addresses: [...card.addresses],
    birthday: { day: day ? String(Number(day)) : "", month: month ? String(Number(month)) : "", year: year === "-" ? "" : year },
    urls: [...card.urls],
    notes: card.notes ?? "",
  };
}

const lines = (values: string[]) => values.map((v) => v.trim()).filter(Boolean);
const orNull = (value: string) => value.trim() || null;
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The birthday a draft says, as a contact writes it, null for none, or why it can't be one. */
export function birthdayOf({ day, month, year }: Draft["birthday"]): { birthday: string | null } | { problem: string } {
  if (!day.trim() && !month && !year.trim()) return { birthday: null };
  if (!day.trim() || !month) return { problem: "A birthday needs its day and its month" };
  if (!/^\d{1,2}$/.test(day.trim()) || (year.trim() && !/^\d{4}$/.test(year.trim()))) return { problem: "A birthday's day is a number, and its year four digits" };
  // With no year, 29 February is a day of the year.
  const last = new Date(Date.UTC(Number(year.trim() || 2024), Number(month), 0)).getUTCDate();
  if (Number(day) < 1 || Number(day) > last) return { problem: `${MONTHS[Number(month) - 1]}${year.trim() ? ` ${year.trim()}` : ""} has no day ${Number(day)}` };
  return { birthday: `${year.trim() || "-"}-${month.padStart(2, "0")}-${day.trim().padStart(2, "0")}` };
}

/** What a draft changes of the card it was made from: only the fields that differ, or why it can't be saved. */
export function changeOf(card: ContactCard, draft: Draft): { change: ContactChange } | { problem: string } {
  const name = draft.name.trim();
  if (!name) return { problem: "A contact needs a name" };
  const born = birthdayOf(draft.birthday);
  if ("problem" in born) return born;
  const change: ContactChange = {};
  if (name !== card.name) change.name = name;
  for (const key of LISTS) if (!same(lines(draft[key]), card[key])) change[key] = lines(draft[key]);
  if (orNull(draft.organization) !== card.organization) change.organization = orNull(draft.organization);
  if (orNull(draft.title) !== card.title) change.title = orNull(draft.title);
  if (born.birthday !== card.birthday) change.birthday = born.birthday;
  const notes = draft.notes.trim() ? draft.notes.trimEnd() : null;
  if (notes !== card.notes) change.notes = notes;
  return { change };
}
