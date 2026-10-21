import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform } from "../../src/core/operations.ts";
import { tagsAdded } from "../../src/core/todos.ts";
import worker from "../../src/worker/index.ts";
import { newMember } from "./members.ts";

const MCP = "https://ink.test/mcp";
const send = (url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env);

/** An agent as a client sees the server: tools/call answered with text. */
function agentOf(token: string) {
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = await send(MCP, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: result.content[0]!.text, isError: !!result.isError };
  };
}

/** Ada's workspace, where she tagged a note #money, and an agent of hers. */
async function workspace() {
  const ada = await newMember();
  const money = await perform(env.DB, ada, { type: "note.create", text: "# Budget\n\nRent #money" });
  const { token } = await connectAgent(env.DB, ada.personId, "Claude");
  return { ada, money, token, call: agentOf(token) };
}

const tagNames = async (ada: Awaited<ReturnType<typeof workspace>>["ada"]) => (await perform(env.DB, ada, { type: "tag.list", includeArchived: true })).tags.map((t) => t.name);

describe("the tags a write adds", () => {
  it("are the ones its text has and the text before didn't, ignoring case and code", () => {
    expect(tagsAdded("# Plan #Money #trip\n\n`#inline`\n\n```\n#fenced\n```\n#trip #12", "Old #money")).toEqual(["trip"]);
    expect(tagsAdded("#a #b", "")).toEqual(["a", "b"]);
    expect(tagsAdded("#a", "#A #b")).toEqual([]);
  });
});

