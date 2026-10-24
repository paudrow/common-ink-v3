import { describe, expect, it } from "vitest";
import { duplicatePairs, pairKey } from "../../src/core/duplicates.ts";
import type { Contact } from "../../src/core/protocol.ts";

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
