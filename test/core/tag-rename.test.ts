import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const send = (url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env);

function agentOf(token: string) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await send("https://ink.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content[0]!.text, isError: !!result.isError };
  };
}

const tags = async (who: Actor) => (await perform(env.DB, who, { type: "tag.list", includeArchived: true })).tags;
const textOf = async (who: Actor, id: string) => (await perform(env.DB, who, { type: "note.read", id })).text;
const refusal = async (work: Promise<unknown>) => work.then(() => "done", (err: { code: string; message: string }) => `${err.code}: ${err.message}`);

/** Ada's workspace: #garden in two notes, one of them archived, once in code, and #plants in a third. */
async function workspace() {
  const ada = await newMember();
  const seeds = await perform(env.DB, ada, { type: "note.create", text: "# Seeds\n\nOrder seeds #garden, and #Garden/beds\n\n`#garden` stays\n" });
  const beds = await perform(env.DB, ada, { type: "note.create", text: "# Beds\n\n- [ ] Dig the beds #GARDEN due:2026-10-14\n" });
  await perform(env.DB, ada, { type: "note.archive", id: beds.id, archived: true });
  const pots = await perform(env.DB, ada, { type: "note.create", text: "# Pots\n\nRepot #plants" });
  return { ada, seeds, beds, pots };
}

