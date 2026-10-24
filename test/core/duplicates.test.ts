import { describe, expect, it } from "vitest";
import { combinedContact, duplicatePairs, pairKey } from "../../src/core/duplicates.ts";
import type { Contact, ContactCard } from "../../src/core/protocol.ts";

const contact = (id: string, name: string, more: { emails?: string[]; phones?: string[]; sourceId?: string } = {}): Contact => ({
  sourceId: more.sourceId ?? "google-contacts",
  id,
  name,
  emails: (more.emails ?? []).map((value) => ({ value, type: null })),
  phones: (more.phones ?? []).map((value) => ({ value, type: null })),
  organization: null,
  url: null,
});
const pairs = (contacts: Contact[]) => duplicatePairs(contacts).map((p) => [p.contacts[0].id, p.contacts[1].id, p.sameBy]);

describe("contacts that look like the same person", () => {
  it("are two that share an email address, ignoring case and spaces", () => {
    expect(pairs([contact("a", "Ada Lovelace", { emails: ["ada@example.com"] }), contact("b", "Ada King", { emails: [" ADA@Example.com", "king@example.org"] }), contact("c", "Grace", { emails: ["grace@example.com"] })])).toEqual([["a", "b", ["email"]]]);
  });

  it("are two with the same name, ignoring case, accents and punctuation", () => {
    expect(pairs([contact("a", "Zoë Álvarez"), contact("b", "zoe  alvarez"), contact("c", "Zoe Alvarez-Smith"), contact("d", "Zoe")])).toEqual([["a", "b", ["name"]]]);
  });

  it("are two whose phone numbers end the same, so a country code or punctuation doesn't hide one", () => {
    expect(pairs([contact("a", "Sam", { phones: ["+1 (555) 014-2"] }), contact("b", "Okafor Plumbing", { phones: ["555 0142"] }), contact("c", "Other", { phones: ["+1 555 0143"] })])).toEqual([["a", "b", ["phone"]]]);
  });

  it("are two with one number dialled at home and from abroad", () => {
    expect(pairs([contact("a", "Ada", { phones: ["020 7946 0000"] }), contact("b", "Countess", { phones: ["+44 20 7946 0000"] })])).toEqual([["a", "b", ["phone"]]]);
  });

  it("are not two that share a short number or only its last digits", () => {
    expect(pairs([contact("a", "Desk", { phones: ["101"] }), contact("b", "Front", { phones: ["101"] }), contact("c", "One", { phones: ["+44 20 5550 0142"] }), contact("d", "Two", { phones: ["+1 312 550 0142"] })])).toEqual([]);
  });

  it("lists a pair once with every way the two are the same, in the order email, phone, name", () => {
    expect(pairs([contact("a", "Ada", { emails: ["ada@example.com"], phones: ["+1 555 0100"] }), contact("b", "ada", { emails: ["ada@example.com"], phones: ["5550100"] })])).toEqual([["a", "b", ["email", "phone", "name"]]]);
  });

  it("pairs each two of three that are the same, in the order the contacts came", () => {
    expect(pairs([contact("x", "Grace Hopper"), contact("y", "Grace Hopper"), contact("z", "grace hopper")])).toEqual([
      ["x", "y", ["name"]],
      ["x", "z", ["name"]],
      ["y", "z", ["name"]],
    ]);
  });

  it("never pairs contacts of two data sources, which can't be merged into one", () => {
    expect(pairs([contact("a", "Ada", { emails: ["ada@example.com"] }), contact("a", "Ada", { emails: ["ada@example.com"], sourceId: "sample-contacts" })])).toEqual([]);
  });

  it("never pairs a contact with no name by its name", () => {
    expect(pairs([contact("a", ""), contact("b", "  ")])).toEqual([]);
  });

  it("names a pair the same whichever way round it is found", () => {
    expect(pairKey("google-contacts", "people/c2", "people/c1")).toBe(pairKey("google-contacts", "people/c1", "people/c2"));
  });
});

const card = (id: string, fields: Partial<ContactCard>): ContactCard => ({ sourceId: "google-contacts", id, name: "", emails: [], phones: [], organization: null, url: null, title: null, addresses: [], birthday: null, notes: null, photo: null, urls: [], etag: `${id}-1`, ...fields });

describe("two contacts as one", () => {
  const ada = card("a", {
    name: "Ada Lovelace",
    emails: [{ value: "ada@example.com", type: null }],
    phones: [{ value: "+44 20 7946 0000", type: "home" }],
    organization: "Analytical Engines",
    title: null,
    addresses: [{ value: "12 St James's Square, London", type: "home" }],
    birthday: "1815-12-10",
    urls: [{ value: "https://ada.example/", type: "blog" }],
    notes: "Wrote the first program.",
    photo: "https://lh3.googleusercontent.com/a",
  });
  const king = card("b", {
    name: "Ada King",
    emails: [{ value: "ADA@example.com", type: "home" }, { value: "countess@lovelace.example", type: "work" }],
    phones: [{ value: "020 7946 0000", type: "mobile" }, { value: "+44 20 7946 0001", type: null }],
    organization: "Royal Society",
    title: "Countess",
    addresses: [{ value: "12 st james's square london", type: "work" }, { value: "Ockham Park, Surrey", type: null }],
    birthday: "--12-10",
    urls: [{ value: "https://ada.example", type: null }],
    notes: "Married William King.",
  });

  it("is the main contact with every line of the other it doesn't have, after its own, once each", () => {
    expect(combinedContact(ada, king)).toEqual({
      ...ada,
      // The same address in another case, and the same number dialled at home rather than from abroad, are the main's.
      emails: [{ value: "ada@example.com", type: "home" }, { value: "countess@lovelace.example", type: "work" }],
      phones: [{ value: "+44 20 7946 0000", type: "home" }, { value: "+44 20 7946 0001", type: null }],
      addresses: [{ value: "12 St James's Square, London", type: "home" }, { value: "Ockham Park, Surrey", type: null }],
      urls: [{ value: "https://ada.example/", type: "blog" }],
      notes: "Wrote the first program.\n\nMarried William King.",
    });
  });

  it("keeps the main's name, work, birthday and picture where it has them, and fills in the other's where it has none", () => {
    expect(combinedContact(ada, king)).toMatchObject({ id: "a", etag: "a-1", name: "Ada Lovelace", organization: "Analytical Engines", title: null, birthday: "1815-12-10", photo: "https://lh3.googleusercontent.com/a" });
    const bare = card("c", { name: " " });
    expect(combinedContact(bare, king)).toMatchObject({ id: "c", name: "Ada King", organization: "Royal Society", title: "Countess", birthday: "--12-10", notes: "Married William King.", photo: null });
  });

  it("takes the other's label for a line both have where the main's has none", () => {
    expect(combinedContact(card("a", { emails: [{ value: "ada@example.com", type: null }] }), card("b", { emails: [{ value: "Ada@Example.com", type: "work" }] })).emails).toEqual([{ value: "ada@example.com", type: "work" }]);
  });

  it("writes notes once where one already holds the other's", () => {
    const notes = (main: string | null, other: string | null) => combinedContact(card("a", { notes: main }), card("b", { notes: other })).notes;
    expect(notes("Met at the workshop. Likes tea.", "Likes tea.")).toBe("Met at the workshop. Likes tea.");
    expect(notes("Likes tea.", "Met at the workshop. Likes tea.")).toBe("Met at the workshop. Likes tea.");
    expect(notes(null, "Likes tea.")).toBe("Likes tea.");
    expect(notes("Likes tea.", null)).toBe("Likes tea.");
    expect(notes(null, null)).toBeNull();
  });
});
