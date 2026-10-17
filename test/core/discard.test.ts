import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { blank, perform, type Actor } from "../../src/core/operations.ts";
import { OpError } from "../../src/core/protocol.ts";
import { addMember, newMember } from "./members.ts";

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "done",
    (err: unknown) => (err instanceof OpError ? `${err.code}: ${err.message}` : String(err)),
  );
const NOT_DISCARDED = "invalid: Only a note you made that has never had anything in it but spaces or a lone # is discarded. Move it to Trash instead.";

/** Writes each text over the last, as the member's typing is sent. */
async function typed(by: Actor, id: string, ...texts: string[]) {
  let revision = (await perform(env.DB, by, { type: "note.read", id })).revision;
  for (const text of texts) revision = (await perform(env.DB, by, { type: "note.write", id, baseRevision: revision, text })).revision;
}

async function gone(by: Actor, id: string) {
  expect(await refusal(perform(env.DB, by, { type: "note.read", id }))).toBe("not_found: No such note");
  expect((await perform(env.DB, by, { type: "trash.list" })).map((n) => n.id)).not.toContain(id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE note_id = ?").bind(id).first("n")).toBe(0);
}

describe("an empty note the member leaves", () => {
  it("is blank when it is nothing but spaces, line breaks and at most a lone #", () => {
    expect(["", "  ", "\n\n", "#", "# ", "  #\n"].map(blank)).toEqual([true, true, true, true, true, true]);
    expect(["a", "##", "# a", "-", "#\n#"].map(blank)).toEqual([false, false, false, false, false]);
  });

  it("is removed outright when it never had anything in it, not put in Trash", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    expect(await perform(env.DB, ada, { type: "note.discard", id })).toEqual({ id });
    await gone(ada, id);
  });

  it("is removed when all it ever had was a # and spaces", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await typed(ada, id, "#", "# ", "  \n", "#");
    expect(await perform(env.DB, ada, { type: "note.discard", id })).toEqual({ id });
    await gone(ada, id);
  });

  it("is kept when it ever had words, however empty it is now", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await typed(ada, id, "# Pl", "");
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
    expect((await perform(env.DB, ada, { type: "note.read", id })).text).toBe("");
  });

  it("is kept when it was made with words", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create", text: "x" });
    await typed(ada, id, "");
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
  });

  it("is never one an agent made, even an empty one its member left", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const { id } = await perform(env.DB, claude, { type: "note.create" });
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
    expect(await refusal(perform(env.DB, claude, { type: "note.discard", id }))).toMatch(/^forbidden/);
  });

  it("is only the member's who made it, and stays when anyone else typed in it", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    expect(await refusal(perform(env.DB, grace, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
    await typed(grace, id, "#");
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
  });

  it("is not discarded from Trash", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await perform(env.DB, ada, { type: "note.trash", id });
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toMatch(/^conflict/);
    expect((await perform(env.DB, ada, { type: "trash.list" })).map((n) => n.id)).toContain(id);
  });

  it("is never a note from before who made it was kept, empty or not", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await env.DB.prepare("UPDATE notes SET created_by_kind = NULL WHERE id = ?").bind(id).run();
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
  });

  it("is kept when an agent wrote in it, even if the member emptied it after", async () => {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await typed(claude, id, "#");
    await typed(ada, id, "");
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
  });

  it("takes what is kept by the note's id with it: its pins and its grants", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await perform(env.DB, ada, { type: "pin.set", id, pinned: true });
    await perform(env.DB, ada, { type: "grant.set", noteId: id, email: "someone@example.com", access: "view" });
    expect(await perform(env.DB, ada, { type: "note.discard", id })).toEqual({ id });
    for (const table of ["pins", "grants"]) expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id = ?`).bind(id).first("n"), table).toBe(0);
  });
});