describe("renaming a tag", () => {
  it("rewrites every note with it as typed, archived ones too, outside code, and the tags under it with it, as the member's own change", async () => {
    const { ada, seeds, beds } = await workspace();
    const answer = await perform(env.DB, ada, { type: "tag.rename", name: "#garden", to: "Yard" });
    expect({ ...answer, renamed: answer.renamed.sort((a, b) => a.noteTitle.localeCompare(b.noteTitle)) }).toEqual({
      name: "garden",
      to: "Yard",
      merged: false,
      renamed: [
        { noteId: beds.id, noteTitle: "Beds", revision: 2 },
        { noteId: seeds.id, noteTitle: "Seeds", revision: 2 },
      ],
      skipped: 0,
      failed: 0,
      under: ["Garden/beds"],
      descriptions: [],
    });
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #Yard, and #Yard/beds\n\n`#garden` stays\n");
    expect(await textOf(ada, beds.id)).toBe("# Beds\n\n- [ ] Dig the beds #Yard due:2026-10-14\n");
    expect(await tags(ada)).toEqual([
      { name: "plants", notes: 1 },
      { name: "Yard", notes: 2, inside: 2 },
      { name: "Yard/beds", notes: 1 },
    ]);
    const [change] = (await perform(env.DB, ada, { type: "note.history", id: seeds.id })).slice(-1);
    expect(change!.revision).toBe(2);
    expect(change!.author).toEqual({ kind: "member", personId: ada.personId, name: "Ada Lovelace" });
  });

  it("previewed, writes nothing and says what it would change", async () => {
    const { ada, seeds, beds } = await workspace();
    const preview = await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "plants", preview: true });
    expect({ ...preview, renamed: preview.renamed.map((r) => r.noteTitle).sort() }).toEqual({ name: "garden", to: "plants", merged: true, renamed: ["Beds", "Seeds"], skipped: 0, failed: 0, under: ["Garden/beds"], descriptions: [] });
    expect(preview.renamed.map((r) => r.revision)).toEqual([1, 1]);
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #garden, and #Garden/beds\n\n`#garden` stays\n");
    expect((await perform(env.DB, ada, { type: "note.read", id: beds.id })).revision).toBe(1);
  });

  it("into a tag notes have merges the two, and the tag merged into keeps its own description", async () => {
    const { ada, seeds } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });
    await perform(env.DB, ada, { type: "tag.describe", name: "plants", description: "Pots and houseplants" });
    const grown = [{ name: "garden", to: "plants", description: "Anything we grow", toDescribed: true, describedTo: false }];
    expect(await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "plants", preview: true })).toMatchObject({ merged: true, descriptions: grown });
    expect(await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "plants" })).toMatchObject({ merged: true, descriptions: grown });
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #plants, and #plants/beds\n\n`#garden` stays\n");
    expect(await tags(ada)).toEqual([
      { name: "plants", notes: 3, inside: 3, description: "Pots and houseplants" },
      { name: "plants/beds", notes: 1 },
    ]);
    // The renamed tag's description is gone with it: written again, #garden has none.
    await perform(env.DB, ada, { type: "note.write", id: seeds.id, baseRevision: 2, text: "# Seeds\n\n#garden again" });
    expect((await tags(ada)).find((t) => t.name === "garden")).toEqual({ name: "garden", notes: 1 });
  });

  it("takes its description to a tag that has none, and in a change of case alone keeps it", async () => {
    const { ada, seeds } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });
    expect((await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "yard" })).descriptions).toEqual([{ name: "garden", to: "yard", description: "Anything we grow", toDescribed: false, describedTo: true }]);
    expect((await tags(ada)).find((t) => t.name === "yard")).toEqual({ name: "yard", notes: 2, inside: 2, description: "Anything we grow" });
    expect((await perform(env.DB, ada, { type: "tag.rename", name: "yard", to: "Yard" })).merged).toBe(false);
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #Yard, and #Yard/beds\n\n`#garden` stays\n");
    expect((await tags(ada)).find((t) => t.name === "Yard")).toEqual({ name: "Yard", notes: 2, inside: 2, description: "Anything we grow" });
  });

  it("is undone through each note's history, every note at once", async () => {
    const { ada, seeds, beds } = await workspace();
    const { renamed } = await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "plants" });
    const undone = await perform(env.DB, ada, { type: "history.revert", changes: renamed.map((r) => ({ noteId: r.noteId, revisions: [r.revision] })) });
    expect(undone.skipped).toEqual([]);
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #garden, and #Garden/beds\n\n`#garden` stays\n");
    expect(await textOf(ada, beds.id)).toBe("# Beds\n\n- [ ] Dig the beds #GARDEN due:2026-10-14\n");
  });

  it("is an admin's or an editor's, and leaves the notes the member may see and not change as they were, counting them", async () => {
    const { ada, seeds } = await workspace();
    const folder = await perform(env.DB, ada, { type: "folder.create", name: "Team" });
    const shed = await perform(env.DB, ada, { type: "note.create", folderId: folder.id, text: "# Shed\n\n#garden tools" });
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "member.invite", email, as: "editor" });
    const ned: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Ned Narrowed" })).personId, workspaceId: ada.workspaceId };
    await perform(env.DB, ada, { type: "grant.set", folderId: folder.id, email, access: "view" });

    await perform(env.DB, ada, { type: "tag.describe", name: "garden", description: "Anything we grow" });
    const preview = await perform(env.DB, ned, { type: "tag.rename", name: "garden", to: "yard", preview: true });
    expect([preview.renamed.length, preview.skipped]).toEqual([2, 1]);
    expect((await perform(env.DB, ned, { type: "tag.rename", name: "garden", to: "yard" })).skipped).toBe(1);
    expect(await textOf(ada, shed.id)).toBe("# Shed\n\n#garden tools");
    expect(await textOf(ada, seeds.id)).toBe("# Seeds\n\nOrder seeds #yard, and #yard/beds\n\n`#garden` stays\n");
    // The description stays with #garden, which the shed still has, and #yard is given it too.
    expect(await tags(ada)).toEqual([
      { name: "garden", notes: 1, description: "Anything we grow" },
      { name: "plants", notes: 1 },
      { name: "yard", notes: 2, inside: 2, description: "Anything we grow" },
      { name: "yard/beds", notes: 1 },
    ]);

    const vera = await addMember(ada, "viewer", "Vera Viewer");
    expect(await refusal(perform(env.DB, vera, { type: "tag.rename", name: "yard", to: "garden" }))).toBe("forbidden: A viewer can't tag.rename");
    expect(await refusal(perform(env.DB, ada, { type: "tag.rename", name: "yard", to: "12" }))).toMatch(/^invalid: .*not a tag's name/);
  });

  it("moves a tag under another or to the top, with its description and those of the tags under it, and refuses one inside itself", async () => {
    const ada = await newMember();
    const kickoff = await perform(env.DB, ada, { type: "note.create", text: "# Kickoff\n\n#project/alpha and #project/alpha/notes, not #project/beta" });
    await perform(env.DB, ada, { type: "tag.describe", name: "project/alpha", description: "The alpha project" });
    await perform(env.DB, ada, { type: "tag.describe", name: "project/alpha/Later", description: "" });
    const moved = await perform(env.DB, ada, { type: "tag.rename", name: "project/alpha", to: "work/alpha" });
    expect([moved.under, moved.descriptions]).toEqual([
      ["project/alpha/Later", "project/alpha/notes"],
      [
        { name: "project/alpha", to: "work/alpha", description: "The alpha project", toDescribed: false, describedTo: true },
        { name: "project/alpha/Later", to: "work/alpha/Later", description: "", toDescribed: false, describedTo: true },
      ],
    ]);
    expect(await textOf(ada, kickoff.id)).toBe("# Kickoff\n\n#work/alpha and #work/alpha/notes, not #project/beta");
    expect(await tags(ada)).toEqual([
      { name: "project", notes: 0, inside: 1 },
      { name: "project/beta", notes: 1 },
      { name: "work", notes: 0, inside: 1 },
      { name: "work/alpha", notes: 1, inside: 1, description: "The alpha project" },
      { name: "work/alpha/Later", notes: 0 },
      { name: "work/alpha/notes", notes: 1 },
    ]);
    await perform(env.DB, ada, { type: "tag.rename", name: "work/alpha", to: "alpha" });
    expect((await tags(ada)).map((t) => t.name)).toEqual(["alpha", "alpha/Later", "alpha/notes", "project", "project/beta"]);
    expect(await refusal(perform(env.DB, ada, { type: "tag.rename", name: "alpha", to: "alpha/deeper" }))).toBe("invalid: #alpha/deeper is under #alpha: a tag can't go inside itself");
  });

  it("renames a tag no note has, made ahead, by its description alone, and a change of case alone keeps it", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "tag.describe", name: "Someday", description: "" });
    expect(await perform(env.DB, ada, { type: "tag.rename", name: "someday", to: "Later" })).toMatchObject({ renamed: [], descriptions: [{ name: "Someday", to: "Later", description: "", toDescribed: false, describedTo: true }] });
    await perform(env.DB, ada, { type: "tag.rename", name: "later", to: "LATER" });
    expect(await tags(ada)).toEqual([{ name: "LATER", notes: 0 }]);
  });

  it("is kept from agents, which still reuse the new name and are refused the old one as new", async () => {
    const { ada } = await workspace();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const call = agentOf(token);
    expect(await refusal(perform(env.DB, { kind: "agent", agentId: (await connectAgent(env.DB, ada.personId, "Other")).agent.id, personId: ada.personId, workspaceId: ada.workspaceId }, { type: "tag.rename", name: "garden", to: "yard" }))).toMatch(/^forbidden: /);
    const listed = await send("https://ink.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("describe_tag");
    expect(names.filter((name) => name.includes("rename") && name.includes("tag"))).toEqual([]);
    await perform(env.DB, ada, { type: "tag.rename", name: "garden", to: "yard" });
    expect((await call("create_note", { text: "# Hose\n\n#yard" })).isError).toBe(false);
    expect(await call("create_note", { text: "# Rake\n\n#garden" })).toEqual({
      isError: true,
      text: 'invalid: #garden is a new tag: no note you can see has it. Use a tag list_tags lists, or if your member asked for this one, pass newTags: ["garden"]',
    });
  });
});
