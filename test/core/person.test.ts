import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { ContactCard, OpInput, PersonPage } from "../../src/core/protocol.ts";
import type { ContactsSource, Sources } from "../../src/core/sources.ts";
import { addMember, newMember } from "./members.ts";

const card = (id: string, name: string, more: Partial<ContactCard> = {}): ContactCard => ({ sourceId: "people", id, name, emails: [], phones: [], organization: null, url: null, title: null, addresses: [], birthday: null, notes: null, photo: null, urls: [], etag: "1", ...more });

/** Each person's contacts, held in memory, and whose were read. */
function contactsOf(byPerson: Map<string, ContactCard[]>) {
  const read: string[] = [];
  const sources: Sources = {
    async of(personId) {
      const mine = byPerson.get(personId) ?? [];
      const people: ContactsSource = {
        kind: "contacts",
        info: { id: "people", name: "Test contacts", provider: "Test", state: "connected", account: `${personId}@test` },
        list: async () => (read.push(personId), { contacts: mine.map(({ sourceId, id, name, emails, phones, organization, url }) => ({ sourceId, id, name, emails, phones, organization, url })), more: false }),
        get: async (id) => mine.find((c) => c.id === id) ?? null,
      };
      return [people];
    },
    connect: async () => ({ redirect: null }),
    disconnect: async () => {},
    ending: async () => async () => {},
  };
  return { sources, read };
}

const agentOf = async (member: Actor, folderIds?: string[]): Promise<Actor> => ({
  kind: "agent",
  agentId: (await connectAgent(env.DB, member.personId, "Claude", folderIds && { workspaceId: member.workspaceId, folderIds })).agent.id,
  personId: member.personId,
  workspaceId: member.workspaceId,
  ...(folderIds && { scope: { folderIds } }),
});

/** Ada, an admin, and Grace and Bob, editors, each with contacts of their own; notes in two folders, and one of Ada's private. */
async function world() {
  const ada = await newMember("Ada Lovelace");
  const grace = await addMember(ada, "editor", "Grace Hopper");
  const bob = await addMember(ada, "editor", "Bob Byte");
  const members = await perform(env.DB, ada, { type: "member.list" });
  const graceEmail = members.find((m) => m.personId === grace.personId)!.email!;
  const byPerson = new Map<string, ContactCard[]>([
    [ada.personId, [card("ada-sam", "Sam Okafor", { phones: [{ value: "+1 555 0142", type: null }], title: "Plumber-of-ada", addresses: [{ value: "Ada-lane", type: null }], birthday: "--04-21", notes: "ada-note-on-sam", urls: [{ value: "https://okafor.example", type: null }] }), card("ada-g", "G. Hopper", { emails: [{ value: graceEmail.toUpperCase(), type: null }], notes: "ada-note-on-grace" })]],
    [grace.personId, [card("grace-sam", "sam okafor", { phones: [{ value: "+44 20 grace-number", type: null }] })]],
    // Bob has Grace's address under another name: who it is, he isn't told.
    [bob.personId, [card("bob-g", "Totally Unrelated", { emails: [{ value: graceEmail, type: null }] })]],
  ]);
  const { sources, read } = contactsOf(byPerson);
  const inside = await perform(env.DB, ada, { type: "folder.create", name: "Inside" });
  const outside = await perform(env.DB, ada, { type: "folder.create", name: "Outside" });
  const shared = await perform(env.DB, ada, { type: "note.create", folderId: inside.id, text: `# Boiler\n\n- [ ] Fix the boiler @[[Sam Okafor]]\n\nAsk @[[Grace Hopper]] how it went.` });
  const secret = await perform(env.DB, ada, { type: "note.create", folderId: inside.id, text: `# Secret\n\nsecret-line about @[[Sam Okafor]]` });
  await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });
  const far = await perform(env.DB, ada, { type: "note.create", folderId: outside.id, text: `# Far\n\noutside-line with @[[Sam Okafor]] and @[[${grace.personId}]]` });
  const page = (as: Actor, who: string) => perform(env.DB, as, { type: "person.read", who } satisfies OpInput, Date.now(), sources);
  return { ada, grace, bob, graceEmail, inside, outside, shared, secret, far, page, read };
}

const said = (page: PersonPage) => JSON.stringify(page);
const notesOf = (page: PersonPage) => page.mentionedIn.map((m) => m.noteTitle);

