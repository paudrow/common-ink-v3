import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { HOLD_MS } from "../../src/core/discard.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { blank } from "../../src/core/text.ts";
import { OpError } from "../../src/core/protocol.ts";
import { addMember, newMember } from "./members.ts";

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "done",
    (err: unknown) => (err instanceof OpError ? `${err.code}: ${err.message}` : String(err)),
  );
const NOT_DISCARDED = "invalid: Only a note nobody ever wrote in, with never anything in it but spaces or a lone #, is discarded. Move it to Trash instead.";
const HELD = "conflict: The note is open somewhere else, or was written to as it was being discarded, so it is kept";

async function agentOf(member: Actor): Promise<Actor> {
  const { agent } = await connectAgent(env.DB, member.personId!, "Claude");
  return { kind: "agent", agentId: agent.id, personId: member.personId!, workspaceId: member.workspaceId };
}

const discard = (by: Actor, id: string, holder?: string, now = Date.now()) => refusal(perform(env.DB, by, { type: "note.discard", id, holder }, now));
const hold = (by: Actor, id: string, holder: string, now = Date.now()) => perform(env.DB, by, { type: "note.hold", id, holder }, now);

/** Writes each text over the last, as the member's typing is sent. */
async function typed(by: Actor, id: string, ...texts: string[]) {
  let revision = (await perform(env.DB, by, { type: "note.read", id })).revision;
  for (const text of texts) revision = (await perform(env.DB, by, { type: "note.write", id, baseRevision: revision, text })).revision;
}

async function gone(by: Actor, id: string) {
  expect(await refusal(perform(env.DB, by, { type: "note.read", id }))).toBe("not_found: No such note");
  expect((await perform(env.DB, by, { type: "trash.list" })).notes.map((n) => n.id)).not.toContain(id);
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

  it("is one an agent made too, once the agent's hold on it has lapsed, and never the agent's to discard", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const made = Date.now();
    const { id } = await perform(env.DB, claude, { type: "note.create" }, made);
    expect(await discard(ada, id, "page:ada", made + HOLD_MS - 1)).toBe(HELD);
    expect(await refusal(perform(env.DB, claude, { type: "note.discard", id }))).toBe("forbidden: An agent can't note.discard");
    expect(await discard(ada, id, "page:ada", made + HOLD_MS + 1)).toBe("done");
    await gone(ada, id);
  });

  it("is held by an agent that reads it or writes nothing in it, for ten minutes after", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    const read = Date.now() + 60_000;
    await perform(env.DB, claude, { type: "note.read", id }, read);
    expect(await discard(ada, id, "page:ada", read + HOLD_MS - 1)).toBe(HELD);
    const wrote = read + HOLD_MS - 1;
    await perform(env.DB, claude, { type: "note.write", id, baseRevision: 0, text: "#" }, wrote);
    expect(await discard(ada, id, "page:ada", wrote + HOLD_MS - 1)).toBe(HELD);
    expect(await discard(ada, id, "page:ada", wrote + HOLD_MS + 1)).toBe("done");
  });

  it("is another member's too, for a member who can edit it, and never for one who can only read it", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await typed(ada, id, "#");
    expect(await discard(vera, id)).toMatch(/^forbidden/);
    expect(await discard(grace, id)).toBe("done");
    await gone(ada, id);
  });

  it("is kept while another page holds it open, and is the asker's own page's to discard", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    const now = Date.now();
    await hold(ada, id, "page:ada", now);
    await hold(grace, id, "page:grace", now);
    expect(await discard(ada, id, "page:ada", now + 1000)).toBe(HELD);
    expect(await discard(ada, id, undefined, now + HOLD_MS + 1)).toBe("done");
  });

  it("is let go of by each page that leaves it, so the last one to leave discards it", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    const now = Date.now();
    await hold(ada, id, "page:laptop", now);
    await hold(ada, id, "page:phone", now);
    expect(await discard(ada, id, "page:laptop", now + 1000)).toBe(HELD);
    expect(await discard(ada, id, "page:phone", now + 2000)).toBe("done");
  });

  it("can't be held by a name that isn't a page's, so no member can pass for an agent", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    expect(await refusal(hold(ada, id, "agent:aaaaaaaaaaaa"))).toMatch(/^invalid: .*not a page/s);
    expect(await refusal(hold(await agentOf(ada), id, "page:claude"))).toBe("forbidden: An agent can't note.hold");
  });

  it("is kept when its text has words that its history doesn't account for", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await env.DB.prepare("UPDATE notes SET text = 'Imported' WHERE id = ?").bind(id).run();
    expect(await discard(ada, id)).toBe(NOT_DISCARDED);
  });

  it("is not discarded from Trash", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await perform(env.DB, ada, { type: "note.trash", id });
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toMatch(/^conflict/);
    expect((await perform(env.DB, ada, { type: "trash.list" })).notes.map((n) => n.id)).toContain(id);
  });

  it("is never a note from before who made it was kept, empty or not", async () => {
    const ada = await newMember();
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await env.DB.prepare("UPDATE notes SET created_by_kind = NULL WHERE id = ?").bind(id).run();
    expect(await refusal(perform(env.DB, ada, { type: "note.discard", id }))).toBe(NOT_DISCARDED);
  });

  it("is kept when an agent wrote words in it, even if the member emptied it after", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const { id } = await perform(env.DB, ada, { type: "note.create" });
    await typed(claude, id, "Notes from the call");
    await typed(ada, id, "");
    expect(await discard(ada, id, "page:ada", Date.now() + HOLD_MS + 1)).toBe(NOT_DISCARDED);
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
