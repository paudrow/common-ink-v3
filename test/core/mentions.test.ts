import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import { addMember, newMember } from "./members.ts";

type Listing = Omit<Extract<OpInput, { type: "todo.list" }>, "type">;

const create = (as: Actor, text: string, more: Partial<Extract<OpInput, { type: "note.create" }>> = {}) => perform(env.DB, as, { type: "note.create", text, ...more });
const read = (as: Actor, id: string) => perform(env.DB, as, { type: "note.read", id });
const todos = async (as: Actor, filters: Listing = {}) => (await perform(env.DB, as, { type: "todo.list", ...filters })).todos;
const codeOf = async (run: Promise<unknown>) => run.then(() => "done", (err) => (err instanceof OpError ? `${err.code}: ${err.message}` : Promise.reject(err)));
const agentOf = async (member: Actor): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, "Claude")).agent.id, personId: member.personId, workspaceId: member.workspaceId });

/** Someone who isn't a member, let in to one note. */
async function guestOn(owner: Actor, noteId: string, access: "view" | "edit" = "view"): Promise<Actor> {
  const email = `${crypto.randomUUID()}@example.com`;
  await perform(env.DB, owner, { type: "grant.set", noteId, email, access });
  const { personId } = await signIn(env.DB, { email, name: "Gus Guest" });
  return { kind: "member", personId, workspaceId: owner.workspaceId };
}

async function indexed(noteId: string) {
  const { results } = await env.DB.prepare("SELECT line, who, name FROM mentions WHERE note_id = ? ORDER BY line, rowid").bind(noteId).all<Record<string, unknown>>();
  return results.map((r) => Object.values(r));
}

describe("a mention a write introduces", () => {
  it("is stored by the member's id with their name, whether it was written by name or by id, and an agent's is too", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(await agentOf(ada), `# Plan\n\nAsk @[[grace hopper]] and @[[${ada.personId}]] and @[[Sam Okafor]].`);

    expect(note.text).toBe(`# Plan\n\nAsk @[[${grace.personId}|Grace Hopper]] and @[[${ada.personId}|Ada Lovelace]] and @[[Sam Okafor]].`);
    expect((await read(ada, note.id)).mentions).toEqual([
      { id: grace.personId, name: "Grace Hopper", member: true },
      { id: ada.personId, name: "Ada Lovelace", member: true },
      { id: null, name: "Sam Okafor", member: false },
    ]);
  });

  it("is refused when several members have the name, with the ids to choose from", async () => {
    const ada = await newMember("Ada Lovelace");
    const one = await addMember(ada, "editor", "Sam Okafor");
    const two = await addMember(ada, "viewer", "sam okafor");
    const ids = [one.personId, two.personId].sort().join(", ");

    expect(await codeOf(create(ada, "# Plan\n\n@[[Sam Okafor]]"))).toBe(`invalid: 2 members are named "Sam Okafor": ${ids}. Mention the one you mean as @[[id]], with ids from member.list.`);
    expect((await create(ada, "# Plan\n\n@[[Sam Okafor]]", { mentionNames: "keep" })).text).toBe("# Plan\n\n@[[Sam Okafor]]");
    expect((await create(ada, `# Plan\n\n@[[${two.personId}]]`)).text).toBe(`# Plan\n\n@[[${two.personId}|sam okafor]]`);
  });

  it("leaves every mention the note already had exactly as written, and a name the writer chose", async () => {
    const ada = await newMember("Ada Lovelace");
    const kept = `# Plan\n\n@[[Grace Hopper]] and @[[${ada.personId}|The Countess]]`;
    const note = await create(ada, kept, { mentionNames: "keep" });
    const grace = await addMember(ada, "editor", "Grace Hopper");

    const next = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: `${kept}\n\nand again @[[Grace Hopper]] with @[[Ada Lovelace|A.L.]]` });
    expect(next.text).toBe(`${kept}\n\nand again @[[Grace Hopper]] with @[[${ada.personId}|A.L.]]`);
    expect((await read(ada, note.id)).mentions).toEqual([
      { id: null, name: "Grace Hopper", member: false },
      { id: ada.personId, name: "Ada Lovelace", member: true },
    ]);
    expect(grace.personId).not.toBe(ada.personId);
  });

  it("tells a guest who writes one nothing of who is a member: the name stays a name", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Shared");
    const gus = await guestOn(ada, note.id, "edit");

    const written = await perform(env.DB, gus, { type: "note.write", id: note.id, baseRevision: note.revision, text: `# Shared\n\n@[[Grace Hopper]] @[[${grace.personId}]]` });
    expect(written.text).toBe(`# Shared\n\n@[[Grace Hopper]] @[[${grace.personId}]]`);
    expect((await read(gus, note.id)).mentions).toEqual([
      { id: null, name: "Grace Hopper", member: false },
      { id: grace.personId, name: grace.personId, member: false },
    ]);
  });
});

