import { describe, expect, it } from "vitest";
import type { Contact } from "../../src/core/protocol.ts";
import { senderInContacts } from "../../src/web/plugins/contacts/matching.ts";

const contact = (id: string, name: string, emails: string[] = []): Contact => ({ sourceId: "google-contacts", id, name, emails: emails.map((value) => ({ value, type: null })), phones: [], organization: null, url: null });

describe("an email's sender in the member's contacts", () => {
  const contacts = [contact("a", "Ada Lovelace", ["ada@example.com"]), contact("b", "Grace Hopper", ["grace@example.com"]), contact("c", "Grace Hopper")];
  const where = (name: string | null, address: string) => {
    const found = senderInContacts(contacts, { name, address });
    return found.kind === "known" ? ["known", found.contact.id] : found.kind === "add" ? ["add", ...found.contacts.map((c) => c.id)] : ["new"];
  };

  it("is the contact that has the address already, in any case, whatever name the mail gave", () => {
    expect(where("A. Lovelace", "ADA@example.com")).toEqual(["known", "a"]);
  });

  it("is each contact of the sender's name, ignoring case and accents, where none has the address: the address is added to one", () => {
    expect(where("ada lovelace", "countess@lovelace.example")).toEqual(["add", "a"]);
    expect(where("Grace  Hopper", "admiral@navy.example")).toEqual(["add", "b", "c"]);
  });

  it("is someone new where neither the address nor the name is a contact's", () => {
    expect(where("Lin Wei", "lin@example.org")).toEqual(["new"]);
    expect(where(null, "nobody@example.org")).toEqual(["new"]);
  });
});
