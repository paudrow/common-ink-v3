import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
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
const refusal = async (work: Promise<unknown>) => work.then(() => "done", (err: { code: string; message: string }) => `${err.code}: ${err.message}`);

/** Ada's workspace with a note tagged #Money and one tagged #trip. */
async function workspace() {
  const ada = await newMember();
  const budget = await perform(env.DB, ada, { type: "note.create", text: "# Budget\n\nRent #Money" });
  await perform(env.DB, ada, { type: "note.create", text: "# Paris\n\n#trip" });
  return { ada, budget };
}

describe("a tag's description", () => {
  it("is listed beside the tag once a member says it, and left out of the tags nobody described", async () => {
    const { ada } = await workspace();
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "  Bills, budgets and anything paid  " })).toEqual({ name: "money", description: "Bills, budgets and anything paid" });
    expect(await tags(ada)).toEqual([
      { name: "Money", notes: 1, description: "Bills, budgets and anything paid" },
      { name: "trip", notes: 1 },
    ]);
  });

  it("is replaced by the next one, and taken away by an empty one", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "#trip", description: "Travel plans" });
    await perform(env.DB, ada, { type: "tag.describe", name: "TRIP", description: "Trips we are planning" });
    expect((await tags(ada)).find((t) => t.name === "trip")).toEqual({ name: "trip", notes: 1, description: "Trips we are planning" });
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "trip", description: "   " })).toEqual({ name: "trip", description: null });
    expect((await tags(ada)).find((t) => t.name === "trip")).toEqual({ name: "trip", notes: 1 });
  });

  it("stays with the name while no note has the tag, which is listed with no notes, and counted again when one does", async () => {
    const { ada, budget } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "Bills" });
    await perform(env.DB, ada, { type: "note.write", id: budget.id, baseRevision: 1, text: "# Budget\n\nRent #cash" });
    expect(await tags(ada)).toEqual([{ name: "cash", notes: 1 }, { name: "money", notes: 0, description: "Bills" }, { name: "trip", notes: 1 }]);
    await perform(env.DB, ada, { type: "note.write", id: budget.id, baseRevision: 2, text: "# Budget\n\nRent #cash #money" });
    expect((await tags(ada)).find((t) => t.name === "money")).toEqual({ name: "money", notes: 1, description: "Bills" });
  });

  it("with nothing said makes a tag ahead, listed as typed with no notes, which an agent may use; emptied it stays, and null forgets it", async () => {
    const { ada } = await workspace();
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "Project/Alpha", description: "" })).toEqual({ name: "Project/Alpha", description: null });
    expect(await tags(ada)).toEqual([{ name: "Money", notes: 1 }, { name: "Project/Alpha", notes: 0 }, { name: "trip", notes: 1 }]);
    expect((await perform(env.DB, ada, { type: "tag.list", name: "project/alpha" })).tags).toEqual([{ name: "Project/Alpha", notes: 0 }]);

    const call = agentOf((await connectAgent(env.DB, ada.personId, "Claude")).token);
    expect((await call("create_note", { text: "# Kickoff\n\n#project/alpha starts" })).isError).toBe(false);
    expect((await tags(ada)).find((t) => t.name.toLowerCase() === "project/alpha")).toEqual({ name: "project/alpha", notes: 1 });

    await perform(env.DB, ada, { type: "tag.describe", name: "Later", description: "Someday" });
    await perform(env.DB, ada, { type: "tag.describe", name: "Later", description: "" });
    expect((await tags(ada)).find((t) => t.name === "Later")).toEqual({ name: "Later", notes: 0 });
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "later", description: null })).toEqual({ name: "later", description: null });
    expect((await tags(ada)).map((t) => t.name)).toEqual(["Money", "project/alpha", "trip"]);
    // Emptied on a tag a note has, nothing of it is kept, so it goes with the last note that has it.
    await perform(env.DB, ada, { type: "tag.describe", name: "trip", description: "" });
    expect(await env.DB.prepare("SELECT tag FROM tag_descriptions WHERE workspace_id = ?").bind(ada.workspaceId).all()).toMatchObject({ results: [{ tag: "project/alpha" }] });
  });

  it("forgotten, goes only from a tag no note has, and a tag a note has keeps it", async () => {
    const { ada, budget } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "Bills" });
    await perform(env.DB, ada, { type: "tag.describe", name: "later", description: "" });
    for (const name of ["money", "later"]) expect(await perform(env.DB, ada, { type: "tag.describe", name, description: null })).toEqual({ name, description: null });
    expect(await tags(ada)).toEqual([
      { name: "Money", notes: 1, description: "Bills" },
      { name: "trip", notes: 1 },
    ]);

    // A note in Trash has no tags.
    await perform(env.DB, ada, { type: "note.trash", id: budget.id });
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: null });
    expect(await tags(ada)).toEqual([{ name: "trip", notes: 1 }]);
  });

  it("forgotten, stays on a tag only an archived note has, or a note the asker can't see, and the answer is the same", async () => {
    const { ada, budget } = await workspace();
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "Bills" });
    await perform(env.DB, ada, { type: "note.archive", id: budget.id, archived: true });
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: null });
    expect((await tags(ada)).find((t) => t.name === "Money")).toEqual({ name: "Money", notes: 1, description: "Bills" });

    const bob = await addMember(ada, "editor", "Bob");
    const diary = await perform(env.DB, bob, { type: "note.create", text: "# Diary\n\n#secret" });
    await perform(env.DB, bob, { type: "note.setPrivate", id: diary.id, private: true });
    await perform(env.DB, ada, { type: "tag.describe", name: "secret", description: "Not for Ada" });
    expect((await tags(ada)).find((t) => t.name === "secret")).toEqual({ name: "secret", notes: 0, description: "Not for Ada" });
    expect(await perform(env.DB, ada, { type: "tag.describe", name: "secret", description: null })).toEqual({ name: "secret", description: null });
    expect((await tags(bob)).find((t) => t.name === "secret")).toEqual({ name: "secret", notes: 1, description: "Not for Ada" });
  });

  it("is said by an admin or an editor, and refused to a viewer and a guest, who still read it", async () => {
    const { ada, budget } = await workspace();
    const editor = await addMember(ada, "editor", "Ed");
    const viewer = await addMember(ada, "viewer", "Vera");
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", noteId: budget.id, email: guestEmail, access: "edit" });
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email: guestEmail, name: "Gus" })).personId, workspaceId: ada.workspaceId };

    expect(await refusal(perform(env.DB, editor, { type: "tag.describe", name: "money", description: "Bills" }))).toBe("done");
    await perform(env.DB, ada, { type: "tag.describe", name: "trip", description: "Where we go" });
    expect(await refusal(perform(env.DB, viewer, { type: "tag.describe", name: "money", description: "Mine" }))).toBe("forbidden: A viewer can't tag.describe");
    expect(await refusal(perform(env.DB, guest, { type: "tag.describe", name: "money", description: "Mine" }))).toMatch(/^forbidden: /);
    expect(await tags(viewer)).toEqual([{ name: "Money", notes: 1, description: "Bills" }, { name: "trip", notes: 1, description: "Where we go" }]);
    // A tag made ahead is the workspace's, which a guest isn't told of.
    await perform(env.DB, ada, { type: "tag.describe", name: "Payroll", description: "" });
    expect(await tags(guest)).toEqual([{ name: "Money", notes: 1, description: "Bills" }]);
    expect((await tags(viewer)).map((t) => t.name)).toEqual(["Money", "Payroll", "trip"]);
  });

  it("is refused for what isn't a tag's name, and over 500 characters", async () => {
    const { ada } = await workspace();
    expect(await refusal(perform(env.DB, ada, { type: "tag.describe", name: "12", description: "Numbers" }))).toMatch(/^invalid: .*not a tag's name/s);
    expect(await refusal(perform(env.DB, ada, { type: "tag.describe", name: "two words", description: "No" }))).toMatch(/^invalid: .*not a tag's name/s);
    expect(await refusal(perform(env.DB, ada, { type: "tag.describe", name: "money", description: "x".repeat(501) }))).toMatch(/^invalid: /);
    expect(await refusal(perform(env.DB, ada, { type: "tag.describe", name: "q4/plans-2", description: "x".repeat(500) }))).toBe("done");
  });

  it("is read by an agent with list_tags and said with describe_tag, and the ink command does the same", async () => {
    const { ada } = await workspace();
    const { token } = await connectAgent(env.DB, ada.personId, "Claude");
    const call = agentOf(token);
    expect(JSON.parse((await call("describe_tag", { name: "money", description: "Bills" })).text)).toEqual({ name: "money", description: "Bills" });
    expect(JSON.parse((await call("list_tags")).text).tags).toEqual([{ name: "Money", notes: 1, description: "Bills" }, { name: "trip", notes: 1 }]);

    const said: string[] = [];
    const io = { env: { INK_TOKEN: token, INK_URL: "https://ink.test" }, stdin: async () => "", out: (line: string) => said.push(line), fetch: send as unknown as typeof fetch };
    expect(await run(["tag-describe", "trip", "--description", "Travel"], io)).toBe(0);
    expect((await tags(ada)).find((t) => t.name === "trip")).toEqual({ name: "trip", notes: 1, description: "Travel" });

    const readOnly = agentOf((await connectAgent(env.DB, ada.personId, "Reader", { readOnly: true })).token);
    expect(await readOnly("describe_tag", { name: "money", description: "Mine" })).toEqual({ isError: true, text: "forbidden: A read-only token can't tag.describe" });
  });

  it("counts each note once beside it, whatever case the notes write the tag in, and pages and narrows to one tag with it", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "note.create", text: "# Rent\n\n#money" });
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "Bills" });
    await perform(env.DB, ada, { type: "tag.describe", name: "trip", description: "Travel" });
    const first = await perform(env.DB, ada, { type: "tag.list", limit: 1 });
    expect(first.tags).toEqual([{ name: "Money", notes: 2, description: "Bills" }]);
    expect((await perform(env.DB, ada, { type: "tag.list", limit: 1, after: first.next! })).tags).toEqual([{ name: "trip", notes: 1, description: "Travel" }]);
    expect((await perform(env.DB, ada, { type: "tag.list", name: "#TRIP" })).tags).toEqual([{ name: "trip", notes: 1, description: "Travel" }]);
    expect((await perform(env.DB, ada, { type: "tag.list", name: "nothing" })).tags).toEqual([]);
  });

  it("is each workspace's own, and keeps who last said it and through which agent", async () => {
    const { ada } = await workspace();
    const grace = await newMember("Grace Hopper");
    await perform(env.DB, grace, { type: "note.create", text: "# Hers\n\n#money" });
    await perform(env.DB, ada, { type: "tag.describe", name: "money", description: "Ada's bills" });
    expect(await tags(grace)).toEqual([{ name: "money", notes: 1 }]);

    const row = () => env.DB.prepare("SELECT description, updated_by, updated_via FROM tag_descriptions WHERE workspace_id = ? AND tag = 'money'").bind(ada.workspaceId).first();
    expect(await row()).toEqual({ description: "Ada's bills", updated_by: ada.personId, updated_via: null });
    const { agent, token } = await connectAgent(env.DB, ada.personId, "Claude");
    await agentOf(token)("describe_tag", { name: "money", description: "Bills, said by Claude" });
    expect(await row()).toEqual({ description: "Bills, said by Claude", updated_by: ada.personId, updated_via: agent.id });
  });
});