describe("who a mention is shown as", () => {
  it("follows a member through a rename, and is the name as written once they are no longer a member", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Plan\n\n@[[Grace Hopper]]");
    await env.DB.prepare("UPDATE people SET name = 'Grace B. Hopper' WHERE id = ?").bind(grace.personId).run();

    expect((await read(ada, note.id)).text).toBe(`# Plan\n\n@[[${grace.personId}|Grace Hopper]]`);
    expect((await read(ada, note.id)).mentions).toEqual([{ id: grace.personId, name: "Grace B. Hopper", member: true }]);

    await perform(env.DB, ada, { type: "member.remove", memberId: grace.personId });
    expect((await read(ada, note.id)).mentions).toEqual([{ id: grace.personId, name: "Grace Hopper", member: false }]);
  });

  it("is only the name as written to a guest, who is not told a member's name now", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Plan\n\n- [ ] ship @[[Grace Hopper]]");
    await env.DB.prepare("UPDATE people SET name = 'Rear Admiral Hopper' WHERE id = ?").bind(grace.personId).run();
    const gus = await guestOn(ada, note.id);

    const said = JSON.stringify([await read(gus, note.id), await todos(gus), await perform(env.DB, gus, { type: "todo.filters" })]);
    expect(said).toContain("Grace Hopper");
    expect(said).not.toContain("Rear Admiral");
    expect((await todos(gus))[0]!.assignees).toEqual([{ id: grace.personId, name: "Grace Hopper", member: false }]);
    expect((await todos(ada))[0]!.assignees).toEqual([{ id: grace.personId, name: "Rear Admiral Hopper", member: true }]);
  });

  it("gives nobody access: a mentioned member still can't see a private note, and a mentioned name is nobody", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Mine\n\n- [ ] ask @[[Grace Hopper]] and @[[Sam Okafor]]");
    await perform(env.DB, ada, { type: "note.setPrivate", id: note.id, private: true });
    const sam = await signIn(env.DB, { email: `${crypto.randomUUID()}@example.com`, name: "Sam Okafor" });

    expect(await codeOf(read(grace, note.id))).toBe("not_found: No such note");
    expect(await todos(grace, { assignedToMe: true })).toEqual([]);
    expect((await perform(env.DB, grace, { type: "todo.filters" })).assignees).toEqual([]);
    expect(await codeOf(read({ kind: "member", personId: sam.personId, workspaceId: ada.workspaceId }, note.id))).toBe("not_found: No such workspace");
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: note.id })).grants).toEqual([]);
  });
});

describe("the index of mentions", () => {
  it("holds who each line mentions, through every write, and is made for a note written before there was one", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await create(ada, `# Plan\n\n@[[Sam Okafor]]\n- [ ] call @[[Ada Lovelace]] @[[sam okafor]]\n\`@[[Code]]\``);
    expect(await indexed(note.id)).toEqual([
      [2, "sam okafor", "Sam Okafor"],
      [3, ada.personId, "Ada Lovelace"],
      [3, "sam okafor", "sam okafor"],
    ]);

    const next = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "# Plan\n\n- [ ] call @[[Ada Lovelace]]" });
    expect(await indexed(note.id)).toEqual([[2, ada.personId, "Ada Lovelace"]]);
    await perform(env.DB, ada, { type: "note.undo", id: note.id });
    expect((await indexed(note.id)).length).toBe(3);

    // As a note is that was last indexed before mentions were: nothing of it, and marked as made to the level before.
    await env.DB.batch([env.DB.prepare("DELETE FROM mentions WHERE note_id = ?").bind(note.id), env.DB.prepare("UPDATE notes SET indexed = 3 WHERE id = ?").bind(note.id)]);
    expect((await todos(ada, { assignedToMe: true })).map((t) => t.words)).toEqual(["call"]);
    expect((await indexed(note.id)).length).toBe(3);
    expect(next.revision).toBe(2);
  });
});

