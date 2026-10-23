import { describe, expect, it } from "vitest";
import { mentionsIn } from "../../src/core/mentions.ts";
import type { Contact, Member, Source } from "../../src/core/protocol.ts";
import { changeOf, draftOf, fieldsOf, labelChoices, labelWords, typeOf } from "../../src/web/plugins/mentions/fields.ts";
import { addingTo, newlyMentioned, offered, shown, type Adding, type People } from "../../src/web/plugins/mentions/people.ts";
import { startsWords } from "../../src/web/plugins/lib/pointing.ts";

const ADA: Member = { personId: "aaaaaaaaaaaa", name: "Ada Lovelace", role: "admin", email: "ada@example.com" };
const GRACE: Member = { personId: "gggggggggggg", name: "Grace Hopper", role: "editor" };
const contact = (name: string, more: Partial<Contact> = {}): Contact => ({ sourceId: "sample-contacts", id: name, name, emails: [], phones: [], organization: null, url: null, ...more });
const PEOPLE: People = {
  members: new Map([ADA, GRACE].map((m) => [m.personId, m])),
  told: true,
  contacts: [contact("Ada Lovelace", { emails: [{ value: "ADA@example.com", type: null }] }), contact("Grace Hopper", { emails: [{ value: "grace@navy.example", type: null }] }), contact("Sam Okafor", { organization: "Okafor Plumbing" }), contact("Zoë Álvarez", { emails: [{ value: "zoe@example.com", type: null }] }), contact("  ")],
};
const labels = (typed: string, people = PEOPLE) => offered(typed, people, ADA.personId).map((item) => `${item.label} (${item.description}, ${item.tone})`);

describe("what @ offers", () => {
  it("is the members in the theme colour, then the member's contacts in gray, without a contact who is a member by their email", () => {
    expect(labels("grace")).toEqual(["Grace Hopper (Member, accent)", "Grace Hopper (Contact, muted)"]);
    expect(labels("ada")).toEqual(["Ada Lovelace (You, accent)"]);
  });

  it("alone, is three people, the member first wherever the members list them", () => {
    const graceFirst = { ...PEOPLE, members: new Map([GRACE, ADA].map((m) => [m.personId, m])) };
    expect(labels("", graceFirst)).toEqual(["Ada Lovelace (You, accent)", "Grace Hopper (Member, accent)", "Grace Hopper (Contact, muted)"]);
    expect(labels("", { members: new Map(), told: false, contacts: PEOPLE.contacts })).toEqual(["Ada Lovelace (Contact, muted)", "Grace Hopper (Contact, muted)", "Sam Okafor (Contact · Okafor Plumbing, muted)"]);
  });

  it("puts no contact's email on the page, which any plugin in it could read", () => {
    const shown = JSON.stringify(["ada", "grace", "zoe"].flatMap((typed) => offered(typed, PEOPLE, ADA.personId)));
    for (const email of ["ADA@example.com", "grace@navy.example", "zoe@example.com"]) expect(shown).not.toContain(email);
  });

  it("are people, previewed for a member by their role and the email the member list told, and for a contact not at all", () => {
    expect(offered("", PEOPLE, ADA.personId).map((item) => [item.kind, item.label, item.preview])).toEqual([
      ["person", "Ada Lovelace", { facts: [["Role", "Admin"], ["Email", "ada@example.com"]] }],
      ["person", "Grace Hopper", { facts: [["Role", "Editor"]] }],
      ["person", "Grace Hopper", undefined],
    ]);
  });

  it("narrows by the start of any word of a name, and for a contact of their email or organization, ignoring case and accents", () => {
    expect(labels("hop")).toEqual(["Grace Hopper (Member, accent)", "Grace Hopper (Contact, muted)"]);
    expect(labels("zoe al")).toEqual(["Zoë Álvarez (Contact, muted)"]);
    expect(labels("plumb")).toEqual(["Sam Okafor (Contact · Okafor Plumbing, muted)"]);
    expect(labels("race")).toEqual([]);
    expect(startsWords("ada l", ["Ada Lovelace"])).toBe(true);
  });

  it("closes for what is no name: brackets, or prose that goes on after an @", () => {
    expect(labels("[[aaaaaaaaaaaa|Ada Lovelace]]")).toEqual([]);
    expect(labels("ada is at the office today")).toEqual([]);
  });

  it("writes a member by id, and a contact by name alone: no email, organization, or id of theirs", () => {
    const written = ["", "sam"].flatMap((typed) => offered(typed, PEOPLE, ADA.personId)).map((item) => item.insert);
    expect(written).toEqual(["[[person:aaaaaaaaaaaa]]", "[[person:gggggggggggg]]", "[[person:Grace Hopper]]", "[[person:Sam Okafor]]"]);
  });

  it("offers the members alone until the contacts are read", () => {
    expect(labels("", { ...PEOPLE, contacts: null })).toEqual(["Ada Lovelace (You, accent)", "Grace Hopper (Member, accent)"]);
  });
});

