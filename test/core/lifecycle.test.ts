import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { IN_TRASH, TRASH_MS } from "../../src/core/lifecycle.ts";
import { perform, type Actor, type Visitor } from "../../src/core/operations.ts";
import type { OpInput } from "../../src/core/protocol.ts";
import { UPLOAD_IN_TRASH } from "../../src/core/uploads.ts";
import { addMember, newMember } from "./members.ts";
import { upload } from "./uploading.ts";
import { walk } from "./walking.ts";

const create = (by: Actor, text: string, folderId?: string, now?: number) => perform(env.DB, by, { type: "note.create", text, folderId }, now);
const titles = async (by: Actor, op: OpInput) => ((await perform(env.DB, by, op)) as { notes: { title: string }[] }).notes.map((n) => n.title).sort();
const agentOf = async (member: Actor, name = "Claude"): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, name)).agent.id, personId: member.personId, workspaceId: member.workspaceId });
const guest = async (ada: Actor, noteId: string, access: "view" | "edit"): Promise<Actor> => {
  const email = `${crypto.randomUUID()}@example.com`;
  await perform(env.DB, ada, { type: "grant.set", noteId, email, access });
  return { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
};

/** `env.DB`, where `first` runs just before the statement that archives or unarchives: as if someone did it in the moment between the read and the write. */
const racing = (first: () => Promise<unknown>): D1Database =>
  new Proxy(env.DB, {
    get(db, key) {
      const value = Reflect.get(db, key, db);
      if (key !== "prepare") return typeof value === "function" ? value.bind(db) : value;
      return (sql: string) => {
        const statement = db.prepare(sql);
        if (!/^UPDATE \w+ SET state = \?2,/.test(sql)) return statement;
        return { bind: (...args: unknown[]) => ({ run: async () => (await first(), statement.bind(...args).run()) }) };
      };
    },
  });

describe("archive", () => {
  it("refuses a note or an upload trashed in the moment since it was read, and doesn't say it archived it", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Plan");
    const file = await upload(ada, "plan.png");

    await expect(perform(racing(() => perform(env.DB, ada, { type: "note.trash", id: note.id })), ada, { type: "note.archive", id: note.id, archived: true })).rejects.toMatchObject({ code: "conflict", message: IN_TRASH });
    await expect(perform(racing(() => perform(env.DB, ada, { type: "upload.trash", id: file.id })), ada, { type: "upload.archive", id: file.id, archived: true })).rejects.toMatchObject({ code: "conflict", message: UPLOAD_IN_TRASH });
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes.map((n) => [n.title, n.state])).toEqual([["Plan", "trashed"]]);
    expect((await perform(env.DB, ada, { type: "upload.trashed" })).map((u) => [u.name, u.state])).toEqual([["plan.png", "trashed"]]);
  });

  it("is one operation each way, keeps the note's folder and id, and needs edit", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer");
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const note = await create(ada, "# Old plan", folder.id);

    await expect(perform(env.DB, vera, { type: "note.archive", id: note.id, archived: true })).rejects.toMatchObject({ code: "forbidden" });
    const archived = await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: true });
    expect(archived).toMatchObject({ id: note.id, folderId: folder.id, state: "archived", purgesAt: null });
    expect(await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: true })).toMatchObject({ state: "archived" });

    const back = await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: false });
    expect(back).toMatchObject({ id: note.id, folderId: folder.id, state: "live" });
    expect(await titles(ada, { type: "note.list" })).toEqual(["Old plan"]);
  });

  it("leaves the note out of the note list, a folder's count, todos, their filters, tags and search, unless archived notes are asked for", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    await create(ada, "# Current\n\n- [ ] ship #now", folder.id);
    const old = await create(ada, "# Old plan\n\n- [ ] ponder #later", folder.id);
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });

    expect(await titles(ada, { type: "note.list" })).toEqual(["Current"]);
    expect(await titles(ada, { type: "note.list", folderId: folder.id })).toEqual(["Current"]);
    expect(await titles(ada, { type: "note.list", includeArchived: true })).toEqual(["Current", "Old plan"]);
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.find((f) => f.id === folder.id)!.noteCount).toBe(1);
    expect((await perform(env.DB, ada, { type: "todo.list" })).todos.map((t) => t.noteTitle)).toEqual(["Current"]);
    expect((await perform(env.DB, ada, { type: "todo.list", includeArchived: true })).todos.map((t) => t.noteTitle).sort()).toEqual(["Current", "Old plan"]);
    expect(await perform(env.DB, ada, { type: "todo.filters" })).toEqual({ tags: ["now"], assignees: [] });
    expect(await perform(env.DB, ada, { type: "todo.filters", includeArchived: true })).toEqual({ tags: ["later", "now"], assignees: [] });
    expect((await perform(env.DB, ada, { type: "tag.list" })).tags).toEqual([{ name: "now", notes: 1 }]);
    expect((await perform(env.DB, ada, { type: "tag.list", includeArchived: true })).tags).toEqual([{ name: "later", notes: 1 }, { name: "now", notes: 1 }]);
    expect((await perform(env.DB, ada, { type: "search", query: "ponder" })).results).toEqual([]);
    expect((await perform(env.DB, ada, { type: "search", query: "ponder", includeArchived: true })).results.map((r) => r.note.title)).toEqual(["Old plan"]);
  });

  it("still opens from a link, which names it and says it is archived, and is still what links to the notes it links", async () => {
    const ada = await newMember();
    const old = await create(ada, "# Old plan");
    const target = await create(ada, "# Target");
    await perform(env.DB, ada, { type: "note.write", id: old.id, baseRevision: 1, text: `# Old plan\n\n[[${target.id}]]` });
    const linker = await create(ada, `# Linker\n\n[[${old.id}]]`);
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });

    expect((await perform(env.DB, ada, { type: "note.read", id: linker.id })).links).toEqual([{ id: old.id, title: "Old plan", state: "archived" }]);
    expect(await perform(env.DB, ada, { type: "note.read", id: old.id })).toMatchObject({ title: "Old plan", state: "archived" });
    expect((await perform(env.DB, ada, { type: "note.backlinks", id: target.id })).map((n) => [n.title, n.state])).toEqual([["Old plan", "archived"]]);
    expect((await perform(env.DB, ada, { type: "note.backlinks", id: old.id })).map((n) => n.title)).toEqual(["Linker"]);
  });

  it("is still changed as any note is, and stays archived", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Old plan\n\n- [ ] ponder");
    await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: true });

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Old plan\n\n- [ ] ponder\n\nMore" });
    expect(written).toMatchObject({ revision: 2, state: "archived" });
    const [todo] = (await perform(env.DB, ada, { type: "todo.list", includeArchived: true })).todos;
    expect(await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: todo!.revision, line: todo!.line, text: todo!.text, done: true })).toMatchObject({ state: "archived" });
    expect((await perform(env.DB, ada, { type: "note.undo", id: note.id })).text).toContain("- [ ] ponder");
  });

  it("is told to a listing of what changed since a time when its state changed, though its text didn't", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Plan", undefined, 1000);
    const changed = async (includeArchived = false) => (await perform(env.DB, ada, { type: "note.list", updatedSince: 2000, includeArchived })).notes.map((n) => [n.title, n.state, n.stateAt]);

    expect(await changed(true)).toEqual([]);
    await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: true }, 3000);
    expect(await changed()).toEqual([]);
    expect(await changed(true)).toEqual([["Plan", "archived", 3000]]);
    await perform(env.DB, ada, { type: "note.archive", id: note.id, archived: false }, 4000);
    expect(await changed()).toEqual([["Plan", "live", 4000]]);
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, 5000);
    expect(await changed(true)).toEqual([]);
    await perform(env.DB, ada, { type: "note.restore", id: note.id }, 6000);
    expect(await changed()).toEqual([["Plan", "live", 6000]]);
  });

  it("is meant by a link written as its title only when no live note has that title", async () => {
    const ada = await newMember();
    const old = await create(ada, "# Plan");
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });

    expect((await create(ada, "See [[Plan]]")).text).toBe(`See [[${old.id}]]`);
    const current = await create(ada, "# Plan");
    expect((await create(ada, "See [[plan]]")).text).toBe(`See [[${current.id}]]`);
    expect((await create(ada, `See [[${old.id}]]`)).text).toBe(`See [[${old.id}]]`);
  });
});

