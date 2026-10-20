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

  it("returns the same note when create is sent again with the same writeId", async () => {
    const ada = await newMember();
    const first = await perform(env.DB, ada, { type: "note.create", text: "# Once\n\nhello", writeId: "clip-1" });
    const again = await perform(env.DB, ada, { type: "note.create", text: "# Twice\n\nno", writeId: "clip-1" });
    const other = await perform(env.DB, ada, { type: "note.create", text: "# Other\n\nyes", writeId: "clip-2" });

    expect(again.id).toBe(first.id);
    expect(again.text).toBe("# Once\n\nhello");
    expect(other.id).not.toBe(first.id);
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

  it("takes ten writers to one note at once, and a writer it can't fit in is told to send again, not that the server broke", async () => {
    const ada = await newMember();
    for (const writers of [10, 40]) {
      const note = await perform(env.DB, ada, { type: "note.create", text: "start" });
      const answers = await Promise.allSettled(Array.from({ length: writers }, (_, i) => perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `start\nline ${i}.` })));

      const refused = answers.flatMap((a) => (a.status === "rejected" ? [a.reason as unknown] : []));
      for (const reason of refused) expect(reason).toMatchObject({ name: "OpError", code: "conflict" });
      if (writers === 10) expect(refused).toEqual([]);
      const { text, revision } = await perform(env.DB, ada, { type: "note.read", id: note.id });
      expect(revision).toBe(1 + writers - refused.length);
      answers.forEach((a, i) => expect([i, text.includes(`line ${i}.`)]).toEqual([i, a.status === "fulfilled"]));
    }
  });

  it("lists only the notes changed at or after a time when asked to", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "note.create", text: "# Old" }, 1000);
    const edited = await perform(env.DB, ada, { type: "note.create", text: "# Edited" }, 2000);
    await perform(env.DB, ada, { type: "note.write", id: edited.id, baseRevision: 1, text: "# Edited again" }, 5000);
    await perform(env.DB, ada, { type: "note.create", text: "# New" }, 6000);
    const titles = async (updatedSince?: number) => (await perform(env.DB, ada, { type: "note.list", updatedSince })).map((n) => n.title);

    expect(await titles(5000)).toEqual(["New", "Edited again"]);
    expect(await titles(6001)).toEqual([]);
    expect(await titles()).toEqual(["New", "Edited again", "Old"]);
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

  it("keeps a history that works for a note created with Windows line endings or half a character pair", async () => {
    const ada = await newMember();
    for (const [given, kept] of [
      ["# Plan\r\n\r\n- [ ] one\r\n- [ ] two\rthree", "# Plan\n\n- [ ] one\n- [ ] two\nthree"],
      ["# Plan \uD83D\n\n- [ ] one \uDE00", "# Plan �\n\n- [ ] one �"],
      ["# Plan 😀\r\n", "# Plan 😀\n"],
    ] as const) {
      const note = await perform(env.DB, ada, { type: "note.create", text: given });
      expect(note.text).toBe(kept);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe(kept);

      const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `${given}\r\n- [ ] more \uDC00` });
      expect(written.text).toBe(`${kept}\n- [ ] more �`);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe(written.text);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id, revision: 1 })).text).toBe(kept);
      expect((await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `intro\r\n${given}` })).text).toBe(`intro\n${written.text}`);

      expect((await perform(env.DB, ada, { type: "note.undo", id: note.id })).text).toBe(written.text);
      expect((await perform(env.DB, ada, { type: "note.redo", id: note.id })).text).toBe(`intro\n${written.text}`);
      expect((await perform(env.DB, ada, { type: "note.revertChanges", id: note.id, revisions: [2] })).text).toBe(`intro\n${kept}`);
      expect((await perform(env.DB, ada, { type: "note.revert", id: note.id, revision: 1 })).text).toBe(kept);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe(kept);
      expect(await perform(env.DB, ada, { type: "note.history", id: note.id })).toHaveLength(7);
      expect((await perform(env.DB, ada, { type: "history.list", noteIds: [note.id] })).changes).toHaveLength(7);
    }
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
    await perform(env.DB, grace, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\n- [x] book a room\n- [ ] send [[invites]]", linkTitles: "keep" }, 2000);
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
      access: "edit",
      private: false,
      state: "live",
      purgesAt: null,
      stateAt: null,
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
      links: [],
      mentions: [],
      uploads: [],
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