describe("what @ offers where nobody is named what was typed", () => {
  /** Adding to the sample contacts, keeping each name it is asked to create. */
  const adding = (created: string[] = []): Adding => ({ into: "Sample contacts", create: async (name) => (created.push(name), `[[person:${name}]]`) });
  const offeredNew = (typed: string, people = PEOPLE) => offered(typed, people, ADA.personId, adding()).map((item) => `${item.label} (${item.description}, ${item.kind})`);

  it("is to create a contact of the name typed, in the contacts it would be added to, as a kind of its own", () => {
    expect(offeredNew("Zelda Fitz")).toEqual(["Create contact “Zelda Fitz” (New contact in Sample contacts, new)"]);
    expect(offeredNew("  zelda   fitz ")).toEqual(["Create contact “zelda fitz” (New contact in Sample contacts, new)"]);
  });

  it("comes after everyone found, and is nothing new where a member or a contact is named that, ignoring case", () => {
    expect(offeredNew("Grace")).toEqual(["Grace Hopper (Member, person)", "Grace Hopper (Contact, person)", "Create contact “Grace” (New contact in Sample contacts, new)"]);
    expect(offeredNew("plumb")).toEqual(["Sam Okafor (Contact · Okafor Plumbing, person)", "Create contact “plumb” (New contact in Sample contacts, new)"]);
    expect(offeredNew("Zel")).toEqual(["Create contact “Zel” (New contact in Sample contacts, new)"]);
    expect(offeredNew("grace hopper")).toEqual(["Grace Hopper (Member, person)", "Grace Hopper (Contact, person)"]);
    expect(offeredNew("Sam Okafor")).toEqual(["Sam Okafor (Contact · Okafor Plumbing, person)"]);
  });

  it("is nothing where there is nowhere to add one, nothing typed, no letter, or no name", () => {
    expect(offered("Zelda Fitz", PEOPLE, ADA.personId, null)).toEqual([]);
    expect(offeredNew("", { members: new Map(), told: true, contacts: [] })).toEqual([]);
    expect(offeredNew("2026-10-21")).toEqual([]);
    expect(offeredNew("zelda is at the office today")).toEqual([]);
    expect(offeredNew("Zelda]] Fitz")).toEqual([]);
  });

  it("creates the contact by the name typed when picked, and writes what creating it answers", async () => {
    const created: string[] = [];
    const [item] = offered("Zelda  Fitz", PEOPLE, ADA.personId, adding(created));
    const insert = item!.insert as (at: { noteId: string }) => Promise<string | null>;
    expect(await insert({ noteId: "n" })).toBe("[[person:Zelda Fitz]]");
    expect(created).toEqual(["Zelda Fitz"]);
  });

  it("adds to the first connected contacts that take changes, and to none that are read-only, a calendar, or not connected", () => {
    const source = (id: string, more: Partial<Source>): Source => ({ id, kind: "contacts", name: id, provider: "Google", state: "connected", writable: true, account: "ada@example.com", ...more });
    const sources = [source("calendar", { kind: "calendar" }), source("gone", { state: "needs_reconnect" }), source("reading", { writable: false, reconnectToWrite: true }), source("work", {}), source("home", {})];
    expect(addingTo(sources)?.id).toBe("work");
    expect(addingTo(sources.slice(0, 3))).toBe(null);
  });
});

