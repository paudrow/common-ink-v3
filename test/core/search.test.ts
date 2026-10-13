import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import { matchOf, matchesIn, parseQuery } from "../../src/core/search.ts";
import { whoAmI } from "../../src/core/accounts.ts";
import { addMember, newMember } from "./members.ts";

const create = (by: Actor, text: string, now?: number) => perform(env.DB, by, { type: "note.create", text }, now);
const found = async (by: Actor, query: string, more: Omit<Partial<Extract<OpInput, { type: "search" }>>, "type" | "query"> = {}) => (await perform(env.DB, by, { type: "search", query, ...more })).results.map((r) => r.note.title);

describe("a search as typed", () => {
  it("reads words, quoted phrases, tags and projects, and nothing else", () => {
    expect(parseQuery('budget "second quarter" #Money +Home')).toEqual({ terms: [["budget"], ["second", "quarter"]], tags: ["money"], projects: ["home"] });
    expect(parseQuery("foo-bar it's C++ a#b")).toEqual({ terms: [["foo", "bar"], ["it", "s"], ["C"], ["a", "b"]], tags: [], projects: [] });
    expect(parseQuery('"left open')).toEqual({ terms: [["left"], ["open"]], tags: [], projects: [] });
    expect(parseQuery('  "" # + * ( ) : ^ -  ')).toEqual({ terms: [], tags: [], projects: [] });
  });

  it("asks the index for quoted strings alone, whatever was typed", () => {
    const asked = (typed: string) => matchOf("abc123def456", parseQuery(typed).terms).replace('workspace : "abc123def456" AND {title text} : (', "").slice(0, -1);
    expect(matchOf('x" OR "y', [["a"]])).toBe('workspace : "xy" AND {title text} : ("a"*)');
    expect(asked('budget "second quarter"')).toBe('"budget"* "second quarter"*');
    expect(asked('a" OR "b NEAR(c) title:d NOT e* {x} ^f')).toBe('"a"* "OR"* "b"* "NEAR c"* "title d"* "NOT"* "e"* "x"* "f"*');
  });

  it("marks where each match is in a line, and cuts a long line around the first", () => {
    const query = parseQuery('milk "second quarter" #money +home');
    expect(matchesIn("# Budget\n\nBuy Milk and milkshakes\nthe second  quarter\n- [ ] pay +Home #money\nnothing", query)).toEqual([
      { line: 2, text: "Buy Milk and milkshakes", marks: [[4, 8], [13, 17]] },
      { line: 3, text: "the second  quarter", marks: [[4, 19]] },
      { line: 4, text: "- [ ] pay +Home #money", marks: [[10, 15], [16, 22]] },
    ]);
    const [long] = matchesIn(`${"x ".repeat(300)}milk ${"y ".repeat(300)}`, query);
    expect(long!.text).toHaveLength(200);
    expect(long!.text.slice(long!.marks[0]![0], long!.marks[0]![1])).toBe("milk");
  });
});

