import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { whoAmI } from "../../src/core/accounts.ts";
import { connectAgent, disconnectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { OpInput, OpType, Role } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { TOOLS } from "../../src/worker/mcp/tools.ts";
import { addMember, newMember } from "./members.ts";

const post = (path: string, token: string, body: unknown) =>
  worker.fetch(
    new Request(`https://ink.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://ink.test", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }) as never,
    env,
  );

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await post("/mcp", token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (res.status !== 200) return { status: res.status, text: "", isError: true };
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { status: 200, text: result.content[0]!.text, isError: !!result.isError };
};


/** Ada's workspace with a note and a folder in it, and a member with `role` who connected an agent. */
async function team(role: Role) {
  const ada = await newMember("Ada Lovelace");
  const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" });
  await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan\n\nStep" });
  const folder = await perform(env.DB, ada, { type: "folder.create", name: "Plans" });
  const member = await addMember(ada, role);
  const { agent, token } = await connectAgent(env.DB, member.personId, "Claude");
  return { ada, member, agent, token, noteId: note.id, folderId: folder.id, workspace: ada.workspaceId };
}

/** The operations an agent has a tool for. Settings and changes to members are kept from agents, which test/core/settings.test.ts and test/core/members.test.ts check. */
type ToolOp = Exclude<OpType, `settings.${string}` | `invite.${string}` | "member.invite" | "member.setRole" | "member.remove" | "member.leave">;

/** Every one of them with arguments the core accepts, so what refuses it is who is asking. */
const everyOp = (noteId: string, folderId: string): { [K in ToolOp]: Omit<Extract<OpInput, { type: K }>, "type"> } => ({
  "note.list": {},
  "note.create": { text: "# New" },
  "note.read": { id: noteId },
  "note.write": { id: noteId, baseRevision: 2, text: "# Plan\n\nStep\n\nMore" },
  "note.backlinks": { id: noteId },
  "links.rebuild": {},
  "note.history": { id: noteId },
  "note.move": { id: noteId, folderId },
  "note.label": { id: noteId, revision: 1, name: "Start" },
  "note.revert": { id: noteId, revision: 1 },
  "note.revertChanges": { id: noteId, revisions: [2] },
  "note.previewRevert": { id: noteId, revisions: [2] },
  "note.diff": { id: noteId, revision: 1 },
  "history.summary": {},
  "note.undo": { id: noteId },
  "note.redo": { id: noteId },
  "history.list": {},
  "history.authors": {},
  "history.revertAuthor": { author: { kind: "agent", id: "aaaaaaaaaaaa" } },
  "history.diff": { changes: [{ noteId, revisions: [2] }] },
  "history.previewRevert": { changes: [{ noteId, revisions: [2] }] },
  "history.revert": { changes: [{ noteId, revisions: [2] }] },
  "folder.list": {},
  "folder.create": { name: "Made by a test" },
  "folder.rename": { id: folderId, name: "Renamed" },
  "folder.delete": { id: "aaaaaaaaaaaa" },
  "member.list": {},
});

const refusedTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return false;
  } catch (err) {
    return (err as { code?: string }).code === "forbidden";
  }
};

describe("an agent's access is its member's", () => {
  const REFUSED: Record<Role, ToolOp[]> = {
    admin: [],
    editor: ["links.rebuild", "folder.delete"],
    viewer: [
      "note.create",
      "note.write",
      "links.rebuild",
      "note.move",
      "note.label",
      "note.revert",
      "note.revertChanges",
      "note.undo",
      "note.redo",
      "history.revertAuthor",
      "history.revert",
      "folder.create",
      "folder.rename",
      "folder.delete",
    ],
  };

  for (const role of ["admin", "editor", "viewer"] as const) {
    it(`for ${role === "viewer" ? "a" : "an"} ${role}: its tools are refused exactly the operations the member is`, async () => {
      const { member, token, noteId, folderId, workspace } = await team(role);
      const ops = everyOp(noteId, folderId);
      const refused: { member: ToolOp[]; agent: ToolOp[] } = { member: [], agent: [] };

      for (const type of Object.keys(ops) as ToolOp[]) {
        const name = TOOLS.find((t) => t.op === type)!.name;
        const answer = await tool(token, name, { workspace, ...ops[type] });
        if (answer.isError && answer.text.startsWith("forbidden: ")) refused.agent.push(type);
        if (await refusedTo(() => perform(env.DB, member, { type, ...ops[type] } as OpInput))) refused.member.push(type);
      }

      expect(refused.agent.sort()).toEqual([...REFUSED[role]].sort());
      expect(refused.member.sort()).toEqual(refused.agent);
    });
  }

  it("follows a change of role on its next call: an editor made a viewer, then an editor again", async () => {
    const { ada, member, token, noteId, workspace } = await team("editor");
    const setRole = (to: Actor, as: Role) => perform(env.DB, ada, { type: "member.setRole", memberId: to.personId, as });
    const write = (text: string) => tool(token, "write_note", { workspace, id: noteId, baseRevision: 2, text });

    expect(await write("# Plan\n\nStep\n\nAs an editor")).toMatchObject({ isError: false });
    await setRole(member, "viewer");
    expect(await write("# Plan\n\nStep\n\nAs a viewer")).toMatchObject({ isError: true, text: "forbidden: A viewer can't note.write" });
    expect(await tool(token, "read_note", { workspace, id: noteId })).toMatchObject({ isError: false });
    await setRole(member, "editor");
    expect(await write("# Plan\n\nStep\n\nAs an editor again")).toMatchObject({ isError: false });
  });

  it("ends with the member's: once the member is removed, every tool answers that there is no such workspace", async () => {
    const { ada, member, token, noteId, folderId, workspace } = await team("admin");
    const ops = everyOp(noteId, folderId);
    await perform(env.DB, ada, { type: "member.remove", memberId: member.personId });

    for (const type of Object.keys(ops) as ToolOp[]) {
      const name = TOOLS.find((t) => t.op === type)!.name;
      expect(await tool(token, name, { workspace, ...ops[type] }), name).toMatchObject({ isError: true, text: "not_found: No such workspace" });
    }
    expect((await perform(env.DB, ada, { type: "note.read", id: noteId })).revision).toBe(2);
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.name).sort()).toEqual(["Plans", "Unsorted"]);
  });

  it("stops at the workspace: an id from a workspace the member isn't in is not found, by any tool", async () => {
    const { token, workspace } = await team("admin");
    const grace = await newMember("Grace Hopper");
    const hers = await perform(env.DB, grace, { type: "note.create", text: "# Grace's" });
    await perform(env.DB, grace, { type: "note.write", id: hers.id, baseRevision: 1, text: "# Grace's\n\nSecret" });
    const herFolder = await perform(env.DB, grace, { type: "folder.create", name: "Hers" });
    const ops = everyOp(hers.id, herFolder.id);

    for (const type of ["note.read", "note.write", "note.history", "note.move", "note.label", "note.revert", "note.revertChanges", "note.diff", "note.undo", "note.redo", "folder.rename"] as const) {
      const name = TOOLS.find((t) => t.op === type)!.name;
      expect((await tool(token, name, { workspace, ...ops[type] })).text, name).toMatch(/^not_found: No such (note|folder)$/);
      expect((await tool(token, name, { workspace: grace.workspaceId, ...ops[type] })).text, name).toBe("not_found: No such workspace");
    }
    expect(JSON.parse((await tool(token, "history", { workspace, noteIds: [hers.id] })).text).changes).toEqual([]);
    expect(JSON.parse((await tool(token, "revert_author", { workspace, author: { kind: "member", id: grace.personId } })).text)).toEqual({ reverted: [], emptied: [], failed: [], next: null });
    expect(JSON.parse((await tool(token, "list_notes", { workspace, folderId: herFolder.id })).text)).toEqual([]);
    expect((await tool(token, "create_note", { workspace, text: "# Planted", folderId: herFolder.id })).text).toBe("not_found: No such folder");
    expect((await tool(token, "delete_folder", { workspace, id: herFolder.id })).text).toBe("not_found: No such folder");
    expect((await perform(env.DB, grace, { type: "note.read", id: hers.id })).text).toBe("# Grace's\n\nSecret");
    expect((await perform(env.DB, grace, { type: "history.list" })).changes).toHaveLength(2);
  });

  it("is over the moment the agent is disconnected, in the middle of its work", async () => {
    const { member, agent, token, noteId, workspace } = await team("editor");
    expect(await tool(token, "read_note", { workspace, id: noteId })).toMatchObject({ status: 200, isError: false });

    await disconnectAgent(env.DB, member.personId, agent.id);

    expect(await tool(token, "read_note", { workspace, id: noteId })).toMatchObject({ status: 401 });
    expect(await tool(token, "write_note", { workspace, id: noteId, baseRevision: 2, text: "# Late" })).toMatchObject({ status: 401 });
    expect((await perform(env.DB, member, { type: "note.read", id: noteId })).revision).toBe(2);
  });

  it("sees who is in a workspace, within its token's reach, and has no tool that changes that", async () => {
    const { ada, member, workspace } = await team("admin");
    const everyone = [`Ada Lovelace: admin`, `Grace Hopper: admin`];
    const names = (answer: { text: string }) => (JSON.parse(answer.text) as { name: string; role: Role }[]).map((m) => `${m.name}: ${m.role}`);
    const own = (await whoAmI(env.DB, member.personId)).workspaces.find((w) => w.id !== workspace)!.id;
    const reader = await connectAgent(env.DB, member.personId, "Reader", { readOnly: true });
    const pinned = await connectAgent(env.DB, member.personId, "Pinned", { workspaceId: own });

    expect(names(await tool(reader.token, "list_members", { workspace }))).toEqual(everyone);
    expect((await tool(reader.token, "list_members", { workspace })).text, "an admin's agent is told no email").not.toContain("@");
    expect(await tool(pinned.token, "list_members", { workspace })).toMatchObject({ isError: true, text: "not_found: No such workspace" });
    expect(names(await tool(pinned.token, "list_members"))).toEqual(["Grace Hopper: admin"]);
    expect(TOOLS.filter((t) => /member|invite|leave/.test(t.name)).map((t) => t.name)).toEqual(["list_members"]);

    await perform(env.DB, ada, { type: "member.remove", memberId: member.personId });
    expect(await tool(reader.token, "list_members", { workspace })).toMatchObject({ isError: true, text: "not_found: No such workspace" });
  });

  it("is only at /mcp: a token is no session, so it can't perform operations as a member or connect another agent", async () => {
    const { token, workspace } = await team("admin");

    expect((await post(`/api/workspaces/${workspace}/ops`, token, { type: "note.list" })).status).toBe(401);
    expect((await post("/api/agents", token, { name: "Another" })).status).toBe(401);
  });
});