describe("how a mention is shown", () => {
  it("is a member's name as it is now, and anyone else's as written", () => {
    expect(shown({ target: GRACE.personId, label: null }, PEOPLE)).toEqual({ text: "@Grace Hopper", member: true, hint: "Grace Hopper, a member of this workspace" });
    expect(shown({ target: "Sam Okafor", label: null }, PEOPLE)).toEqual({ text: "@Sam Okafor", member: false, hint: "Sam Okafor, mentioned by name" });
  });

  it("is its own words where it has them, and hovering it still says who it is", () => {
    expect(shown({ target: GRACE.personId, label: "the Admiral" }, PEOPLE)).toEqual({ text: "@the Admiral", member: true, hint: "Grace Hopper, a member of this workspace" });
    expect(shown({ target: "Sam Okafor", label: "Sammy" }, PEOPLE)).toEqual({ text: "@Sammy", member: false, hint: "Sam Okafor, mentioned by name" });
  });

  it("is a former member for an id that is no member's, and someone to a reader who isn't told who the members are", () => {
    expect(shown({ target: "zzzzzzzzzzzz", label: null }, PEOPLE)).toMatchObject({ text: "@A former member", member: false });
    expect(shown({ target: "zzzzzzzzzzzz", label: "Zed Zimmer" }, PEOPLE)).toMatchObject({ text: "@Zed Zimmer", member: false });
    expect(shown({ target: GRACE.personId, label: null }, { members: new Map(), told: false })).toMatchObject({ text: "@Someone", member: false });
  });
});

describe("who a change newly mentions", () => {
  it("is each member the note didn't mention before, once, and never someone mentioned by name", () => {
    const before = mentionsIn("[[person:aaaaaaaaaaaa]] and [[person:Sam Okafor]]");
    const now = mentionsIn("[[person:aaaaaaaaaaaa|Ada]] and [[person:Sam Okafor]] and [[person:gggggggggggg|Grace]] [[person:gggggggggggg]] [[person:Lin Wei]] [[person:zzzzzzzzzzzz]]");
    expect(newlyMentioned(before, now, PEOPLE.members)).toEqual([GRACE]);
    expect(newlyMentioned(now, now, PEOPLE.members)).toEqual([]);
  });
});

describe("a contact's form", () => {
  const sam = { sourceId: "s", id: "sam", name: "Sam Okafor", emails: [], phones: [{ value: "+1 555 0142", type: null }], organization: "Okafor Plumbing", url: null, title: "Owner", addresses: [{ value: "12 Water Lane", type: null }], birthday: "--04-21", notes: "Prefers a text", photo: null, urls: [{ value: "https://okafor.example", type: null }], etag: "3" };

  it("changes nothing when nothing is changed, and only what differs when something is", () => {
    expect(changeOf(sam, draftOf(sam))).toEqual({ change: {} });
    const draft = { ...draftOf(sam), emails: [{ value: "  sam@okafor.example ", type: null }, { value: "", type: null }], title: " ", birthday: { day: "21", month: "4", year: "1988" }, notes: "Prefers a text\n" };
    expect(changeOf(sam, draft)).toEqual({ change: { emails: [{ value: "sam@okafor.example", type: null }], title: null, birthday: "1988-04-21" } });
  });

  it("sends a label changed alone as the whole of its field, each line with its label", () => {
    const draft = draftOf(sam);
    expect(changeOf(sam, { ...draft, phones: [{ value: "+1 555 0142", type: "mobile" }], urls: [{ value: "https://okafor.example", type: "Shop" }] })).toEqual({
      change: { phones: [{ value: "+1 555 0142", type: "mobile" }], urls: [{ value: "https://okafor.example", type: "Shop" }] },
    });
  });

  it("says why a draft can't be saved: no name, half a birthday, a day the month doesn't have", () => {
    expect(changeOf(sam, { ...draftOf(sam), name: "  " })).toEqual({ problem: "A contact needs a name" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "21", month: "", year: "" } })).toEqual({ problem: "A birthday needs its day and its month" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "29", month: "2", year: "2023" } })).toEqual({ problem: "February 2023 has no day 29" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "29", month: "2", year: "" } })).toEqual({ change: { birthday: "--02-29" } });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "", month: "", year: "" } })).toEqual({ change: { birthday: null } });
  });
});

