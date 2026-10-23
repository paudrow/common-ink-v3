import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

const tags = async (who: Actor) => (await perform(env.DB, who, { type: "tag.list", includeArchived: true })).tags;
const textOf = async (who: Actor, id: string) => (await perform(env.DB, who, { type: "note.read", id })).text;
const refusal = async (work: Promise<unknown>) => work.then(() => "done", (err: { code: string; message: string }) => `${err.code}: ${err.message}`);
const byTitle = <T extends { noteTitle: string }>(notes: T[]) => [...notes].sort((a, b) => a.noteTitle.localeCompare(b.noteTitle));

const SEEDS = "# Seeds\n\nOrder seeds for the #garden, and #Garden/beds too\n\n`#garden` stays\n\n#garden #home\n";
const BEDS = "# Beds\n\n- [ ] Dig the beds #GARDEN due:2026-10-14\n";

/** Ada's workspace: #garden in two notes, one of them archived, once in code, and #plants in a third. */
async function workspace() {
  const ada = await newMember();
  const seeds = await perform(env.DB, ada, { type: "note.create", text: SEEDS });
  const beds = await perform(env.DB, ada, { type: "note.create", text: BEDS });
  await perform(env.DB, ada, { type: "note.archive", id: beds.id, archived: true });
  const pots = await perform(env.DB, ada, { type: "note.create", text: "# Pots\n\nRepot #plants" });
  return { ada, seeds, beds, pots };
}

