import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, type Actor } from "../../src/core/operations.ts";
import { noteIdFromPath, notePath } from "../../src/core/slug.ts";
import { newMember } from "./members.ts";

const create = (actor: Actor, text: string) => perform(env.DB, actor, { type: "note.create", text });
const titles = async (actor: Actor) => (await perform(env.DB, actor, { type: "note.list" })).map((n) => n.title).sort();

/** Puts the notes back as an older build left them: the title that build stored, and not yet made by today's rule. */
const asStoredBefore = (id: string, title: string) => env.DB.prepare("UPDATE notes SET title = ?, snippet = 'old snippet', indexed = 5 WHERE id = ?").bind(title, id).run();

describe("a note with no # heading", () => {
  it("is titled by its first words in the note, the list, its address, and search", async () => {
    const ada = await newMember();
    const note = await create(ada, "Shopping for **the week**\n\n- milk");

    expect(note).toMatchObject({ title: "Shopping for the week", slug: "shopping-for-the-week", snippet: "milk" });
    expect(await titles(ada)).toEqual(["Shopping for the week"]);
    expect(noteIdFromPath(notePath(note))).toBe(note.id);
    expect((await perform(env.DB, ada, { type: "search", query: "shopping", limit: 5 })).results.map((r) => r.note.title)).toEqual(["Shopping for the week"]);
  });

  it("is still found at the address it had under an older title, which names it by id", async () => {
    const ada = await newMember();
    const note = await create(ada, "First thoughts");
    const before = notePath(note);
    const after = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nFirst thoughts" });

    expect(notePath(after)).not.toBe(before);
    expect(noteIdFromPath(before)).toBe(note.id);
  });

  it("can be linked by that title, and two notes that start alike are still told apart by id", async () => {
    const ada = await newMember();
    const shopping = await create(ada, "Shopping list\n\n- milk");

    expect((await create(ada, "See [[shopping list]]")).text).toBe(`See [[${shopping.id}]]`);

    await create(ada, "Shopping list\n\n- nails");
    expect((await create(ada, "And [[Shopping list]]")).unresolved).toEqual([{ target: "Shopping list", matches: [expect.any(String), expect.any(String)] }]);
  });
});

describe("a title stored by an older rule", () => {
  it("is made again by today's rule the next time notes are listed, with nothing asked of anyone", async () => {
    const ada = await newMember();
    const plain = await create(ada, "Shopping list\n\n- milk");
    const marked = await create(ada, `# **Trip** to [[${plain.id}|Oslo]]\n\nPack`);
    await asStoredBefore(plain.id, "");
    await asStoredBefore(marked.id, `**Trip** to [[${plain.id}|Oslo]]`);

    // Read before any list: the note says its title by today's rule already.
    expect((await perform(env.DB, ada, { type: "note.read", id: plain.id })).title).toBe("Shopping list");

    expect(await titles(ada)).toEqual(["Shopping list", "Trip to Oslo"]);
    expect(await env.DB.prepare("SELECT title, snippet, indexed FROM notes WHERE id = ?").bind(marked.id).first()).toEqual({ title: "Trip to Oslo", snippet: "Pack", indexed: 7 });
    expect((await perform(env.DB, ada, { type: "search", query: "trip", limit: 5 })).results.map((r) => r.note.title)).toEqual(["Trip to Oslo"]);
  });

  it("is made again before a link by title is looked up", async () => {
    const ada = await newMember();
    const plain = await create(ada, "Shopping list\n\n- milk");
    await asStoredBefore(plain.id, "");

    expect((await create(ada, "See [[Shopping list]]")).text).toBe(`See [[${plain.id}]]`);
  });

  it("is read by today's rule wherever a note is listed, before it has been made again: past what one listing mends", async () => {
    const ada = await newMember();
    const notes = [];
    for (let i = 0; i < 320; i++) notes.push(await create(ada, `Plain note ${String(i).padStart(3, "0")}\n\nbody`));
    await env.DB.prepare("UPDATE notes SET title = '', snippet = 'old snippet', indexed = 5 WHERE workspace_id = ?").bind(ada.workspaceId).run();

    const listed = await perform(env.DB, ada, { type: "note.list" });
    expect(listed.map((n) => n.title).sort()).toEqual(notes.map((n) => n.title).sort());
    expect(listed.every((n) => n.snippet === "body")).toBe(true);
    // Not all of them are stored yet: the rest were read from their text.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE workspace_id = ? AND indexed < 7").bind(ada.workspaceId).first<{ n: number }>())!.n).toBeGreaterThan(0);
    await perform(env.DB, ada, { type: "note.list" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE workspace_id = ? AND (indexed < 7 OR title = '')").bind(ada.workspaceId).first()).toEqual({ n: 0 });
  });

  it("is written by today's rule by the next change to the note, whatever the change", async () => {
    const ada = await newMember();
    const note = await create(ada, "Shopping list\n\n- milk");
    await asStoredBefore(note.id, "");

    const archived = await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: true });
    expect(archived.title).toBe("Shopping list");
    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "Shopping list\n\n- milk\n- eggs" });
    expect(written).toMatchObject({ title: "Shopping list", snippet: "milk eggs" });
  });

  it("uses the index kept for notes still to be made", async () => {
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id, revision, text FROM notes WHERE workspace_id = ? AND indexed < 7 LIMIT 16").bind("w").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("notes_to_index");
  });
});