describe("a todo's assignees", () => {
  async function team() {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Plan\n\n- [ ] one @[[Grace Hopper]]\n- [ ] two @[[Ada Lovelace]] @[[Sam Okafor]]\n- [ ] three @[[sam okafor]]\n- [ ] four\n\nNot a todo: @[[Zed Zimmer]]");
    return { ada, grace, note };
  }

  it("are listed with each todo, and narrow the list by a member, by a name, and to the asker's own", async () => {
    const { ada, grace } = await team();
    const words = async (as: Actor, filters: Listing) => (await todos(as, filters)).map((t) => t.words);

    expect((await todos(ada)).map((t) => t.assignees.map((a) => a.name))).toEqual([["Grace Hopper"], ["Ada Lovelace", "Sam Okafor"], ["sam okafor"], []]);
    expect(await words(ada, { assignee: grace.personId })).toEqual(["one"]);
    expect(await words(ada, { assignee: "SAM OKAFOR" })).toEqual(["two", "three"]);
    expect(await words(ada, { assignedToMe: true })).toEqual(["two"]);
    expect(await words(grace, { assignedToMe: true })).toEqual(["one"]);
    expect(await words(await agentOf(grace), { assignedToMe: true })).toEqual(["one"]);
    expect(await words(ada, { assignedToMe: true, assignee: "Sam Okafor" })).toEqual(["two"]);
    expect(await words(ada, { assignee: "Zed Zimmer" })).toEqual([]);
  });

  it("are what the list can be narrowed by: members first, then names, and only those on todos", async () => {
    const { ada, grace } = await team();
    expect((await perform(env.DB, ada, { type: "todo.filters" })).assignees).toEqual([
      { id: ada.personId, name: "Ada Lovelace", member: true },
      { id: grace.personId, name: "Grace Hopper", member: true },
      { id: null, name: "Sam Okafor", member: false },
    ]);
  });

  it("are set by todo.set: a member by id or by name, anyone else by name, and taken away the same", async () => {
    const { ada, grace, note } = await team();
    const set = async (change: Partial<Extract<OpInput, { type: "todo.set" }>>) => {
      const now = await read(ada, note.id);
      const todo = (await todos(ada, { noteId: note.id })).find((t) => t.words === "four")!;
      return (await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: now.revision, line: todo.line, text: todo.text, ...change })).text.split("\n")[todo.line];
    };

    expect(await set({ assign: "grace hopper" })).toBe(`- [ ] four @[[${grace.personId}|Grace Hopper]]`);
    expect(await set({ assign: grace.personId })).toBe(`- [ ] four @[[${grace.personId}|Grace Hopper]]`);
    expect(await set({ assign: "Sam Okafor" })).toBe(`- [ ] four @[[${grace.personId}|Grace Hopper]] @[[Sam Okafor]]`);
    expect(await set({ unassign: grace.personId })).toBe("- [ ] four @[[Sam Okafor]]");
    expect(await set({ unassign: "sam okafor", assign: ada.personId })).toBe(`- [ ] four @[[${ada.personId}|Ada Lovelace]]`);
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 5, text: "- [ ] four", assign: "a]]b" }))).toMatch(/^invalid: /);
  });

  it("are set by their id by a guest with the name the note already calls them, which is all the guest was told", async () => {
    const { ada, grace, note } = await team();
    const gus = await guestOn(ada, note.id, "edit");
    const stored = await read(ada, note.id);
    const four = (await todos(gus, { noteId: note.id })).find((t) => t.words === "four")!;
    const set = await perform(env.DB, gus, { type: "todo.set", id: note.id, revision: stored.revision, line: four.line, text: four.text, assign: grace.personId });
    expect(set.text.split("\n")[four.line]).toBe(`- [ ] four @[[${grace.personId}|Grace Hopper]]`);
    expect((await todos(gus, { noteId: note.id })).find((t) => t.words === "four")!.assignees).toEqual([{ id: grace.personId, name: "Grace Hopper", member: false }]);
    const after = await read(ada, note.id);
    const again = await perform(env.DB, gus, { type: "todo.set", id: note.id, revision: after.revision, line: four.line, text: set.text.split("\n")[four.line]!, assign: ada.personId });
    expect(again.text.split("\n")[four.line]).toBe(`- [ ] four @[[${grace.personId}|Grace Hopper]] @[[${ada.personId}|Ada Lovelace]]`);
    // An id the note calls nothing is written as it was given: there is no name to be had without being told who is a member.
    const lone = await create(ada, "# Lone\n\n- [ ] five");
    const gusToo = await guestOn(ada, lone.id, "edit");
    expect((await perform(env.DB, gusToo, { type: "todo.set", id: lone.id, revision: lone.revision, line: 2, text: "- [ ] five", assign: grace.personId })).text).toBe(`# Lone\n\n- [ ] five @[[${grace.personId}]]`);
  });

  it("are taken away by name as they are by id, a member's too, and an unassign that names nobody on the line is refused", async () => {
    const { ada, grace, note } = await team();
    const line = async (words: string) => (await todos(ada, { noteId: note.id, includeCompleted: true })).find((t) => t.words === words)!;
    const set = async (words: string, change: Partial<Extract<OpInput, { type: "todo.set" }>>) => {
      const [now, todo] = [await read(ada, note.id), await line(words)];
      return perform(env.DB, ada, { type: "todo.set", id: note.id, revision: now.revision, line: todo.line, text: todo.text, ...change });
    };

    await set("one", { unassign: "grace hopper" });
    expect((await line("one")).text).toBe("- [ ] one");
    await set("two", { unassign: ada.personId });
    expect((await line("two")).text).toBe("- [ ] two @[[Sam Okafor]]");
    // A member written by name alone and the same member by id are both who the name means.
    await set("four", { assign: grace.personId });
    const both = await read(ada, note.id);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: both.revision, text: both.text.replace("- [ ] four", "- [ ] four @[[Grace Hopper]]"), mentionNames: "keep" });
    await set("four", { unassign: "Grace Hopper" });
    expect((await line("four")).text).toBe("- [ ] four");

    expect(await codeOf(set("four", { unassign: "Grace Hopper" }))).toBe('invalid: This todo isn\'t assigned to "Grace Hopper"');
    expect(await codeOf(set("three", { unassign: grace.personId }))).toBe(`invalid: This todo isn't assigned to "${grace.personId}"`);
    // The same call sent again finds it done, as any todo.set does.
    const before = await read(ada, note.id);
    const three = await line("three");
    for (let i = 0; i < 2; i++) await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: before.revision, line: three.line, text: three.text, unassign: "Sam Okafor" });
    expect((await line("three")).text).toBe("- [ ] three");
  });

  it("refuses a name that is nothing to read: only characters that don't show", async () => {
    const { ada, note } = await team();
    for (const name of ["\u200b", "\u202e\u200d", " \u2066 "]) {
      expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 5, text: "- [ ] four", assign: name })), JSON.stringify(name)).toMatch(/^invalid: /);
      expect(await codeOf(todos(ada, { assignee: name })), JSON.stringify(name)).toMatch(/^invalid: /);
    }
    const assigned = await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 5, text: "- [ ] four", assign: "\u202eSam\u200b Okafor" });
    expect(assigned.text.split("\n")[5]).toBe("- [ ] four @[[Sam Okafor]]");
  });

  it("ride onto the line a recurring todo files, and are withheld with its words where the daily note is seen by more people", async () => {
    const ada = await newMember("Ada Lovelace");
    const open = await create(ada, "# Open\n\n- [ ] water @[[Sam Okafor]] every:1d");
    const secret = await create(ada, "# Secret\n\n- [ ] confide @[[Sam Okafor]] every:1d");
    await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });
    await perform(env.DB, ada, { type: "settings.write", text: JSON.stringify({ "daily.private": false }), baseRevision: 0 });

    for (const note of [open, secret]) await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 2, text: note.text.split("\n")[2]!, done: true, on: "2026-10-11" });
    const daily = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
    expect(daily.text).toContain(`- [x] water @[[Sam Okafor]] [[${open.id}]]`);
    expect(daily.text).toContain(`- [x] [[${secret.id}]]`);
    expect(daily.text).not.toContain("confide");
    expect(daily.text.match(/Sam Okafor/g)).toHaveLength(1);
  });
});