describe("deleting a tag", () => {
  it("takes it and the tags under it out of every note with it, archived ones too, keeping its word in a sentence, as the member's own labeled change", async () => {
    const { ada, seeds, beds } = await workspace();
    const answer = await perform(env.DB, ada, { type: "tag.delete", name: "#garden" });
    expect({ ...answer, deleted: byTitle(answer.deleted) }).toEqual({
      name: "garden",
      deleted: [
        { noteId: beds.id, noteTitle: "Beds", revision: 2 },
        { noteId: seeds.id, noteTitle: "Seeds", revision: 2 },
      ],
      skipped: 0,
      failed: 0,
      under: ["Garden/beds"],
      descriptions: [],
    });
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds for the garden, and beds too\n\n`#garden` stays\n\n#home\n");
    expect(await textOf(ada, beds.id)).toBe("# Beds\n\n- [ ] Dig the beds due:2026-10-14\n");
    expect(await tags(ada)).toEqual([
      { name: "home", notes: 1 },
      { name: "plants", notes: 1 },
    ]);
    const [change] = (await perform(env.DB, ada, { type: "note.history", id: seeds.id })).slice(-1);
    expect([change!.revision, change!.label, change!.author]).toEqual([2, "Deleted #garden", { kind: "member", personId: ada.personId, name: "Ada Lovelace" }]);
  });

  it("previewed, writes nothing and says what it would change", async () => {
    const { ada, seeds } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });
    const preview = await perform(env.DB, ada, { type: "tag.delete", name: "Garden", preview: true });
    expect({ ...preview, deleted: byTitle(preview.deleted).map((note) => [note.noteTitle, note.revision]) }).toEqual({
      name: "Garden",
      deleted: [
        ["Beds", 1],
        ["Seeds", 1],
      ],
      skipped: 0,
      failed: 0,
      under: ["Garden/beds"],
      descriptions: [{ name: "garden", description: "Anything we grow" }],
    });
    expect(await textOf(ada, seeds.id)).toBe(SEEDS);
    expect((await tags(ada)).find((t) => t.name === "GARDEN")).toEqual({ name: "GARDEN", notes: 2, inside: 2, description: "Anything we grow" });
  });

  it("takes the descriptions of the tag and the tags under it, and deletes a tag no note has by its description alone", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });
    await perform(env.DB, ada, { type: "tag.describe", name: "Garden/beds", description: "Raised beds" });
    await perform(env.DB, ada, { type: "tag.describe", name: "garden/later", description: "" });
    await perform(env.DB, ada, { type: "tag.describe", name: "gardens", description: "Public ones" });
    const { descriptions, under } = await perform(env.DB, ada, { type: "tag.delete", name: "garden" });
    expect([under, descriptions]).toEqual([
      ["Garden/beds", "garden/later"],
      [
        { name: "garden", description: "Anything we grow" },
        { name: "Garden/beds", description: "Raised beds" },
        { name: "garden/later", description: "" },
      ],
    ]);
    expect((await tags(ada)).map((t) => t.name)).toEqual(["gardens", "home", "plants"]);

    await perform(env.DB, ada, { type: "tag.describe", name: "Someday", description: "Not now" });
    expect(await perform(env.DB, ada, { type: "tag.delete", name: "someday" })).toEqual({ name: "someday", deleted: [], skipped: 0, failed: 0, under: [], descriptions: [{ name: "Someday", description: "Not now" }] });
    expect((await tags(ada)).map((t) => t.name)).toEqual(["gardens", "home", "plants"]);
  });

  it("is undone all at once by reverting the changes it answers, and in one note by its Undo", async () => {
    const { ada, seeds, beds } = await workspace();
    const { deleted } = await perform(env.DB, ada, { type: "tag.delete", name: "garden" });
    const undone = await perform(env.DB, ada, { type: "history.revert", changes: deleted.map((note) => ({ noteId: note.noteId, revisions: [note.revision] })) });
    expect([undone.reverted.length, undone.skipped]).toEqual([2, []]);
    expect(await textOf(ada, seeds.id)).toBe(SEEDS);
    expect(await textOf(ada, beds.id)).toBe(BEDS);

    await perform(env.DB, ada, { type: "tag.delete", name: "garden" });
    await perform(env.DB, ada, { type: "note.undo", id: seeds.id });
    expect(await textOf(ada, seeds.id)).toBe(SEEDS);
    // Deleted again, a note's label moves to the latest change.
    expect((await perform(env.DB, ada, { type: "tag.delete", name: "garden" })).deleted.map((note) => note.noteTitle)).toEqual(["Seeds"]);
    expect((await perform(env.DB, ada, { type: "note.history", id: seeds.id })).map((change) => change.label)).toEqual([null, null, null, null, null, "Deleted #garden"]);
  });

  it("is an admin's or an editor's, and leaves the notes the member may see and not change as they were, with the tag's description, counting them", async () => {
    const { ada, seeds } = await workspace();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Team" });
    const shed = await perform(env.DB, ada, { type: "note.create", folderId: folder.id, text: "# Shed\n\n#garden tools" });
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    const ned: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Ned Narrowed" })).personId, workspaceId: ada.workspaceId };
    await perform(env.DB, ada, { type: "grant.set", folderId: folder.id, email, access: "view" });
    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });

    const preview = await perform(env.DB, ned, { type: "tag.delete", name: "garden", preview: true });
    expect([preview.deleted.length, preview.skipped, preview.descriptions]).toEqual([2, 1, []]);
    expect(await perform(env.DB, ned, { type: "tag.delete", name: "garden" })).toMatchObject({ skipped: 1, failed: 0, descriptions: [] });
    expect(await textOf(ada, shed.id)).toBe("# Shed\n\n#garden tools");
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds for the garden, and beds too\n\n`#garden` stays\n\n#home\n");
    expect((await tags(ada)).find((t) => t.name === "garden")).toEqual({ name: "garden", notes: 1, description: "Anything we grow" });

    const vera = await addMember(ada, "viewer", "Vera Viewer");
    expect(await refusal(perform(env.DB, vera, { type: "tag.delete", name: "garden" }))).toBe("forbidden: A viewer can't tag.delete");
    expect(await refusal(perform(env.DB, ada, { type: "tag.delete", name: "12" }))).toMatch(/^invalid: .*not a tag's name/);
  });

  it("is kept from agents", async () => {
    const { ada, seeds } = await workspace();
    const agent: Actor = { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Claude")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    expect(await refusal(perform(env.DB, agent, { type: "tag.delete", name: "garden" }))).toMatch(/^forbidden: /);
    expect(await textOf(ada, seeds.id)).toBe(SEEDS);
  });
});
