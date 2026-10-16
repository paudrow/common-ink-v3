import type { Contact } from "../../plugin-api.ts";

// Accents are left out of the comparison, so "zoe" finds Zoë.
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whether every word typed starts a word of the contact's name, email or organization, which is how `contact.list` narrows by `query`. */
export function matches(contact: Contact, typed: string): boolean {
  const words = plain([contact.name, contact.organization ?? "", ...contact.emails.map((e) => e.value)].join(" ")).split(/[^\p{L}\p{N}]+/u);
  return plain(typed)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => words.some((w) => w.startsWith(word)));
}