describe("a person's page", () => {
  it("shows the asker their own contact with all it holds, the open todos assigned to them, and each line that mentions them, latest note first", async () => {
    const w = await world();
    const sam = await w.page(w.ada, "Sam Okafor");
    expect(sam).toMatchObject({ who: "Sam Okafor", name: "Sam Okafor", member: null, more: false, query: 'mentions:"Sam Okafor"' });
    expect(sam.contacts).toEqual([card("ada-sam", "Sam Okafor", { phones: [{ value: "+1 555 0142", type: null }], title: "Plumber-of-ada", addresses: [{ value: "Ada-lane", type: null }], birthday: "--04-21", notes: "ada-note-on-sam", urls: [{ value: "https://okafor.example", type: null }] })]);
    expect(sam.todos.map((t) => t.words)).toEqual(["Fix the boiler"]);
    expect(sam.mentionedIn.map((m) => [m.noteTitle, m.line, m.text])).toEqual([
      ["Far", 2, `outside-line with @Sam Okafor and @Grace Hopper`],
      ["Secret", 2, "secret-line about @Sam Okafor"],
      ["Boiler", 2, "Fix the boiler @Sam Okafor"],
    ]);
    // Its query finds the same notes from search.
    const found = await perform(env.DB, w.ada, { type: "search", query: sam.query, limit: 50 });
    expect(found.results.map((r) => r.note.title).sort()).toEqual(["Boiler", "Far", "Secret"]);
  });

  it("never shows one member's contact to another member or to the other member's agent, and leaves out the notes the asker can't see and their lines", async () => {
    const w = await world();
    for (const asker of [w.grace, await agentOf(w.grace)]) {
      const sam = await w.page(asker, "Sam Okafor");
      expect(sam.contacts.map((c) => [c.id, c.phones])).toEqual([["grace-sam", [{ value: "+44 20 grace-number", type: null }]]]);
      expect(notesOf(sam)).toEqual(["Far", "Boiler"]);
      expect(said(sam)).not.toMatch(/ada-|Plumber-of-ada|secret-line|Secret/);
    }
    const bobs = await w.page(w.bob, "Sam Okafor");
    expect(bobs.contacts).toEqual([]);
    expect(said(bobs)).not.toMatch(/ada-|grace-number|secret-line/);
    // Ada's own agent is shown Ada's contact, as list_contacts shows it.
    expect((await w.page(await agentOf(w.ada), "Sam Okafor")).contacts.map((c) => c.id)).toEqual(["ada-sam"]);
  });

  it("is a member's card for a member: by id or by their one name, their email only as member.list tells it, and an asker's contact with the member's email joined to it for that asker alone", async () => {
    const w = await world();
    const byAda = await w.page(w.ada, w.grace.personId);
    expect(byAda.member).toMatchObject({ personId: w.grace.personId, name: "Grace Hopper", role: "editor", email: w.graceEmail });
    expect(byAda).toMatchObject({ who: w.grace.personId, name: "Grace Hopper", query: 'mentions:"Grace Hopper"' });
    expect(byAda.contacts.map((c) => [c.id, c.notes])).toEqual([["ada-g", "ada-note-on-grace"]]);
    // The mention by name was stored by her id, so both notes are hers.
    expect(notesOf(byAda)).toEqual(["Far", "Boiler"]);
    expect(await w.page(w.ada, "grace hopper")).toEqual(byAda);

    const byBob = await w.page(w.bob, "Grace Hopper");
    expect(byBob.member).toEqual({ personId: w.grace.personId, name: "Grace Hopper", role: "editor" });
    expect(byBob.contacts).toEqual([]);
    expect(said(byBob)).not.toContain(w.graceEmail);
    expect(said(byBob)).not.toContain("ada-note-on-grace");
    for (const asker of [w.bob, await agentOf(w.bob)]) expect((await w.page(asker, w.grace.personId)).contacts).toEqual([]);
  });

  it("holds the mentions written by name before someone joined, as the search its page makes finds them", async () => {
    const w = await world();
    const early = await perform(env.DB, w.ada, { type: "note.create", text: "# Early\n\n- [ ] Welcome pack @[[Newt Joiner]]\n\nBefore @[[Newt Joiner]] joins." });
    const newt = await addMember(w.ada, "editor", "Newt Joiner");
    const byId = await w.page(w.ada, newt.personId);
    expect(byId).toMatchObject({ who: newt.personId, member: { personId: newt.personId }, query: 'mentions:"Newt Joiner"' });
    expect(byId.mentionedIn.map((m) => m.text)).toEqual(["Welcome pack @Newt Joiner", "Before @Newt Joiner joins."]);
    expect(byId.todos.map((t) => t.words)).toEqual(["Welcome pack"]);
    const found = await perform(env.DB, w.ada, { type: "search", query: byId.query, limit: 50 });
    expect(found.results.map((r) => r.note.id)).toEqual([early.id]);
  });

  it("tells an agent limited to folders no member and no contact, and only the lines in its folders, without asking a data source", async () => {
    const w = await world();
    const limited = await agentOf(w.ada, [w.inside.id]);
    const before = w.read.length;
    const grace = await w.page(limited, w.grace.personId);
    expect(grace).toMatchObject({ who: w.grace.personId, member: null, contacts: [] });
    expect(notesOf(grace)).toEqual(["Boiler"]);
    const sam = await w.page(limited, "Sam Okafor");
    expect(sam.contacts).toEqual([]);
    expect(notesOf(sam)).toEqual(["Secret", "Boiler"]);
    expect(said(sam) + said(grace)).not.toMatch(/outside-line|Far|ada-|Plumber|@example\.com/);
    expect(w.read.length).toBe(before);
  });

  it("tells a guest only what the note they were let into says: the name as written, and none of the members or anyone's contacts", async () => {
    const w = await world();
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, w.ada, { type: "grant.set", noteId: w.shared.id, email, access: "view" });
    const { personId } = await signIn(env.DB, { email, name: "Gus Guest" });
    const gus: Actor = { kind: "member", personId, workspaceId: w.ada.workspaceId };
    const grace = await w.page(gus, w.grace.personId);
    expect(grace).toMatchObject({ who: w.grace.personId, name: "Grace Hopper", member: null, contacts: [] });
    expect(grace.mentionedIn.map((m) => [m.noteTitle, m.text])).toEqual([["Boiler", "Ask @Grace Hopper how it went."]]);
    const byName = await w.page(gus, "Grace Hopper");
    expect(byName).toMatchObject({ who: "Grace Hopper", member: null, mentionedIn: [] });
    expect(said(grace) + said(byName)).not.toMatch(/@example\.com|ada-|outside-line|secret-line/);
  });

  it("is only the name for someone who is neither a member nor one of the asker's contacts", async () => {
    const w = await world();
    expect(await w.page(w.bob, "The landlord")).toEqual({ who: "The landlord", name: "The landlord", member: null, contacts: [], todos: [], mentionedIn: [], more: false, query: 'mentions:"The landlord"', todoQuery: 'assignee:"The landlord"' });
  });
});
