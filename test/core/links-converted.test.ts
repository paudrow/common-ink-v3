import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

const REF = "r1r1r1r1r1r1";
const convert = (as: Actor, after?: string) => perform(env.DB, as, { type: "note.convertLinks", ...(after && { after }) });
const read = async (as: Actor, id: string) => (await perform(env.DB, as, { type: "note.read", id })).text;
const waiting = async (id: string) => (await env.DB.prepare("SELECT links_converted FROM notes WHERE id = ?").bind(id).first<{ links_converted: number }>())!.links_converted === 0;

/** A note as one written before people and events were links is: its text kept as written, and marked as the migration marks it. */
async function before(as: Actor, text: string) {
  const note = await perform(env.DB, as, { type: "note.create", text, mentionNames: "keep", linkTitles: "keep" });
  await env.DB.prepare("UPDATE notes SET links_converted = 0 WHERE id = ?").bind(note.id).run();
  return note;
}

describe("converting the notes written before people and events were links", () => {
  it("writes each as links once, as a change of the member's labeled for what it did, which put back is converted again", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const old = `# Plan\n\n- [ ] Book it @[[${grace.personId}|Grace Hopper]] with @[[Sam Okafor]]\n\nAsk @[[${ada.personId}|the Countess]] at ::event{${REF} Lunch with Sam}.\n\n\`@[[Code]]\``;
    const note = await before(ada, old);
    expect((await perform(env.DB, ada, { type: "todo.list", assignee: grace.personId })).todos).toEqual([]);

    expect(await convert(ada)).toEqual({ converted: [{ id: note.id, revision: 2 }], next: null });
    expect(await read(ada, note.id)).toBe(
      `# Plan\n\n- [ ] Book it [[person:${grace.personId}]] with [[person:Sam Okafor]]\n\nAsk [[person:${ada.personId}|the Countess]] at [[event:${REF}]].\n\n\`@[[Code]]\``,
    );
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).at(-1)).toMatchObject({ revision: 2, label: "Links converted", author: { kind: "member", personId: ada.personId } });
    // Read as people again: assigned, mentioned, and a reference to the event.
    expect((await perform(env.DB, ada, { type: "todo.list", assignee: grace.personId })).todos.map((t) => t.words)).toEqual(["Book it with"]);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).mentions.map((m) => m.name)).toEqual(["Grace Hopper", "Sam Okafor", "Ada Lovelace"]);

    expect(await convert(ada)).toEqual({ converted: [], next: null });
    await perform(env.DB, ada, { type: "note.revert", id: note.id, revision: 1 });
    expect(await read(ada, note.id)).toBe(old);
    // Put back, it holds the old forms again, which are converted the next time a member comes in.
    expect(await waiting(note.id)).toBe(true);
    expect((await convert(ada)).converted).toEqual([{ id: note.id, revision: 4 }]);
    expect(await read(ada, note.id)).toContain(`[[person:${grace.personId}]]`);
  });

  it("converts an old form written since, as an app or an agent from before writes one, and leaves the note alone otherwise", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan\n\nAsk [[person:Sam]]" });
    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "# Plan\n\nAsk [[person:Sam]] and `@[[Code]]`" });
    expect(await waiting(note.id)).toBe(false);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: written.revision, text: "# Plan\n\nAsk [[person:Sam]] and @[[Lin Wei]] at ::event{r1r1r1r1r1r1 Lunch}" });
    expect(await waiting(note.id)).toBe(true);
    await convert(ada);
    expect(await read(ada, note.id)).toBe("# Plan\n\nAsk [[person:Sam]] and [[person:Lin Wei]] at [[event:r1r1r1r1r1r1]]");
    expect(await waiting(note.id)).toBe(false);
  });

  it("leaves a note in Trash until it is back", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await before(ada, "# Gone\n\n@[[Sam]]");
    await perform(env.DB, ada, { type: "note.trash", id: note.id });
    expect(await convert(ada)).toEqual({ converted: [], next: null });
    expect(await waiting(note.id)).toBe(true);
    await perform(env.DB, ada, { type: "note.restore", id: note.id });
    expect((await convert(ada)).converted.map((c) => c.id)).toEqual([note.id]);
  });

  it("keeps the name of someone who is no longer a member as the words the link shows", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await before(ada, `# Team\n\n@[[${grace.personId}|Grace Hopper]] and @[[${ada.personId}|Ada Lovelace]]`);
    await perform(env.DB, ada, { type: "member.remove", memberId: grace.personId });

    await convert(ada);
    expect(await read(ada, note.id)).toBe(`# Team\n\n[[person:${grace.personId}|Grace Hopper]] and [[person:${ada.personId}]]`);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).mentions).toEqual([
      { id: grace.personId, name: "A former member", member: false },
      { id: ada.personId, name: "Ada Lovelace", member: true },
    ]);
  });

  it("leaves a note for someone who may change it: a viewer converts nothing, and the owner of a private note converts it", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const shared = await before(ada, "# Shared\n\n@[[Sam]]");
    const hers = await before(eve, "# Hers\n\n@[[Sam]]");
    await perform(env.DB, eve, { type: "note.setPrivate", id: hers.id, private: true });

    expect(await convert(vera)).toEqual({ converted: [], next: null });
    expect([await waiting(shared.id), await waiting(hers.id)]).toEqual([true, true]);
    expect((await convert(ada)).converted.map((c) => c.id)).toEqual([shared.id]);
    expect(await waiting(hers.id)).toBe(true);
    expect((await convert(eve)).converted.map((c) => c.id)).toEqual([hers.id]);
    expect(await read(eve, hers.id)).toBe("# Hers\n\n[[person:Sam]]");
  });

  it("is the member's own app's to ask: an agent and a guest are refused", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await before(ada, "# Shared\n\n@[[Sam]]");
    const agent: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email, access: "edit" });
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };

    await expect(convert(agent)).rejects.toMatchObject({ code: "forbidden" });
    await expect(convert(gus)).rejects.toMatchObject({ code: "forbidden" });
    expect(await waiting(note.id)).toBe(true);
  });

  it("goes a batch at a time, carrying on from where the last stopped", async () => {
    const ada = await newMember("Ada Lovelace");
    const notes = [];
    for (let i = 0; i < 27; i++) notes.push(await before(ada, `# Note ${i}\n\n@[[Sam]]`));
    const first = await convert(ada);
    expect(first.converted).toHaveLength(25);
    expect(first.next).toBe(first.converted.at(-1)!.id);
    const rest = await convert(ada, first.next!);
    expect(rest).toEqual({ converted: expect.any(Array), next: null });
    expect([...first.converted, ...rest.converted].map((c) => c.id).sort()).toEqual(notes.map((n) => n.id).sort());
  });

  it("marks a note that holds nothing to convert outside code, and converts a note made since with an old form", async () => {
    const ada = await newMember("Ada Lovelace");
    const coded = await before(ada, "# Code\n\n`@[[Sam]]` and\n```\n::event{r1r1r1r1r1r1 Lunch}\n```");
    const made = await perform(env.DB, ada, { type: "note.create", text: "# New\n\nmail me@[[Sam]] or ask @[[Sam]]", linkTitles: "keep", mentionNames: "keep" });
    const plain = await perform(env.DB, ada, { type: "note.create", text: "# Plain\n\nmail me@[[Sam]]", linkTitles: "keep" });
    expect([await waiting(made.id), await waiting(plain.id)]).toEqual([true, false]);
    expect((await convert(ada)).converted.map((c) => c.id)).toEqual([made.id]);
    expect([await waiting(coded.id), await waiting(made.id)]).toEqual([false, false]);
    expect(await read(ada, made.id)).toBe("# New\n\nmail me@[[Sam]] or ask [[person:Sam]]");
  });
});
