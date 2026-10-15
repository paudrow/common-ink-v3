import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { Blame } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 14, 9);
const MINUTE = 60_000;

const write = async (actor: Actor, id: string, text: string, now?: number) => {
  const { revision } = await perform(env.DB, actor, { type: "note.read", id });
  return perform(env.DB, actor, { type: "note.write", id, baseRevision: revision, text }, now);
};

/** Each line of the note with who wrote it, as a reader of the answer puts them together. */
function byLine(blamed: Blame): string[] {
  const lines = blamed.text.split("\n");
  const changes = new Map(blamed.changes.map((c) => [c.revision, c]));
  return blamed.lines.flatMap((run) => lines.slice(run.from - 1, run.to).map((line) => `${changes.get(run.revision)!.author.name}: ${line}`));
}

const mcp = async (token: string, args: Record<string, unknown>) => {
  const res = await worker.fetch(
    new Request("https://ink.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "note_blame", arguments: args } }),
    }) as never,
    env,
  );
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: !!result.isError, text: result.content[0]!.text };
};

/** A plan Ada started, Ed and Ada's agent added to, and Ed edited a line of Ada's in. */
async function plan() {
  const ada = await newMember("Ada Lovelace");
  const ed = await addMember(ada, "editor", "Ed Editor");
  const folder = (await perform(env.DB, ada, { type: "folder.create", name: "Plans" })).id;
  const { agent, token } = await connectAgent(env.DB, ada.personId, "Scribe");
  const scribe: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
  const note = await perform(env.DB, ada, { type: "note.create", folderId: folder, text: "# Plan\n\nAda's step" }, T0);
  await write(ed, note.id, "# Plan\n\nAda's step\n\nEd's step", T0 + MINUTE);
  await write(scribe, note.id, "# Plan\n\nAda's step\n\nEd's step\n\nScribe's step", T0 + 2 * MINUTE);
  await write(ed, note.id, "# Plan\n\nAda's step, done\n\nEd's step\n\nScribe's step", T0 + 3 * MINUTE);
  return { ada, ed, scribe, token, agent, folder, id: note.id };
}

describe("who wrote this", () => {
  it("names who last wrote or edited each line, with the changes it names and when they were made", async () => {
    const { ada, ed, agent, id } = await plan();
    const blamed = await perform(env.DB, ada, { type: "note.blame", id });
    expect(byLine(blamed)).toEqual(["Ada Lovelace: # Plan", "Ada Lovelace: ", "Ed Editor: Ada's step, done", "Ed Editor: ", "Ed Editor: Ed's step", "Scribe: ", "Scribe: Scribe's step"]);
    expect(blamed.revision).toBe(4);
    expect(blamed.lines).toEqual([
      { from: 1, to: 2, revision: 1 },
      { from: 3, to: 3, revision: 4 },
      { from: 4, to: 5, revision: 2 },
      { from: 6, to: 7, revision: 3 },
    ]);
    expect(blamed.changes.map((c) => [c.revision, c.author, c.createdAt])).toEqual([
      [1, { kind: "member", personId: ada.personId, name: "Ada Lovelace" }, T0],
      [2, { kind: "member", personId: ed.personId, name: "Ed Editor" }, T0 + MINUTE],
      [3, { kind: "agent", agentId: agent.id, name: "Scribe", onBehalfOf: ada.personId }, T0 + 2 * MINUTE],
      [4, { kind: "member", personId: ed.personId, name: "Ed Editor" }, T0 + 3 * MINUTE],
    ]);
    expect(blamed.owners).toEqual({ [ada.personId]: "Ada Lovelace" });
  });

  it("names a line a revert brought back by whoever wrote it, member or agent, and not by who reverted", async () => {
    const { ada, ed, id } = await plan();
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [4] });
    await write(ed, id, "# Plan\n\nAda's step\n\nEd's step", T0 + 5 * MINUTE);
    await perform(env.DB, ed, { type: "note.revertChanges", id, revisions: [6] });
    const blamed = await perform(env.DB, ada, { type: "note.blame", id });
    expect(byLine(blamed)).toEqual(["Ada Lovelace: # Plan", "Ada Lovelace: ", "Ada Lovelace: Ada's step", "Ed Editor: ", "Ed Editor: Ed's step", "Scribe: ", "Scribe: Scribe's step"]);
    expect(blamed.lines).toEqual([
      { from: 1, to: 3, revision: 1 },
      { from: 4, to: 5, revision: 2 },
      { from: 6, to: 7, revision: 3 },
    ]);
    expect(blamed.changes.map((c) => c.revision)).toEqual([1, 2, 3]);
  });

  it("has no lines for a note with no text", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create" });
    expect(await perform(env.DB, ada, { type: "note.blame", id: note.id })).toEqual({ revision: 0, text: "", lines: [], changes: [], owners: {} });
  });

  it("tells a guest who wrote the note they were given, and not whose agent wrote it", async () => {
    const { ada, id } = await plan();
    const email = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", noteId: id, email, access: "view" });
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
    const blamed = await perform(env.DB, guest, { type: "note.blame", id });
    expect(byLine(blamed)).toContain("Scribe: Scribe's step");
    expect(blamed.owners).toEqual({});
  });

  it("answers an agent limited to folders for the notes in them only, and doesn't tell it whose agents wrote them", async () => {
    const { ada, folder, id } = await plan();
    const other = (await perform(env.DB, ada, { type: "folder.create", name: "Elsewhere" })).id;
    const outside = await perform(env.DB, ada, { type: "note.create", folderId: other, text: "# Elsewhere" });
    const { token } = await connectAgent(env.DB, ada.personId, "Limited", { workspaceId: ada.workspaceId, folderIds: [folder] });
    const inside = await mcp(token, { id });
    expect(inside.isError).toBe(false);
    expect(JSON.parse(inside.text)).toMatchObject({ revision: 4, owners: {} });
    expect(await mcp(token, { id: outside.id })).toEqual({ isError: true, text: expect.stringContaining("No such note") });
  });

  it("gives an agent the same answer through its tool as the app gets", async () => {
    const { ada, token, id } = await plan();
    const answer = await mcp(token, { id });
    expect(JSON.parse(answer.text)).toEqual(await perform(env.DB, ada, { type: "note.blame", id }));
  });
});
