import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

describe("editing lines of a note", () => {
  it("replaces one line and leaves the others", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "alpha\nbeta\ngamma" });

    const edited = await perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 1, to: 2, text: "BETA" }] });

    expect(edited.text).toBe("alpha\nBETA\ngamma");
    expect(edited.revision).toBe(2);
  });

  it("keeps a later edit to a line the edit doesn't name", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "intro\nKEEP\noutro" });
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "intro\nKEPT\noutro" });

    const edited = await perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 1, to: 1, text: "added" }] });

    expect(edited.text).toBe("intro\nadded\nKEPT\noutro");
  });

  it("merges the same way a write of the spliced note would", async () => {
    const ada = await newMember();
    const written = await perform(env.DB, ada, { type: "note.create", text: "alpha\nbeta\ngamma" });
    const edited = await perform(env.DB, ada, { type: "note.create", text: "alpha\nbeta\ngamma" });
    await perform(env.DB, ada, { type: "note.write", id: written.id, baseRevision: 1, text: "ALPHA\nbeta\ngamma" });
    await perform(env.DB, ada, { type: "note.write", id: edited.id, baseRevision: 1, text: "ALPHA\nbeta\ngamma" });

    const byWrite = await perform(env.DB, ada, { type: "note.write", id: written.id, baseRevision: 1, text: "alpha\nbeta\ngamma\ndelta" });
    const byEdit = await perform(env.DB, ada, { type: "note.edit", id: edited.id, baseRevision: 1, edits: [{ from: 3, to: 3, text: "delta" }] });

    expect(byEdit.text).toBe(byWrite.text);
    expect(byEdit.text).toBe("ALPHA\nbeta\ngamma\ndelta");
  });

  it("refuses a range outside the note and two that overlap, and writes nothing", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "a\nb" });

    await expect(perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 0, to: 3, text: "x" }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 0, to: 2, text: "x" }, { from: 1, to: 2, text: "y" }] })).rejects.toMatchObject({ code: "invalid" });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe("a\nb");
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).revision).toBe(1);
  });

  it("records one edit when the same write id is sent again", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "a\nb" });
    const once = await perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, writeId: "w1", edits: [{ from: 0, to: 1, text: "A" }] });

    const again = await perform(env.DB, ada, { type: "note.edit", id: note.id, baseRevision: 1, writeId: "w1", edits: [{ from: 0, to: 1, text: "NO" }] });

    expect(again.text).toBe(once.text);
    expect(again.revision).toBe(2);
  });

  it("refuses a viewer", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "a\nb" });
    const viewer = await addMember(ada, "viewer");

    await expect(perform(env.DB, viewer, { type: "note.edit", id: note.id, baseRevision: 1, edits: [{ from: 0, to: 1, text: "A" }] })).rejects.toMatchObject({ code: "forbidden" });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe("a\nb");
  });
});
