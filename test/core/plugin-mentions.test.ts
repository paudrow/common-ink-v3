import { describe, expect, it } from "vitest";
import { mentionsIn } from "../../src/core/mentions.ts";
import type { Contact, Member } from "../../src/core/protocol.ts";
import { changeOf, draftOf } from "../../src/web/plugins/mentions/fields.ts";
import { newlyMentioned, offered, shown, startsWords, type People } from "../../src/web/plugins/mentions/people.ts";

const ADA: Member = { personId: "aaaaaaaaaaaa", name: "Ada Lovelace", role: "admin", email: "ada@example.com" };
const GRACE: Member = { personId: "gggggggggggg", name: "Grace Hopper", role: "editor" };
const contact = (name: string, more: Partial<Contact> = {}): Contact => ({ sourceId: "sample-contacts", id: name, name, emails: [], phones: [], organization: null, url: null, ...more });
const PEOPLE: People = {
  members: new Map([ADA, GRACE].map((m) => [m.personId, m])),
  contacts: [contact("Ada Lovelace", { emails: ["ADA@example.com"] }), contact("Grace Hopper", { emails: ["grace@navy.example"] }), contact("Sam Okafor", { organization: "Okafor Plumbing" }), contact("Zoë Álvarez", { emails: ["zoe@example.com"] }), contact("  ")],
};
const labels = (typed: string, people = PEOPLE) => offered(typed, people, ADA.personId).map((item) => `${item.label} (${item.detail}, ${item.tone})`);

describe("what @ offers", () => {
  it("is the members in the theme colour, then the member's contacts in gray, without a contact who is a member by their email", () => {
    expect(labels("")).toEqual(["Ada Lovelace (You, accent)", "Grace Hopper (Member, accent)", "Grace Hopper (Contact, muted)", "Sam Okafor (Contact · Okafor Plumbing, muted)", "Zoë Álvarez (Contact, muted)"]);
  });

  it("puts no contact's email on the page, which any plugin in it could read", () => {
    expect(JSON.stringify(offered("", PEOPLE, ADA.personId))).not.toContain("example");
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

  it("writes a member by id and name, and a contact by name alone: no email, organization, or id of theirs", () => {
    const written = offered("", PEOPLE, ADA.personId).map((item) => item.insert);
    expect(written).toEqual(["@[[aaaaaaaaaaaa|Ada Lovelace]]", "@[[gggggggggggg|Grace Hopper]]", "@[[Grace Hopper]]", "@[[Sam Okafor]]", "@[[Zoë Álvarez]]"]);
  });

  it("offers the members alone until the contacts are read", () => {
    expect(labels("", { ...PEOPLE, contacts: null })).toEqual(["Ada Lovelace (You, accent)", "Grace Hopper (Member, accent)"]);
  });
});

describe("how a mention is shown", () => {
  it("is a member's name as it is now, and anyone else's as written", () => {
    expect(shown({ target: GRACE.personId, label: "G. Hopper" }, PEOPLE.members)).toEqual({ text: "@Grace Hopper", member: true, hint: "Grace Hopper, a member of this workspace" });
    expect(shown({ target: "Sam Okafor", label: null }, PEOPLE.members)).toEqual({ text: "@Sam Okafor", member: false, hint: "Sam Okafor, mentioned by name" });
  });

  it("is the name as written for someone who was a member, and for a reader who isn't told who is one", () => {
    expect(shown({ target: "zzzzzzzzzzzz", label: "Zed Zimmer" }, PEOPLE.members)).toMatchObject({ text: "@Zed Zimmer", member: false });
    expect(shown({ target: GRACE.personId, label: "Grace Hopper" }, new Map())).toMatchObject({ text: "@Grace Hopper", member: false });
  });
});

describe("who a change newly mentions", () => {
  it("is each member the note didn't mention before, once, and never someone mentioned by name", () => {
    const before = mentionsIn("@[[aaaaaaaaaaaa|Ada]] and @[[Sam Okafor]]");
    const now = mentionsIn("@[[aaaaaaaaaaaa|Ada]] and @[[Sam Okafor]] and @[[gggggggggggg|Grace]] @[[gggggggggggg]] @[[Lin Wei]] @[[zzzzzzzzzzzz|Gone]]");
    expect(newlyMentioned(before, now, PEOPLE.members)).toEqual([GRACE]);
    expect(newlyMentioned(now, now, PEOPLE.members)).toEqual([]);
  });
});

describe("a contact's form", () => {
  const sam = { sourceId: "s", id: "sam", name: "Sam Okafor", emails: [], phones: ["+1 555 0142"], organization: "Okafor Plumbing", url: null, title: "Owner", addresses: ["12 Water Lane"], birthday: "--04-21", notes: "Prefers a text", photo: null, urls: ["https://okafor.example"], etag: "3" };

  it("changes nothing when nothing is changed, and only what differs when something is", () => {
    expect(changeOf(sam, draftOf(sam))).toEqual({ change: {} });
    const draft = { ...draftOf(sam), emails: ["  sam@okafor.example ", ""], title: " ", birthday: { day: "21", month: "4", year: "1988" }, notes: "Prefers a text\n" };
    expect(changeOf(sam, draft)).toEqual({ change: { emails: ["sam@okafor.example"], title: null, birthday: "1988-04-21" } });
  });

  it("says why a draft can't be saved: no name, half a birthday, a day the month doesn't have", () => {
    expect(changeOf(sam, { ...draftOf(sam), name: "  " })).toEqual({ problem: "A contact needs a name" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "21", month: "", year: "" } })).toEqual({ problem: "A birthday needs its day and its month" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "29", month: "2", year: "2023" } })).toEqual({ problem: "February 2023 has no day 29" });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "29", month: "2", year: "" } })).toEqual({ change: { birthday: "--02-29" } });
    expect(changeOf(sam, { ...draftOf(sam), birthday: { day: "", month: "", year: "" } })).toEqual({ change: { birthday: null } });
  });
});