describe("Trash", () => {
  it("takes a note out of every listing, archived ones included, and lists it in Trash with who put it there and when it goes", async () => {
    const ada = await newMember();
    const agent = await agentOf(ada, "Zed");
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    await create(ada, "# Kept\n\n- [ ] ship #now", folder.id);
    const note = await create(ada, "# Mistake\n\n- [ ] regret #never", folder.id);

    const trashed = await perform(env.DB, agent, { type: "note.trash", id: note.id }, 5000);
    expect(trashed).toMatchObject({ id: note.id, state: "trashed", purgesAt: 5000 + TRASH_MS });
    expect(await perform(env.DB, ada, { type: "note.trash", id: note.id }, 9000)).toMatchObject({ state: "trashed", purgesAt: 5000 + TRASH_MS });

    for (const includeArchived of [false, true]) {
      expect(await titles(ada, { type: "note.list", includeArchived })).toEqual(["Kept"]);
      expect((await perform(env.DB, ada, { type: "todo.list", includeArchived })).todos.map((t) => t.noteTitle)).toEqual(["Kept"]);
      expect(await perform(env.DB, ada, { type: "todo.filters", includeArchived })).toEqual({ tags: ["now"], assignees: [] });
      expect((await perform(env.DB, ada, { type: "tag.list", includeArchived })).tags).toEqual([{ name: "now", notes: 1 }]);
      expect((await perform(env.DB, ada, { type: "search", query: "regret", includeArchived })).results).toEqual([]);
    }
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.find((f) => f.id === folder.id)!.noteCount).toBe(1);
    expect((await perform(env.DB, ada, { type: "history.list" })).changes.map((c) => c.noteTitle)).toEqual(["Kept"]);
    expect((await perform(env.DB, ada, { type: "history.list", noteIds: [note.id] })).changes.map((c) => c.noteTitle)).toEqual(["Mistake"]);

    expect((await perform(env.DB, ada, { type: "trash.list" })).notes).toMatchObject([
      { id: note.id, title: "Mistake", folderId: folder.id, state: "trashed", trashedAt: 5000, purgesAt: 5000 + TRASH_MS, trashedBy: { kind: "agent", name: "Zed" } },
    ]);
  });

  it("lists Trash a page at a time, latest trashed first and a tie by id, each once; one trashed meanwhile is on the first page asked again", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const id: Record<string, string> = {};
    for (const [title, at] of [["T1", 1000], ["T2", 2000], ["Tie", 2000], ["T3", 3000], ["T4", 4000]] as const) {
      id[title] = (await create(ada, `# ${title}`)).id;
      await perform(env.DB, ada, { type: "note.trash", id: id[title]! }, at);
    }
    const [tieFirst, tieSecond] = id.T2! < id.Tie! ? ["T2", "Tie"] : ["Tie", "T2"];
    const pages = () => walk((after) => perform(env.DB, ada, { type: "trash.list", limit: 2, after }));
    const before = await pages();

    expect(before.map((page) => page.notes.map((n) => n.title))).toEqual([["T4", "T3"], [tieFirst, tieSecond], ["T1"]]);
    for (const at of [1500, 2500, 3500]) {
      const hidden = await create(eve, "# Eve's own");
      await perform(env.DB, eve, { type: "note.setPrivate", id: hidden.id, private: true });
      await perform(env.DB, eve, { type: "note.trash", id: hidden.id }, at);
    }
    expect(await pages(), "the same pages, and the same cursors, with Eve's private notes in Trash among them").toEqual(before);

    const first = await perform(env.DB, ada, { type: "trash.list", limit: 2 });
    await perform(env.DB, ada, { type: "note.restore", id: id.T1! });
    const late = await create(ada, "# Late");
    await perform(env.DB, ada, { type: "note.trash", id: late.id }, 9000);
    const rest = await walk((after) => perform(env.DB, ada, { type: "trash.list", limit: 2, after: after ?? first.next! }));
    expect(rest.flatMap((page) => page.notes.map((n) => n.title)), "one restored is gone, and one trashed since is before the page").toEqual([tieFirst, tieSecond]);
    expect((await perform(env.DB, ada, { type: "trash.list", limit: 2 })).notes.map((n) => n.title)).toEqual(["Late", "T4"]);
  });

  it("lists tags a page at a time by name, each once, and says nothing of a tag only notes the asker can't see have", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    await create(ada, "# One\n\n#delta #Alpha");
    await create(ada, "# Two\n\n#charlie #bravo #alpha");
    await create(ada, "# Three\n\n#echo");
    const pages = () => walk((after) => perform(env.DB, ada, { type: "tag.list", limit: 2, after }));
    const before = await pages();

    expect(before.map((page) => page.tags)).toEqual([[{ name: "Alpha", notes: 2 }, { name: "bravo", notes: 1 }], [{ name: "charlie", notes: 1 }, { name: "delta", notes: 1 }], [{ name: "echo", notes: 1 }]]);
    const hidden = await create(eve, "# Eve's\n\n#charlie-secret #aardvark #zulu #delta");
    await perform(env.DB, eve, { type: "note.setPrivate", id: hidden.id, private: true });
    expect(await pages(), "the same pages, and the same cursors, with Eve's private tags among them").toEqual(before);
  });

  it("opens a trashed note to be read, says so on a link to it, and refuses every change to it", async () => {
    const ada = await newMember();
    const other = await perform(env.DB, ada, { type: "folder.create", name: "Other" });
    const note = await create(ada, "# Mistake\n\n- [ ] regret");
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Mistake\n\n- [ ] regret\n\nMore" });
    const linker = await create(ada, `[[${note.id}]]`);
    await perform(env.DB, ada, { type: "note.trash", id: note.id });

    expect(await perform(env.DB, ada, { type: "note.read", id: note.id })).toMatchObject({ title: "Mistake", state: "trashed", text: "# Mistake\n\n- [ ] regret\n\nMore" });
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).length).toBe(2);
    expect((await perform(env.DB, ada, { type: "note.read", id: linker.id })).links).toEqual([{ id: note.id, title: "Mistake", state: "trashed" }]);

    const changes: OpInput[] = [
      { type: "note.write", id: note.id, baseRevision: 2, text: "# Changed" },
      { type: "todo.set", id: note.id, revision: 2, line: 2, text: "- [ ] regret", done: true },
      { type: "note.move", id: note.id, folderId: other.id },
      { type: "note.label", id: note.id, revision: 1, name: "Start" },
      { type: "note.revert", id: note.id, revision: 1 },
      { type: "note.revertChanges", id: note.id, revisions: [2] },
      { type: "note.undo", id: note.id },
      { type: "note.redo", id: note.id },
      { type: "note.archive", id: note.id, archived: true },
    ];
    for (const op of changes) await expect(perform(env.DB, ada, op), op.type).rejects.toMatchObject({ code: "conflict", message: IN_TRASH });
    expect(await perform(env.DB, ada, { type: "note.read", id: note.id })).toMatchObject({ revision: 2, state: "trashed" });
  });

  it("is not meant by a link written as its title or its id, and no longer links to anything in a listing", async () => {
    const ada = await newMember();
    const target = await create(ada, "# Target");
    const note = await create(ada, `# Mistake\n\n[[${target.id}]]`);
    await perform(env.DB, ada, { type: "note.trash", id: note.id });

    expect((await create(ada, "See [[Mistake]]")).unresolved).toEqual([{ target: "Mistake", matches: [] }]);
    expect((await create(ada, `See [[${note.id}]]`)).unresolved).toEqual([{ target: note.id, matches: [] }]);
    expect(await perform(env.DB, ada, { type: "note.backlinks", id: target.id })).toEqual([]);
  });

  it("restores a note to its folder, archived if it was, and restoring twice changes nothing more", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const live = await create(ada, "# Live", folder.id);
    const archived = await create(ada, "# Archived", folder.id);
    await perform(env.DB, ada, { type: "note.archive", id: archived.id, archived: true });
    for (const id of [live.id, archived.id]) await perform(env.DB, ada, { type: "note.trash", id });

    expect(await perform(env.DB, ada, { type: "note.restore", id: live.id })).toMatchObject({ folderId: folder.id, state: "live", purgesAt: null, folderGone: false });
    expect(await perform(env.DB, ada, { type: "note.restore", id: live.id })).toMatchObject({ folderId: folder.id, state: "live", folderGone: false });
    expect(await perform(env.DB, ada, { type: "note.restore", id: archived.id })).toMatchObject({ folderId: folder.id, state: "archived", folderGone: false });
    expect(await titles(ada, { type: "note.list", folderId: folder.id })).toEqual(["Live"]);
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes).toEqual([]);
    expect((await perform(env.DB, ada, { type: "note.write", id: live.id, baseRevision: 1, text: "# Live again" })).title).toBe("Live again");
  });

  it("lets a folder that holds only trashed notes be deleted, and restores those notes to Unsorted, saying so", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const note = await create(ada, "# Mistake", folder.id);
    const old = await create(ada, "# Old", folder.id);
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
    await perform(env.DB, ada, { type: "note.trash", id: note.id });

    await expect(perform(env.DB, ada, { type: "folder.delete", id: folder.id })).rejects.toMatchObject({ code: "invalid", message: `"Plans" isn't empty. Move or delete what's in it first, archived notes too.` });
    await perform(env.DB, ada, { type: "note.trash", id: old.id });
    expect(await perform(env.DB, ada, { type: "folder.delete", id: folder.id })).toEqual({ id: folder.id });

    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });
    expect(await perform(env.DB, ada, { type: "note.restore", id: note.id })).toMatchObject({ folderId: unsortedId, state: "live", folderGone: true });
    expect(await perform(env.DB, ada, { type: "note.restore", id: old.id })).toMatchObject({ folderId: unsortedId, state: "archived", folderGone: true });
  });

  it("lets whoever can trash a note restore it to where it was, and asks for edit on Unsorted only when its folder was deleted meanwhile", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer");
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
    const note = await create(ada, "# Shared", folder.id);
    const gus = await guest(ada, note.id, "edit");

    await expect(perform(env.DB, vera, { type: "note.trash", id: note.id })).rejects.toMatchObject({ code: "forbidden" });
    expect(await perform(env.DB, gus, { type: "note.trash", id: note.id })).toMatchObject({ state: "trashed" });
    await expect(perform(env.DB, vera, { type: "note.restore", id: note.id })).rejects.toMatchObject({ code: "forbidden" });
    // A guest given only the note has no folder to edit, and puts the note back where it was all the same.
    expect(await perform(env.DB, gus, { type: "note.restore", id: note.id })).toMatchObject({ state: "live", folderId: null, folderGone: false });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).folderId).toBe(folder.id);

    await perform(env.DB, gus, { type: "note.trash", id: note.id });
    await perform(env.DB, ada, { type: "folder.delete", id: folder.id });
    await expect(perform(env.DB, gus, { type: "note.restore", id: note.id })).rejects.toMatchObject({ code: "forbidden", message: "The folder this note was in was deleted, so it returns to Unsorted, which you can't change" });
    expect(await perform(env.DB, ada, { type: "note.restore", id: note.id })).toMatchObject({ state: "live", folderGone: true });
  });

  it("shows a private note in Trash to its owner alone", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const note = await create(eve, "# Diary");
    await perform(env.DB, eve, { type: "note.setPrivate", id: note.id, private: true });
    await perform(env.DB, eve, { type: "note.trash", id: note.id });

    expect((await perform(env.DB, eve, { type: "trash.list" })).notes.map((n) => n.title)).toEqual(["Diary"]);
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes).toEqual([]);
    await expect(perform(env.DB, ada, { type: "note.restore", id: note.id })).rejects.toMatchObject({ code: "not_found", message: "No such note" });
    await expect(perform(env.DB, eve, { type: "member.leave" })).rejects.toMatchObject({ code: "invalid", message: "You have a private note here besides your daily notes, which nobody else can reach. Stop it being private first, so it isn't left with nobody. Look in Trash too." });
    expect(await perform(env.DB, eve, { type: "note.setPrivate", id: note.id, private: false })).toMatchObject({ private: false });
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes.map((n) => n.title)).toEqual(["Diary"]);
  });

  it("stops a link on a trashed note opening anything, until the note is restored", async () => {
    const ada = await newMember();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Public" });
    const note = await create(ada, "# Announcement", folder.id);
    const old = await create(ada, "# Old news", folder.id);
    const tokenOf = async (on: { noteId: string } | { folderId: string }) => {
      const link = await perform(env.DB, ada, { type: "grant.link", ...on, link: "public" });
      return link!.to.kind === "link" ? (link!.to.token ?? "") : "";
    };
    const onNote: Visitor = { kind: "visitor", token: await tokenOf({ noteId: note.id }), personId: null };
    const onOld: Visitor = { kind: "visitor", token: await tokenOf({ noteId: old.id }), personId: null };
    const onFolder: Visitor = { kind: "visitor", token: await tokenOf({ folderId: folder.id }), personId: null };
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
    await perform(env.DB, ada, { type: "note.trash", id: note.id });

    await expect(perform(env.DB, onNote, { type: "shared.open" })).rejects.toMatchObject({ code: "not_found", message: "No such link" });
    await expect(perform(env.DB, onNote, { type: "shared.read", id: note.id })).rejects.toMatchObject({ code: "not_found", message: "No such link" });
    expect((await perform(env.DB, onFolder, { type: "shared.open" })).notes).toEqual([]);
    await expect(perform(env.DB, onFolder, { type: "shared.read", id: note.id })).rejects.toMatchObject({ code: "not_found", message: "No such note" });
    // A link on an archived note still opens it.
    expect((await perform(env.DB, onOld, { type: "shared.open" })).notes.map((n) => n.title)).toEqual(["Old news"]);
    expect((await perform(env.DB, onOld, { type: "shared.read", id: old.id })).title).toBe("Old news");

    await perform(env.DB, ada, { type: "note.restore", id: note.id });
    expect((await perform(env.DB, onNote, { type: "shared.read", id: note.id })).title).toBe("Announcement");
    expect((await perform(env.DB, onFolder, { type: "shared.open" })).notes.map((n) => n.title)).toEqual(["Announcement"]);
  });

  it("gives a member a new daily note for a day whose note they trashed, files completions there, and restores the old one as an ordinary note", async () => {
    const ada = await newMember();
    const first = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
    const chores = await create(ada, "# Chores\n\n- [ ] water every:1d");
    await perform(env.DB, ada, { type: "note.trash", id: first.id });

    const done = await perform(env.DB, ada, { type: "todo.set", id: chores.id, revision: 1, line: 2, text: "- [ ] water every:1d", done: true, on: "2026-10-11" });
    expect(done.filed).toMatchObject({ on: "2026-10-11", todos: 1 });
    expect(done.filed!.dailyNoteId).not.toBe(first.id);
    const second = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
    expect(second).toMatchObject({ id: done.filed!.dailyNoteId, state: "live" });
    expect(second.text).toContain("- [x] water");

    expect(await perform(env.DB, ada, { type: "note.restore", id: first.id })).toMatchObject({ state: "live" });
    expect((await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" })).id).toBe(second.id);
  });

  it("keeps a trashed daily note as the day's when it is restored before another is needed, and files on an archived one", async () => {
    const ada = await newMember();
    const daily = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
    await perform(env.DB, ada, { type: "note.trash", id: daily.id });
    await perform(env.DB, ada, { type: "note.restore", id: daily.id });
    expect((await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" })).id).toBe(daily.id);

    await perform(env.DB, ada, { type: "note.archive", id: daily.id, archived: true });
    const chores = await create(ada, "# Chores\n\n- [ ] water every:1d");
    const done = await perform(env.DB, ada, { type: "todo.set", id: chores.id, revision: 1, line: 2, text: "- [ ] water every:1d", done: true, on: "2026-10-11" });
    expect(done.filed!.dailyNoteId).toBe(daily.id);
    expect(await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" })).toMatchObject({ id: daily.id, state: "archived" });
  });

  it("leaves a trashed daily note as it is when a completion filed on it is taken back", async () => {
    const ada = await newMember();
    const chores = await create(ada, "# Chores\n\n- [ ] water every:1d");
    const done = await perform(env.DB, ada, { type: "todo.set", id: chores.id, revision: 1, line: 2, text: "- [ ] water every:1d", done: true, on: "2026-10-11" });
    const daily = done.filed!.dailyNoteId!;
    const filed = await perform(env.DB, ada, { type: "note.read", id: daily });
    await perform(env.DB, ada, { type: "note.trash", id: daily });

    const undone = await perform(env.DB, ada, { type: "note.undo", id: chores.id });
    expect(undone.text).toBe("# Chores\n\n- [ ] water every:1d");
    expect(undone.unfiled).toEqual({ removed: 0, left: 1, dailyNoteIds: [] });
    expect(await perform(env.DB, ada, { type: "note.read", id: daily })).toMatchObject({ revision: filed.revision, text: filed.text, state: "trashed" });
    await perform(env.DB, ada, { type: "note.redo", id: chores.id });
    expect((await perform(env.DB, ada, { type: "note.read", id: daily })).revision).toBe(filed.revision);
  });

  it("moves the notes that reverting an author emptied to Trash when asked, and no others", async () => {
    const ada = await newMember();
    const zed = await agentOf(ada, "Zed");
    const mine = await create(ada, "# Mine");
    await perform(env.DB, zed, { type: "note.write", id: mine.id, baseRevision: 1, text: "# Mine\n\nby Zed" });
    const theirs = await create(zed, "# Made by Zed");
    const kept = await create(zed, "# Also made by Zed");
    const author = { kind: "agent" as const, id: zed.kind === "agent" ? zed.agentId : "" };

    const first = await perform(env.DB, ada, { type: "history.revertAuthor", author, noteIds: [kept.id] });
    expect(first.emptied).toEqual([{ noteId: kept.id, title: "Also made by Zed", trashed: false }]);
    const second = await perform(env.DB, zed, { type: "history.revertAuthor", author, trashEmptied: true });
    expect(second.emptied).toEqual([{ noteId: theirs.id, title: "Made by Zed", trashed: true }]);
    expect(second.reverted.map((r) => r.note.id).sort()).toEqual([mine.id, theirs.id].sort());

    expect(await titles(ada, { type: "note.list" })).toEqual(["", "Mine"]);
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes).toMatchObject([{ id: theirs.id, trashedBy: { kind: "agent", name: "Zed" } }]);
    // Notes in Trash are left as they are: a second revert finds nothing of the author's to take out of them.
    expect((await perform(env.DB, ada, { type: "history.revertAuthor", author, trashEmptied: true })).reverted).toEqual([]);
  });

  it("removes a trashed note for good only for an admin or the member who made it, never for an agent, and leaves nothing to tell it from a note that never was", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const ed = await addMember(ada, "editor", "Ed");
    const evesNote = await create(eve, "# Eve's");
    const adasNote = await create(ada, "# Ada's");
    const linker = await perform(env.DB, ada, { type: "note.create", text: `[[${evesNote.id}]] [[${adasNote.id}]] [[zzzzzzzzzzzz]]`, linkTitles: "keep" });

    await expect(perform(env.DB, eve, { type: "note.purge", id: evesNote.id })).rejects.toMatchObject({ code: "invalid" });
    for (const id of [evesNote.id, adasNote.id]) await perform(env.DB, ed, { type: "note.trash", id });
    await expect(perform(env.DB, ed, { type: "note.purge", id: evesNote.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(perform(env.DB, await agentOf(ada), { type: "note.purge", id: adasNote.id })).rejects.toMatchObject({ code: "forbidden", message: "An agent can't note.purge" });
    await expect(perform(env.DB, eve, { type: "note.purge", id: adasNote.id })).rejects.toMatchObject({ code: "forbidden" });

    expect(await perform(env.DB, eve, { type: "note.purge", id: evesNote.id })).toEqual({ id: evesNote.id });
    expect(await perform(env.DB, ada, { type: "note.purge", id: adasNote.id })).toEqual({ id: adasNote.id });

    const never = { code: "not_found", message: "No such note" };
    for (const id of [evesNote.id, adasNote.id, "zzzzzzzzzzzz"]) {
      await expect(perform(env.DB, ada, { type: "note.read", id })).rejects.toMatchObject(never);
      await expect(perform(env.DB, ada, { type: "note.restore", id })).rejects.toMatchObject(never);
      await expect(perform(env.DB, ada, { type: "note.purge", id })).rejects.toMatchObject(never);
    }
    expect((await perform(env.DB, ada, { type: "note.read", id: linker.id })).links.map(({ title, state }) => ({ title, state }))).toEqual(Array(3).fill({ title: null, state: null }));
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes).toEqual([]);
  });
});
