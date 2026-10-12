import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

describe("folders", () => {
  it("nest under a parent, alongside Unsorted at the top level", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "  Work " });
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "projects", parentId: work.id });

    const { unsortedId, folders } = await perform(env.DB, ada, { type: "folder.list" });

    expect(folders).toEqual([
      { id: projects.id, name: "projects", parentId: work.id, noteCount: 0 },
      { id: unsortedId, name: "Unsorted", parentId: null, noteCount: 0 },
      { id: work.id, name: "Work", parentId: null, noteCount: 0 },
    ]);
  });

  it("are listed with how many notes each holds directly", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "Projects", parentId: work.id });
    await perform(env.DB, ada, { type: "note.create", text: "# Plan", folderId: projects.id });
    await perform(env.DB, ada, { type: "note.create", text: "# Budget", folderId: projects.id });
    const moved = await perform(env.DB, ada, { type: "note.create", text: "# Loose" });
    await perform(env.DB, ada, { type: "note.move", id: moved.id, folderId: work.id });
    await perform(env.DB, ada, { type: "note.create" });

    const { folders } = await perform(env.DB, ada, { type: "folder.list" });

    expect(folders.map((f) => [f.name, f.noteCount])).toEqual([
      ["Projects", 2],
      ["Unsorted", 1],
      ["Work", 1],
    ]);
  });

  it("are named without slashes or control characters", async () => {
    const ada = await newMember();

    for (const name of ["", "   ", "a/b", "tab\there", "x".repeat(101)]) {
      await expect(perform(env.DB, ada, { type: "folder.create", name })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(await perform(env.DB, ada, { type: "folder.create", name: "x".repeat(100) })).toMatchObject({ name: "x".repeat(100) });
  });

  it("can't be created inside another workspace's folder", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const theirs = await perform(env.DB, grace, { type: "folder.create", name: "Theirs" });

    await expect(perform(env.DB, ada, { type: "folder.create", name: "Mine", parentId: theirs.id })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
  });

  it("can be renamed, except Unsorted", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    const renamed = await perform(env.DB, ada, { type: "folder.rename", id: work.id, name: "Office" });

    expect(renamed).toEqual({ id: work.id, name: "Office", parentId: null });
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Office", "Unsorted"]);
    await expect(perform(env.DB, ada, { type: "folder.rename", id: unsortedId, name: "Inbox" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("have names unique among their siblings, ignoring case", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    const home = await perform(env.DB, ada, { type: "folder.create", name: "Home" });

    await expect(perform(env.DB, ada, { type: "folder.create", name: "WORK" })).rejects.toMatchObject({
      code: "invalid",
      message: `There's already a folder named "WORK" here`,
    });
    await expect(perform(env.DB, ada, { type: "folder.rename", id: home.id, name: "work" })).rejects.toMatchObject({
      code: "invalid",
      message: `There's already a folder named "work" here`,
    });
    expect(await perform(env.DB, ada, { type: "folder.create", name: "Work", parentId: home.id })).toMatchObject({ name: "Work", parentId: home.id });
    expect(await perform(env.DB, ada, { type: "folder.rename", id: work.id, name: "WORK" })).toEqual({ id: work.id, name: "WORK", parentId: null });
  });

  it("can be deleted only when empty", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    await perform(env.DB, ada, { type: "folder.create", name: "Projects", parentId: work.id });
    const notes = await perform(env.DB, ada, { type: "folder.create", name: "Notes" });
    await perform(env.DB, ada, { type: "note.create", text: "# Plan", folderId: notes.id });
    const empty = await perform(env.DB, ada, { type: "folder.create", name: "Empty" });

    await expect(perform(env.DB, ada, { type: "folder.delete", id: work.id })).rejects.toMatchObject({
      code: "invalid",
      message: `"Work" isn't empty. Move or delete what's in it first.`,
    });
    await expect(perform(env.DB, ada, { type: "folder.delete", id: notes.id })).rejects.toMatchObject({ code: "invalid" });
    expect(await perform(env.DB, ada, { type: "folder.delete", id: empty.id })).toEqual({ id: empty.id });
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Notes", "Projects", "Unsorted", "Work"]);
  });

  it("can't delete Unsorted or a folder in another workspace", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const theirs = await perform(env.DB, grace, { type: "folder.create", name: "Theirs" });
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    await expect(perform(env.DB, ada, { type: "folder.delete", id: unsortedId })).rejects.toMatchObject({ code: "invalid", message: "Unsorted can't be deleted" });
    await expect(perform(env.DB, ada, { type: "folder.delete", id: theirs.id })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    expect((await perform(env.DB, grace, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Theirs", "Unsorted"]);
  });

  it("are created and renamed by editors, deleted only by admins, and left alone by viewers", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const mary = await addMember(ada, "viewer", "Mary Jackson");

    await expect(perform(env.DB, mary, { type: "folder.create", name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });
    const work = await perform(env.DB, grace, { type: "folder.create", name: "Work" });
    await perform(env.DB, grace, { type: "folder.rename", id: work.id, name: "Office" });
    await expect(perform(env.DB, grace, { type: "folder.delete", id: work.id })).rejects.toMatchObject({ code: "forbidden" });
    expect((await perform(env.DB, mary, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Office", "Unsorted"]);

    expect(await perform(env.DB, ada, { type: "folder.delete", id: work.id })).toEqual({ id: work.id });
  });

  it("hold the notes created in them, and Unsorted holds notes created without one", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    await perform(env.DB, ada, { type: "note.create", text: "# Plan", folderId: work.id }, 1000);
    await perform(env.DB, ada, { type: "note.create", text: "# Loose" }, 2000);
    const { unsortedId } = await perform(env.DB, ada, { type: "folder.list" });

    const inWork = await perform(env.DB, ada, { type: "note.list", folderId: work.id });
    const inUnsorted = await perform(env.DB, ada, { type: "note.list", folderId: unsortedId });
    const everywhere = await perform(env.DB, ada, { type: "note.list" });

    expect(inWork.map((n) => n.title)).toEqual(["Plan"]);
    expect(inUnsorted.map((n) => n.title)).toEqual(["Loose"]);
    expect(everywhere.map((n) => [n.title, n.folderId])).toEqual([
      ["Loose", unsortedId],
      ["Plan", work.id],
    ]);
  });

  it("take a moved note without recording a change or counting it as an edit", async () => {
    const ada = await newMember();
    const work = await perform(env.DB, ada, { type: "folder.create", name: "Work" });
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" }, 1000);

    const moved = await perform(env.DB, ada, { type: "note.move", id: note.id, folderId: work.id }, 5000);

    expect(moved).toEqual({ ...note, folderId: work.id });
    expect((await perform(env.DB, ada, { type: "note.list", folderId: work.id })).map((n) => [n.id, n.updatedAt])).toEqual([[note.id, 1000]]);
    expect(await perform(env.DB, ada, { type: "note.list", folderId: note.folderId })).toEqual([]);
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).map((c) => c.revision)).toEqual([1]);
  });

  it("in another workspace can't receive a moved note", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const theirs = await perform(env.DB, grace, { type: "folder.create", name: "Theirs" });
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Mine" });

    await expect(perform(env.DB, ada, { type: "note.move", id: note.id, folderId: theirs.id })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).folderId).toBe(note.folderId);
  });

  it("in another workspace can't receive a new note", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const theirs = await perform(env.DB, grace, { type: "folder.create", name: "Theirs" });

    await expect(perform(env.DB, ada, { type: "note.create", text: "# Sneaky", folderId: theirs.id })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    expect(await perform(env.DB, grace, { type: "note.list", folderId: theirs.id })).toEqual([]);
  });

  it("deleted while a note is being created in them either keep the note or refuse it as missing", async () => {
    const ada = await newMember();
    const outcomes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const folder = await perform(env.DB, ada, { type: "folder.create", name: `Race ${i}` });
      const [created, deleted] = await Promise.allSettled([
        perform(env.DB, ada, { type: "note.create", folderId: folder.id }),
        perform(env.DB, ada, { type: "folder.delete", id: folder.id }),
      ]);
      const code = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? "ok" : (r.reason as { code?: string }).code ?? String(r.reason));
      outcomes.add(`${code(created)}/${code(deleted)}`);
    }

    expect([...outcomes].filter((o) => o !== "ok/invalid" && o !== "not_found/ok")).toEqual([]);
  });
});