describe("an agent's write that brings in a tag no note it can see has", () => {
  it("is refused, naming the new tags and how to make them, and writes nothing", async () => {
    const { ada, call } = await workspace();
    expect(await call("create_note", { text: "# Trip\n\n#MONEY #Travel #paris" })).toEqual({
      isError: true,
      text: 'invalid: #Travel, #paris are new tags: no note you can see has them. Use a tag list_tags lists, or if your member asked for these, pass newTags: ["Travel","paris"]',
    });
    expect((await perform(env.DB, ada, { type: "note.list" })).notes.map((n) => n.title)).toEqual(["Budget"]);
    expect(await tagNames(ada)).toEqual(["money"]);
  });

  it("goes through when newTags names each new tag, ignoring case, and the tag is then one to reuse", async () => {
    const { ada, call } = await workspace();
    expect((await call("create_note", { text: "# Trip\n\n#money #Travel #paris", newTags: ["travel"] })).text).toBe(
      'invalid: #paris is a new tag: no note you can see has it. Use a tag list_tags lists, or if your member asked for this one, pass newTags: ["paris"]',
    );
    const made = JSON.parse((await call("create_note", { text: "# Trip\n\n#money #Travel #paris", newTags: ["travel", "Paris"] })).text);
    expect(made.text).toBe("# Trip\n\n#money #Travel #paris");
    expect(await tagNames(ada)).toEqual(["money", "paris", "Travel"]);
    expect((await call("create_note", { text: "# Hotel\n\n#travel" })).isError).toBe(false);
  });

  it("is refused by write_note and edit_note too, while the tags the note had stay free to keep and move", async () => {
    const { money, call } = await workspace();
    const refusal = 'invalid: #rent is a new tag: no note you can see has it. Use a tag list_tags lists, or if your member asked for this one, pass newTags: ["rent"]';
    expect((await call("write_note", { noteId: money.id, baseRevision: 1, text: "# Budget\n\nRent #money #rent" })).text).toBe(refusal);
    expect((await call("edit_note", { noteId: money.id, baseRevision: 1, edits: [{ from: 1, to: 1, text: "#rent" }] })).text).toBe(refusal);
    const kept = JSON.parse((await call("write_note", { noteId: money.id, baseRevision: 1, text: "# Budget\n\n#Money first\n\nRent" })).text);
    expect(kept.revision).toBe(2);
    const edited = JSON.parse((await call("edit_note", { noteId: money.id, baseRevision: 2, edits: [{ from: 1, to: 1, text: "#rent" }], newTags: ["rent"] })).text);
    expect(edited.revision).toBe(3);
  });

  it("is answered as recorded when sent again with its writeId, without newTags", async () => {
    const { money, call } = await workspace();
    const made = JSON.parse((await call("create_note", { text: "# Trip\n\n#travel", newTags: ["#travel"], writeId: "trip-1" })).text);
    expect(JSON.parse((await call("create_note", { text: "# Trip\n\n#travel #paris", writeId: "trip-1" })).text).id).toBe(made.id);
    await call("write_note", { noteId: money.id, baseRevision: 1, text: "# Budget\n\n#rent", newTags: ["rent"], writeId: "rent-1" });
    expect(JSON.parse((await call("write_note", { noteId: money.id, baseRevision: 1, text: "# Budget\n\n#rent #paris", writeId: "rent-1" })).text).revision).toBe(2);
  });

  it("counts a tag the note had at baseRevision as there, though it was taken out of every note since", async () => {
    const { ada, money, call } = await workspace();
    await perform(env.DB, ada, { type: "note.write", id: money.id, baseRevision: 1, text: "# Budget\n\nRent" });
    expect(await tagNames(ada)).toEqual([]);
    const merged = JSON.parse((await call("write_note", { noteId: money.id, baseRevision: 1, text: "# Budget\n\nRent #money\n\nFood #money" })).text);
    expect(merged.text).toBe("# Budget\n\nRent\n\nFood #money");
  });

  it("is refused by set_todo's words, unless newTags names the tag", async () => {
    const { ada, call } = await workspace();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Errands\n\n- [ ] Call the bank" });
    const todo = { noteId: note.id, revision: 1, line: 2, text: "- [ ] Call the bank" };
    expect((await call("set_todo", { ...todo, words: "Call the bank #money #urgent" })).text).toBe(
      'invalid: #urgent is a new tag: no note you can see has it. Use a tag list_tags lists, or if your member asked for this one, pass newTags: ["urgent"]',
    );
    expect(JSON.parse((await call("set_todo", { ...todo, words: "Call the bank #money #urgent", newTags: ["urgent"] })).text).text).toBe("# Errands\n\n- [ ] Call the bank #money #urgent");
    expect(JSON.parse((await call("set_todo", { ...todo, words: "Call the bank #money #urgent" })).text).revision, "sent again once it was done, it is answered as done").toBe(2);
  });

  it("counts a tag of an archived note as there, and not one of a note in Trash", async () => {
    const { ada, call } = await workspace();
    const old = await perform(env.DB, ada, { type: "note.create", text: "# Old\n\n#archive-me" });
    await perform(env.DB, ada, { type: "note.archive", id: old.id, archived: true });
    const binned = await perform(env.DB, ada, { type: "note.create", text: "# Binned\n\n#binned" });
    await perform(env.DB, ada, { type: "note.trash", id: binned.id });
    expect((await call("create_note", { text: "# A\n\n#archive-me" })).isError).toBe(false);
    expect((await call("create_note", { text: "# B\n\n#binned" })).text).toMatch(/^invalid: #binned is a new tag/);
  });

  it("counts only the notes an agent limited to folders can see, so a tag elsewhere tells it nothing", async () => {
    const { ada } = await workspace();
    const projects = (await perform(env.DB, ada, { type: "folder.create", name: "Projects" })).id;
    await perform(env.DB, ada, { type: "note.create", text: "# Roadmap\n\n#roadmap", folderId: projects });
    const { token } = await connectAgent(env.DB, ada.personId, "Scoped", { workspaceId: ada.workspaceId, folderIds: [projects] });
    const call = agentOf(token);
    expect((await call("create_note", { text: "# Q4\n\n#roadmap", folderId: projects })).isError).toBe(false);
    expect((await call("create_note", { text: "# Rent\n\n#money", folderId: projects })).text).toMatch(/^invalid: #money is a new tag/);
  });

  it("is never refused for a person, who makes a tag by writing it", async () => {
    const { ada } = await workspace();
    await perform(env.DB, ada, { type: "note.create", text: "# Mine\n\n#brand-new" });
    expect(await tagNames(ada)).toEqual(["brand-new", "money"]);
  });

  it("is refused to the ink command the same way, and goes through with --new-tags", async () => {
    const { ada, token } = await workspace();
    const said: string[] = [];
    const io = { env: { INK_TOKEN: token, INK_URL: "https://ink.test" }, stdin: async () => "", out: (line: string) => said.push(line), fetch: send as unknown as typeof fetch };
    expect(await run(["create", "--text", "# Gym\n\n#fitness"], io)).toBe(1);
    expect(said.at(-1)).toBe('invalid: #fitness is a new tag: no note you can see has it. Use a tag list_tags lists, or if your member asked for this one, pass newTags: ["fitness"]');
    expect(await run(["create", "--text", "# Gym\n\n#fitness", "--new-tags", "fitness"], io)).toBe(0);
    expect(await tagNames(ada)).toEqual(["fitness", "money"]);
  });
});
