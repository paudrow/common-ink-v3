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

/**
 * Where an email's sender goes in the member's contacts: `known` when a contact has the address
 * already; `add` when none has it but contacts have the sender's name, so the address is added to
 * one of those (`contact.addEmail`) rather than the person made a contact twice; `new` when it is
 * someone new (`contact.create`).
 */
export type SenderInContacts = { kind: "known"; contact: Contact } | { kind: "add"; contacts: Contact[] } | { kind: "new" };

export function senderInContacts(contacts: readonly Contact[], sender: { name: string | null; address: string }): SenderInContacts {
  const address = sender.address.trim().toLowerCase();
  const known = contacts.find((c) => c.emails.some((e) => e.value.trim().toLowerCase() === address));
  if (known) return { kind: "known", contact: known };
  const whole = (name: string) => plain(name).trim().replace(/\s+/g, " ");
  const name = whole(sender.name ?? "");
  const named = name ? contacts.filter((c) => whole(c.name) === name) : [];
  return named.length ? { kind: "add", contacts: named } : { kind: "new" };
}