describe("search", () => {
  it("finds notes by words of their text, of a todo, of a tag and of a project, and by #tag and +project", async () => {
    const ada = await newMember();
    await create(ada, "# Budget\n\nThe second quarter was fine.\n\n- [ ] Call the bank +Finances #money");
    await create(ada, "# Recipes\n\nA quarter cup of milk, second to none.");

    expect(await found(ada, "quarter")).toEqual(["Recipes", "Budget"]);
    expect(await found(ada, "bank call")).toEqual(["Budget"]);
    expect(await found(ada, "money")).toEqual(["Budget"]);
    expect(await found(ada, "finances")).toEqual(["Budget"]);
    expect(await found(ada, "#money")).toEqual(["Budget"]);
    expect(await found(ada, "+finances")).toEqual(["Budget"]);
    expect(await found(ada, "quarter #money")).toEqual(["Budget"]);
    expect(await found(ada, "#money +nothing")).toEqual([]);
    expect(await found(ada, '"second quarter"')).toEqual(["Budget"]);
    expect(await found(ada, "quart mil")).toEqual(["Recipes"]);
    expect(await found(ada, "uarter")).toEqual([]);
    expect(await found(ada, "")).toEqual([]);
  });

  it("ignores case and accents, and answers each note with the lines that matched", async () => {
    const ada = await newMember();
    await create(ada, "# Café\n\nMeet at the CAFÉ on Main");

    expect(await found(ada, "cafe")).toEqual(["Café"]);
    const { results } = await perform(env.DB, ada, { type: "search", query: "MAIN meet" });
    expect(results).toMatchObject([{ note: { title: "Café", state: "live", access: "edit" }, matches: [{ line: 2, text: "Meet at the CAFÉ on Main", marks: [[0, 4], [20, 24]] }] }]);
  });

  it("puts notes whose title matches first, then the latest changed", async () => {
    const ada = await newMember();
    await create(ada, "# Plan for the garden\n\nbeds", 1000);
    await create(ada, "# Shopping\n\nfor the garden plan", 2000);
    await create(ada, "# Garden\n\nno p-word here, only a plan in the text", 3000);
    await create(ada, "# The plan\n\ngarden", 4000);

    expect(await found(ada, "plan")).toEqual(["The plan", "Plan for the garden", "Garden", "Shopping"]);
    expect(await found(ada, "garden plan")).toEqual(["Plan for the garden", "The plan", "Garden", "Shopping"]);
  });

  it("narrows to one folder's own notes, and a folder the asker can't see is no such folder", async () => {
    const ada = await newMember();
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
    const inside = await perform(env.DB, ada, { type: "folder.create", name: "Inside", parentId: projects.id });
    const inFolder = (folderId: string, text: string, now: number) => perform(env.DB, ada, { type: "note.create", folderId, text }, now);
    await create(ada, "# Loose heron\n\nheron", 1000);
    await inFolder(projects.id, "# Project heron\n\nheron #bird", 2000);
    const secret = await inFolder(projects.id, "# Secret heron\n\nheron heron", 3000);
    await inFolder(inside.id, "# Inner heron\n\nheron", 4000);
    await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });
    const eve = await addMember(ada, "editor", "Eve");

    expect(await found(ada, "heron")).toEqual(["Inner heron", "Secret heron", "Project heron", "Loose heron"]);
    expect(await found(ada, "heron", { folderId: projects.id })).toEqual(["Secret heron", "Project heron"]);
    expect(await found(ada, "#bird", { folderId: projects.id })).toEqual(["Project heron"]);
    expect(await found(ada, "#bird", { folderId: inside.id })).toEqual([]);
    // Someone who can't see a note in the folder is told nothing of it: not in the results, and not in whether there are more.
    expect(await perform(env.DB, eve, { type: "search", query: "heron", folderId: projects.id, limit: 1 })).toMatchObject({ results: [{ note: { title: "Project heron" } }], next: null });

    const guest = await newMember("Gus");
    const shared = await perform(env.DB, ada, { type: "note.create", folderId: inside.id, text: "# Shared heron\n\nheron" }, 5000);
    await perform(env.DB, ada, { type: "grant.set", noteId: shared.id, email: (await whoAmI(env.DB, guest.personId)).person.email, access: "view" });
    const asGuest: Actor = { ...guest, workspaceId: ada.workspaceId };
    expect(await found(asGuest, "heron")).toEqual(["Shared heron"]);
    // The note was shared and its folder wasn't, so to the guest there is no such folder, whatever is asked of it.
    for (const query of ["heron", ""]) await expect(perform(env.DB, asGuest, { type: "search", query, folderId: inside.id })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    await expect(perform(env.DB, ada, { type: "search", query: "heron", folderId: "nosuchfolder" })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
  });

  it("answers in the order asked for, narrows to notes with an open todo, and to archived notes alone", async () => {
    const ada = await newMember();
    await create(ada, "# Beta\n\nfinch\n- [ ] feed", 1000);
    const alpha = await create(ada, "# alpha\n\nfinch", 2000);
    await create(ada, "# Finch\n\nbirds\n- [x] done", 3000);
    const old = await create(ada, "# Old\n\nfinch\n- [ ] count", 4000);
    await perform(env.DB, ada, { type: "note.write", id: alpha.id, baseRevision: 1, text: "# alpha\n\nfinch again" }, 9000);
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true }, 9500);

    expect(await found(ada, "finch")).toEqual(["Finch", "alpha", "Beta"]);
    expect(await found(ada, "finch", { sort: "match" })).toEqual(["Finch", "alpha", "Beta"]);
    expect(await found(ada, "finch", { sort: "recent" })).toEqual(["alpha", "Finch", "Beta"]);
    expect(await found(ada, "finch", { sort: "created" })).toEqual(["Finch", "alpha", "Beta"]);
    expect(await found(ada, "finch", { sort: "title" })).toEqual(["alpha", "Beta", "Finch"]);
    expect(await found(ada, "finch", { sort: "title", includeArchived: true })).toEqual(["alpha", "Beta", "Finch", "Old"]);
    expect(await found(ada, "finch", { includeArchived: "only" })).toEqual(["Old"]);
    expect(await found(ada, "finch", { hasTodos: true })).toEqual(["Beta"]);
    expect(await found(ada, "finch", { hasTodos: true, includeArchived: true, sort: "created" })).toEqual(["Old", "Beta"]);
    // Pages follow the order asked for.
    const first = await perform(env.DB, ada, { type: "search", query: "finch", sort: "title", limit: 2 });
    expect(first.results.map((r) => r.note.title)).toEqual(["alpha", "Beta"]);
    expect((await perform(env.DB, ada, { type: "search", query: "finch", sort: "title", limit: 2, offset: first.next! })).results.map((r) => r.note.title)).toEqual(["Finch"]);

    expect((await perform(env.DB, ada, { type: "note.list", includeArchived: "only" })).map((n) => n.title)).toEqual(["Old"]);
    expect((await perform(env.DB, ada, { type: "note.list", includeArchived: true })).map((n) => n.title)).toEqual(["alpha", "Old", "Finch", "Beta"]);
    expect((await perform(env.DB, ada, { type: "note.list" })).map((n) => n.title)).toEqual(["alpha", "Finch", "Beta"]);
  });

  it("is never thrown by what is typed", async () => {
    const ada = await newMember();
    await create(ada, "# Note\n\nAND OR NOT NEAR title");
    for (const query of ['"', '""', "*", "a*", "(", "a AND", "NEAR(a b)", "title:x", "{title}: a", "^a", "a OR", '"a" OR "', "-a", "a:b", "#", "+", "#a#b", "\u0000", "'; DROP TABLE notes; --"]) {
      await expect(perform(env.DB, ada, { type: "search", query }), query).resolves.toBeDefined();
    }
    expect(await found(ada, "a AND")).toEqual(["Note"]);
    expect(await found(ada, "nothing OR note")).toEqual([]);
  });

  it("says nothing of a note the asker can't see: not in the results, their order, or how many there are", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const titled = (n: number) => `# Quarterly ${String(n).padStart(2, "0")}`;
    for (let i = 0; i < 3; i++) await create(ada, `${titled(i)}\n\nreport`, 1000 + i);
    const before = await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2 });

    for (let i = 0; i < 30; i++) {
      const secret = await create(eve, `# Quarterly report ${i}\n\nquarterly report quarterly report #hidden`, 5000 + i);
      await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
    }

    expect(await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2 })).toEqual(before);
    expect(before.results.map((r) => r.note.title)).toEqual(["Quarterly 02", "Quarterly 01"]);
    expect(before.next).toBe(2);
    expect((await perform(env.DB, ada, { type: "search", query: "quarterly report", limit: 2, offset: 2 })).results.map((r) => r.note.title)).toEqual(["Quarterly 00"]);
    expect(await found(ada, "#hidden")).toEqual([]);
    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([]);
    expect((await perform(env.DB, eve, { type: "search", query: "#hidden", limit: 50 })).results).toHaveLength(30);
    expect((await perform(env.DB, eve, { type: "tag.list" })).tags).toEqual([{ name: "hidden", notes: 30 }]);
  });

  it("follows a note as its text changes, and finds notes written before there was anything to search", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Draft\n\nabout herons");
    expect(await found(ada, "herons")).toEqual(["Draft"]);

    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Draft\n\nabout egrets" });
    expect(await found(ada, "herons")).toEqual([]);
    expect(await found(ada, "egrets")).toEqual(["Draft"]);

    // As a note is that was last written before this was deployed: indexed for links and todos, and not for search.
    await env.DB.batch([env.DB.prepare("DELETE FROM note_search"), env.DB.prepare("DELETE FROM note_search_rows"), env.DB.prepare("UPDATE notes SET indexed = 1")]);
    expect(await found(ada, "egrets")).toEqual(["Draft"]);
    await perform(env.DB, ada, { type: "links.rebuild" });
    expect(await found(ada, "egrets")).toEqual(["Draft"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM note_search WHERE note_search MATCH 'egrets'").first()).toEqual({ n: 1 });
  });

  it("finds nothing of another workspace's notes, whose words and whose workspace id it is asked for", async () => {
    const ada = await newMember();
    const bob = await newMember("Bob");
    await create(bob, `# Bob's herons\n\n${ada.workspaceId} herons`);
    await create(ada, "# Ada's herons\n\nherons");

    expect(await found(ada, "herons")).toEqual(["Ada's herons"]);
    expect(await found(ada, ada.workspaceId)).toEqual([]);
    expect(await found(ada, bob.workspaceId)).toEqual([]);
    expect(await found(bob, "herons")).toEqual(["Bob's herons"]);
  });

  it("says so while a large workspace is still being read into the index, and reads more each time it is asked", async () => {
    const ada = await newMember();
    for (let i = 0; i < 310; i++) await create(ada, `# Note ${i}\n\nherons #bird`);
    await env.DB.batch([env.DB.prepare("DELETE FROM note_search"), env.DB.prepare("DELETE FROM note_tags"), env.DB.prepare("UPDATE notes SET indexed = 1")]);
    const search = () => perform(env.DB, ada, { type: "search", query: "herons", limit: 1 });

    expect(await search()).toMatchObject({ indexing: true });
    expect(await perform(env.DB, ada, { type: "tag.list" })).toEqual({ tags: [{ name: "bird", notes: 310 }], indexing: false });
    expect(await search()).toMatchObject({ indexing: false, next: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM note_search").first()).toEqual({ n: 310 });
  });

  it("lists the notes under a tag, ignoring case, and counts each tag once a note", async () => {
    const ada = await newMember();
    await create(ada, "# One\n\n#Money and #money again\n- [ ] pay #bills");
    await create(ada, "# Two\n\n#money");

    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([{ name: "bills", notes: 1 }, { name: "Money", notes: 2 }]);
    expect((await perform(env.DB, ada, { type: "note.list", tag: "MONEY" })).map((n) => n.title).sort()).toEqual(["One", "Two"]);
    expect((await perform(env.DB, ada, { type: "note.list", tag: "bills" })).map((n) => n.title)).toEqual(["One"]);
    expect(await perform(env.DB, ada, { type: "note.list", tag: "none" })).toEqual([]);
  });
});

describe("search, tags and Trash, asked by someone who sees part of the workspace", () => {
  const NO_NOTE = { code: "not_found", message: "No such note" };
  const NO_WORKSPACE = { code: "not_found", message: "No such workspace" };
  const MISSING = "zzzzzzzzzzzz";
  const said = async (by: Actor, op: OpInput) => JSON.stringify(await perform(env.DB, by, op));
  const asked = async (by: Actor | Visitor, op: OpInput): Promise<object> => perform(env.DB, by, op).then((answer) => ({ answer }), (err: { code: string; message: string }) => ({ code: err.code, message: err.message }));
  const everything = (): OpInput[] => [
    { type: "search", query: "commonword", includeArchived: true, limit: 50 },
    { type: "search", query: "commonword", includeArchived: "only", limit: 50 },
    { type: "search", query: "#sharedtag +Sharedproject", includeArchived: true, limit: 50 },
    { type: "tag.list", includeArchived: true },
    { type: "trash.list" },
    { type: "note.list", includeArchived: true },
    { type: "note.list", tag: "sharedtag", includeArchived: true },
    { type: "todo.filters", includeArchived: true },
  ];
  /** A workspace with a note in each state that everyone in it sees, and the same three private to Eve, sharing a word, a tag and a project. */
  async function world() {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const text = (title: string, words: string) => `# ${title}\n\ncommonword ${words} #sharedtag\n\n- [ ] do it +Sharedproject`;
    const open = { live: await create(ada, text("Open live", "open-words")), archived: await create(ada, text("Open archived", "open-words")), trashed: await create(ada, text("Open trashed", "open-words")) };
    const hidden = { live: await create(eve, text("Hidden-live", "hidden-words #hiddentag")), archived: await create(eve, text("Hidden-archived", "hidden-words #hiddentag")), trashed: await create(eve, text("Hidden-trashed", "hidden-words #hiddentag")) };
    for (const note of Object.values(hidden)) await perform(env.DB, eve, { type: "note.setPrivate", id: note.id, private: true });
    for (const [by, notes] of [[ada, open], [eve, hidden]] as const) {
      await perform(env.DB, by, { type: "note.archive", id: notes.archived.id, archived: true });
      await perform(env.DB, by, { type: "note.trash", id: notes.trashed.id });
    }
    const marks = ["Hidden-live", "Hidden-archived", "Hidden-trashed", "hidden-words", "hiddentag", "Eve Editor", ...Object.values(hidden).map((n) => n.id)];
    const states = async () => (await env.DB.prepare("SELECT id, state, revision, folder_id FROM notes WHERE workspace_id = ? ORDER BY id").bind(ada.workspaceId).all()).results;
    return { ada, eve, open, hidden, marks, states };
  }
  /** Every listing as `by` is answered it, which must be word for word what they are answered once the hidden notes are gone for good. */
  const answers = async (by: Actor) => Promise.all(everything().map((op) => said(by, op)));

  it("answers a viewer with every note but the private ones, as if those were never written, and lets them archive, trash and restore nothing", async () => {
    const w = await world();
    const vera = await addMember(w.ada, "viewer", "Vera Viewer");
    const told = await answers(vera);
    for (const mark of w.marks) expect(told.filter((text) => text.includes(mark)), mark).toEqual([]);
    expect((await perform(env.DB, vera, { type: "search", query: "commonword", includeArchived: true, limit: 50 })).results.map((r) => r.note.title).sort()).toEqual(["Open archived", "Open live"]);
    expect((await perform(env.DB, vera, { type: "tag.list", includeArchived: true })).tags).toEqual([{ name: "sharedtag", notes: 2 }]);
    expect((await perform(env.DB, vera, { type: "trash.list" })).map((n) => n.title)).toEqual(["Open trashed"]);
    for (const query of ["hidden-words", "Hidden-live", "#hiddentag"]) expect(await said(vera, { type: "search", query, includeArchived: true })).toBe(await said(vera, { type: "search", query: "nosuchwordanywhere", includeArchived: true }));

    const before = await w.states();
    for (const id of [...Object.values(w.hidden).map((n) => n.id), MISSING]) {
      for (const op of [{ type: "note.archive", id, archived: true }, { type: "note.archive", id, archived: false }, { type: "note.trash", id }, { type: "note.restore", id }, { type: "note.purge", id }, { type: "note.read", id }] as OpInput[]) {
        await expect(perform(env.DB, vera, op), `${op.type} ${id}`).rejects.toMatchObject(op.type === "note.read" ? NO_NOTE : { code: "forbidden", message: `A viewer can't ${op.type}` });
      }
    }
    // What she can read she still can't archive, trash, restore or remove.
    for (const id of Object.values(w.open).map((n) => n.id)) {
      for (const op of [{ type: "note.archive", id, archived: true }, { type: "note.trash", id }, { type: "note.restore", id }, { type: "note.purge", id }] as OpInput[]) await expect(perform(env.DB, vera, op)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await w.states()).toEqual(before);

    // The private notes removed for good change no answer of hers.
    for (const note of Object.values(w.hidden)) {
      await perform(env.DB, w.eve, { type: "note.trash", id: note.id });
      await perform(env.DB, w.eve, { type: "note.purge", id: note.id });
    }
    expect((await w.states()).length).toBe(before.length - 3);
    expect(await answers(vera)).toEqual(told);
  });

  it("answers a guest with the notes shared with them alone, in each state, and a guest who may only read restores nothing", async () => {
    const w = await world();
    const reader = { email: `${crypto.randomUUID()}@example.com` };
    const writer = { email: `${crypto.randomUUID()}@example.com` };
    const { signIn } = await import("../../src/core/accounts.ts");
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email: reader.email, name: "Gus Guest" })).personId, workspaceId: w.ada.workspaceId };
    const gwen: Actor = { kind: "member", personId: (await signIn(env.DB, { email: writer.email, name: "Gwen Guest" })).personId, workspaceId: w.ada.workspaceId };
    const extra = await create(w.ada, "# Unshared-open\n\ncommonword unshared-words #sharedtag #unsharedtag");
    for (const note of Object.values(w.open)) {
      await perform(env.DB, w.ada, { type: "grant.set", noteId: note.id, email: reader.email, access: "view" });
      await perform(env.DB, w.ada, { type: "grant.set", noteId: note.id, email: writer.email, access: "edit" });
    }
    const marks = [...w.marks, "Unshared-open", "unshared-words", "unsharedtag", extra.id];
    for (const guest of [gus, gwen]) {
      const told = await answers(guest);
      for (const mark of marks) expect(told.filter((text) => text.includes(mark)), mark).toEqual([]);
      expect((await perform(env.DB, guest, { type: "search", query: "commonword", includeArchived: true, limit: 50 })).results.map((r) => r.note.title).sort()).toEqual(["Open archived", "Open live"]);
      expect((await perform(env.DB, guest, { type: "search", query: "commonword", limit: 1 })).next).toBeNull();
      expect((await perform(env.DB, guest, { type: "tag.list", includeArchived: true })).tags).toEqual([{ name: "sharedtag", notes: 2 }]);
      expect((await perform(env.DB, guest, { type: "trash.list" })).map((n) => n.title)).toEqual(["Open trashed"]);
      // A note they weren't given is answered as one that was never there. One who may only read is told a guest can't, whatever the note.
      for (const id of [extra.id, w.hidden.trashed.id, w.hidden.live.id]) {
        for (const op of [{ type: "note.archive", id, archived: true }, { type: "note.trash", id }, { type: "note.restore", id }, { type: "note.read", id }] as OpInput[]) {
          const refused = await asked(guest, op);
          expect(refused, `${op.type} ${id}`).toEqual(await asked(guest, { ...op, id: MISSING } as OpInput));
          expect(refused).toEqual(guest === gwen || op.type === "note.read" ? NO_NOTE : { code: "forbidden", message: `A guest can't ${op.type}` });
        }
      }
    }
    const before = await w.states();
    for (const op of [{ type: "note.archive", id: w.open.live.id, archived: true }, { type: "note.trash", id: w.open.live.id }, { type: "note.restore", id: w.open.trashed.id }] as OpInput[]) {
      await expect(perform(env.DB, gus, op), op.type).rejects.toMatchObject({ code: "forbidden", message: `A guest can't ${op.type}` });
    }
    expect(await w.states()).toEqual(before);
    // Removing a note for good is never a guest's, whatever they were given.
    await expect(perform(env.DB, gwen, { type: "note.purge", id: w.open.trashed.id })).rejects.toMatchObject({ code: "forbidden" });
    expect(await perform(env.DB, gwen, { type: "note.restore", id: w.open.trashed.id })).toMatchObject({ state: "live" });
  });

  it("answers someone who lost their access as it answers a stranger: a note made private, a grant taken back, a member removed", async () => {
    const w = await world();
    const ed = await addMember(w.ada, "editor", "Ed Editor");
    const mine = await create(w.eve, "# Soon-hidden\n\ncommonword soon-hidden-words #sharedtag #soontag");
    await perform(env.DB, w.eve, { type: "note.trash", id: mine.id });
    expect((await perform(env.DB, ed, { type: "trash.list" })).map((n) => n.title).sort()).toEqual(["Open trashed", "Soon-hidden"]);
    await perform(env.DB, w.eve, { type: "note.restore", id: mine.id });
    expect(await found(ed, "soon-hidden-words")).toEqual(["Soon-hidden"]);

    // Eve makes it private: to Ed it is now a note that was never there, live or in Trash.
    await perform(env.DB, w.eve, { type: "note.setPrivate", id: mine.id, private: true });
    const never = await said(ed, { type: "search", query: "nosuchwordanywhere", includeArchived: true });
    for (const state of ["live", "archived", "trashed"] as const) {
      if (state === "archived") await perform(env.DB, w.eve, { type: "note.archive", id: mine.id, archived: true });
      if (state === "trashed") await perform(env.DB, w.eve, { type: "note.trash", id: mine.id });
      for (const query of ["soon-hidden-words", "Soon-hidden", "#soontag"]) expect(await said(ed, { type: "search", query, includeArchived: true }), `${state} ${query}`).toBe(never);
      const told = await answers(ed);
      for (const mark of [...w.marks, "Soon-hidden", "soon-hidden-words", "soontag", mine.id]) expect(told.filter((text) => text.includes(mark)), `${state} ${mark}`).toEqual([]);
      for (const op of [{ type: "note.archive", id: mine.id, archived: false }, { type: "note.trash", id: mine.id }, { type: "note.restore", id: mine.id }, { type: "note.purge", id: mine.id }] as OpInput[]) {
        await expect(perform(env.DB, ed, op), `${state} ${op.type}`).rejects.toMatchObject(NO_NOTE);
        await expect(perform(env.DB, ed, { ...op, id: MISSING } as OpInput)).rejects.toMatchObject(NO_NOTE);
      }
    }

    // A guest whose grant is taken back, and a member who is removed, are in no workspace at all.
    const email = `${crypto.randomUUID()}@example.com`;
    const { signIn } = await import("../../src/core/accounts.ts");
    const gus: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: w.ada.workspaceId };
    const grant = await perform(env.DB, w.ada, { type: "grant.set", noteId: w.open.trashed.id, email, access: "edit" });
    expect((await perform(env.DB, gus, { type: "trash.list" })).map((n) => n.title)).toEqual(["Open trashed"]);
    await perform(env.DB, w.ada, { type: "grant.revoke", id: grant.id });
    await perform(env.DB, w.ada, { type: "member.remove", memberId: ed.personId });
    for (const lost of [gus, ed]) {
      for (const op of [...everything(), { type: "note.restore", id: w.open.trashed.id }, { type: "note.archive", id: w.open.live.id, archived: true }, { type: "note.trash", id: w.open.live.id }, { type: "note.purge", id: w.open.trashed.id }] as OpInput[]) {
        await expect(perform(env.DB, lost, op), op.type).rejects.toMatchObject(NO_WORKSPACE);
      }
    }
  });

  it("answers whoever holds a link with the linked note alone: no search, no tags, no Trash, and nothing of the note once it is in Trash", async () => {
    const w = await world();
    const link = await perform(env.DB, w.ada, { type: "grant.link", noteId: w.open.live.id, link: "public" });
    const visitor: Visitor = { kind: "visitor", token: link!.to.kind === "link" ? link!.to.token : "", personId: null };
    const nobody: Visitor = { kind: "visitor", token: "x".repeat(43), personId: null };
    const ops = [...everything(), { type: "note.archive", id: w.open.live.id, archived: true }, { type: "note.trash", id: w.open.live.id }, { type: "note.restore", id: w.open.trashed.id }, { type: "note.purge", id: w.open.trashed.id }] as OpInput[];
    for (const op of ops) expect(await asked(visitor, op), op.type).toEqual({ code: "forbidden", message: `A link can't ${op.type}` });
    expect(await perform(env.DB, visitor, { type: "shared.read", id: w.open.live.id })).toMatchObject({ title: "Open live" });
    for (const id of [w.open.archived.id, w.open.trashed.id, w.hidden.live.id, MISSING]) await expect(perform(env.DB, visitor, { type: "shared.read", id }), id).rejects.toMatchObject({ code: "not_found" });
    await perform(env.DB, w.ada, { type: "note.trash", id: w.open.live.id });
    expect(await asked(visitor, { type: "shared.open" })).toEqual(await asked(nobody, { type: "shared.open" }));
    expect(await asked(visitor, { type: "shared.read", id: w.open.live.id })).toEqual(await asked(nobody, { type: "shared.read", id: w.open.live.id }));
  });
});