describe("sharing with a member by naming them", () => {
  it("lets the owner of a private note let a member in without their email, and doesn't tell it to them", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const grace = await addMember(ada, "viewer", "Grace Hopper");
    const note = await create(eve, "# Mine\n\n@[[Grace Hopper]]");
    await perform(env.DB, eve, { type: "note.setPrivate", id: note.id, private: true });

    const grant = await perform(env.DB, eve, { type: "grant.set", noteId: note.id, memberId: grace.personId, access: "view" });
    expect(grant.to).toEqual({ kind: "person", email: null, personId: grace.personId, name: "Grace Hopper", role: "viewer" });
    expect((await read(grace, note.id)).title).toBe("Mine");
    expect(JSON.stringify(await perform(env.DB, eve, { type: "grant.list", noteId: note.id }))).not.toContain("@example.com");
  });

  it("is refused for someone who isn't a member here, for both ways at once, and for neither", async () => {
    const ada = await newMember("Ada Lovelace");
    const stranger = await newMember("Stranger");
    const note = await create(ada, "# Note");

    expect(await codeOf(perform(env.DB, ada, { type: "grant.set", noteId: note.id, memberId: stranger.personId, access: "view" }))).toBe("not_found: No such member");
    expect(await codeOf(perform(env.DB, ada, { type: "grant.set", noteId: note.id, memberId: stranger.personId, email: "a@example.com", access: "view" }))).toMatch(/^invalid: Name who/);
    expect(await codeOf(perform(env.DB, ada, { type: "grant.set", noteId: note.id, access: "view" }))).toMatch(/^invalid: Name who/);
  });

  it("is an admin's alone where it would narrow a member, as a grant by email is", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(eve, "# Ours");

    expect(await codeOf(perform(env.DB, eve, { type: "grant.set", noteId: note.id, memberId: grace.personId, access: "view" }))).toMatch(/^forbidden: Only an admin can change what this person can see here/);
  });
});

