import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import { MAX_NOTE_LENGTH } from "../../src/core/protocol.ts";
import { addMember, newMember } from "./members.ts";

describe("notes", () => {
  it("can be created, edited, and reopened with their text intact", async () => {
    const ada = await newMember();
    const created = await perform(env.DB, ada, { type: "note.create", text: "# Groceries\n\n- eggs" });

    await perform(env.DB, ada, { type: "note.write", id: created.id, baseRevision: created.revision, text: "# Groceries\n\n- eggs\n- flour" });
    const reopened = await perform(env.DB, ada, { type: "note.read", id: created.id });

    expect(reopened.text).toBe("# Groceries\n\n- eggs\n- flour");
    expect(reopened.title).toBe("Groceries");
    expect(reopened.slug).toBe("groceries");
  });

  it("refuses a merge that would make the note longer than any one write may be", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "start" });
    const half = "x".repeat(MAX_NOTE_LENGTH / 2);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `start${half}` });

    const stale = perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `${half}start` });

    await expect(stale).rejects.toMatchObject({ code: "invalid" });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).revision).toBe(2);
  });

  it("records each save as a change with its author and the revision it was based on", async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
    const saved = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: note.revision, text: "# Plan\n\nStep one" });

    const history = await perform(env.DB, ada, { type: "note.history", id: note.id });

    expect(saved.revision).toBe(2);
    expect(history.map(({ revision, baseRevision, author }) => ({ revision, baseRevision, author: author.name }))).toEqual([
      { revision: 1, baseRevision: 0, author: "Ada Lovelace" },
      { revision: 2, baseRevision: 1, author: "Ada Lovelace" },
    ]);
  });

  it("derives the text at any revision from its changes", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "one two" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 2, text: "two three" });

    const revisions = await Promise.all([0, 1, 2, 3].map((revision) => perform(env.DB, ada, { type: "note.read", id: note.id, revision })));

    expect(revisions.map((r) => r.text)).toEqual(["", "one", "one two", "two three"]);
  });

  it("records nothing when a save doesn't change the text", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "same" });

    const saved = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "same" });

    expect(saved.revision).toBe(1);
    expect(await perform(env.DB, ada, { type: "note.history", id: note.id })).toHaveLength(1);
  });

  it("merges a write based on an old revision instead of overwriting newer changes", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "alpha\nbeta\ngamma" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "ALPHA\nbeta\ngamma" });

    const merged = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "alpha\nbeta\ngamma\ndelta" });

    expect(merged.text).toBe("ALPHA\nbeta\ngamma\ndelta");
    expect(merged.revision).toBe(3);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe("ALPHA\nbeta\ngamma\ndelta");
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).at(-1)?.baseRevision).toBe(1);
  });

  it("keeps a stale write's insertion next to the text it followed when another write inserted at the same place", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "mine" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "mine\n\ntheirs" });

    const merged = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "mine too" });

    expect(merged.text).toBe("mine too\n\ntheirs");
  });

  it("records a retried write once, even after newer changes", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "hello" });
    const write = { type: "note.write", id: note.id, baseRevision: 1, text: "hello!", writeId: "w1" } as const;
    await perform(env.DB, ada, write);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 2, text: "# hello!" });

    const retried = await perform(env.DB, ada, write);

    expect(retried.text).toBe("# hello!");
    expect(await perform(env.DB, ada, { type: "note.history", id: note.id })).toHaveLength(3);
  });

  it("keeps both writes when two saves from the same revision race", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "middle" });

    await Promise.all([
      perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "start middle" }),
      perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "middle end" }),
    ]);

    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe("start middle end");
  });

  it("are listed with their title, snippet, open todos, and who changed them last", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await addMember(ada, "editor", "Grace Hopper");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan\n\n- [ ] book a room" }, 1000);

    const [created] = await perform(env.DB, ada, { type: "note.list" });
    await perform(env.DB, grace, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\n- [x] book a room\n- [ ] send [[invites]]" }, 2000);
    const [written] = await perform(env.DB, ada, { type: "note.list" });

    expect(created).toEqual({
      id: note.id,
      title: "Plan",
      slug: "plan",
      folderId: note.folderId,
      revision: 1,
      createdAt: 1000,
      updatedAt: 1000,
      updatedBy: { kind: "member", personId: ada.personId, name: "Ada Lovelace" },
      snippet: "book a room",
      openTodos: 1,
    });
    expect(written).toEqual({
      ...created,
      revision: 2,
      updatedAt: 2000,
      updatedBy: { kind: "member", personId: grace.personId, name: "Grace Hopper" },
      snippet: "book a room send invites",
      openTodos: 1,
    });
    expect(await perform(env.DB, ada, { type: "note.read", id: note.id })).toEqual({
      ...written,
      text: "# Plan\n\n- [x] book a room\n- [ ] send [[invites]]",
    });
  });

  it("is invisible to people outside the workspace", async () => {
    const ada = await newMember("Ada Lovelace");
    const grace = await newMember("Grace Hopper");
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Private" });

    await expect(perform(env.DB, { ...grace, workspaceId: ada.workspaceId }, { type: "note.read", id: note.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, grace, { type: "note.read", id: note.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await perform(env.DB, grace, { type: "note.list" })).toEqual([]);
  });
});