describe("a contact's labels", () => {
  it("are shown in plain words: Google's own by field, the member's own as written, and the field's name for none", () => {
    expect(
      [
        labelWords("emails", "work"),
        labelWords("emails", "home"),
        labelWords("phones", "mobile"),
        labelWords("phones", "work"),
        labelWords("phones", "workFax"),
        labelWords("addresses", "home"),
        labelWords("urls", "blog"),
        labelWords("urls", "homePage"),
        labelWords("emails", "Navy"),
        labelWords("emails", "constructor"),
        labelWords("phones", null),
        labelWords("urls", null),
      ],
    ).toEqual(["Work email", "Home email", "Mobile", "Work phone", "Work fax", "Home address", "Blog", "Home page", "Navy", "constructor", "Phone", "Website"]);
  });

  it("are kept as Google's own where what is typed names one, by its type or its words in any case, as typed otherwise, and none for nothing", () => {
    expect([typeOf("phones", " MOBILE "), typeOf("emails", "work Email"), typeOf("urls", "homepage"), typeOf("urls", "Home  Page"), typeOf("emails", "  Navy  mail "), typeOf("phones", "Work email"), typeOf("addresses", "  ")]).toEqual([
      "mobile",
      "work",
      "homePage",
      "homePage",
      "Navy mail",
      "Work email",
      null,
    ]);
  });

  it("are offered as none, Google's own for the field, and the line's own where the member wrote one", () => {
    expect(labelChoices("emails", "Navy").map((c) => [c.type, c.words])).toEqual([
      [null, "No label"],
      ["home", "Home email"],
      ["work", "Work email"],
      ["other", "Other email"],
      ["Navy", "Navy"],
    ]);
    expect(labelChoices("phones", "mobile").map((c) => c.words)).toEqual(["No label", "Mobile", "Home phone", "Work phone", "Main", "Home fax", "Work fax", "Pager", "Other phone"]);
  });

  it("head each line of a card, with lines one after another under the same label listed under it once", () => {
    const card = {
      sourceId: "s", id: "g", name: "Grace Hopper", organization: null, url: null, title: null, birthday: null, notes: null, photo: null, etag: "1",
      emails: [{ value: "grace@example.com", type: "work" }, { value: "g@example.com", type: "work" }, { value: "hopper@navy.example", type: "Navy" }, { value: "gh@example.org", type: null }],
      phones: [{ value: "+1 555 0100", type: "mobile" }],
      addresses: [{ value: "1 Yard Lane", type: "home" }],
      urls: [{ value: "https://grace.example", type: "blog" }],
    };
    expect(fieldsOf(card).map((f) => [f.label, ...f.values])).toEqual([
      ["Work email", "grace@example.com", "g@example.com"],
      ["Navy", "hopper@navy.example"],
      ["Email", "gh@example.org"],
      ["Mobile", "+1 555 0100"],
      ["Home address", "1 Yard Lane"],
      ["Blog", "https://grace.example"],
    ]);
  });
});