describe("what a mention leaves elsewhere", () => {
  it("is found by search and read in a snippet as the name it was written with", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await create(ada, "# Plan\n\nLunch with @[[Grace Hopper]] and @[[Sam Okafor]]");

    expect(note.snippet).toBe("Lunch with @Grace Hopper and @Sam Okafor");
    expect((await perform(env.DB, ada, { type: "search", query: "okafor" })).results.map((r) => r.note.id)).toEqual([note.id]);
    expect(await perform(env.DB, ada, { type: "note.backlinks", id: note.id })).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM links WHERE source_id = ?").bind(note.id).first<{ n: number }>())!.n).toBe(0);
    expect(grace.personId).toHaveLength(12);
  });

  it("leaves a link after an @ that starts no mention a link, with its backlink", async () => {
    const ada = await newMember("Ada Lovelace");
    const target = await create(ada, "# Target");
    const note = await create(ada, `# Mail\n\nmail@[[${target.id}]] and x@[[Target]]`);

    expect(note.text).toBe(`# Mail\n\nmail@[[${target.id}]] and x@[[${target.id}]]`);
    expect((await read(ada, note.id)).links).toEqual([{ id: target.id, title: "Target", state: "live" }]);
    expect((await read(ada, note.id)).mentions).toEqual([]);
    expect((await perform(env.DB, ada, { type: "note.backlinks", id: target.id })).map((n) => n.id)).toEqual([note.id]);
  });
});
