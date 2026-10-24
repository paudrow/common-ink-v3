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

/** The operations an agent has a tool for. Settings, changes to members, sharing, removing a note for good, marking changes read, a plugin's frame, turning full trust on, renaming or deleting a tag, writing the agents file, transcribing and its vocabulary, and deleting an account or a workspace are kept from agents, which test/core/tag-rename.test.ts, test/core/agents-file.test.ts, test/core/transcribe.test.ts, test/core/settings.test.ts, test/core/members.test.ts, test/core/grants.test.ts, test/core/lifecycle.test.ts, test/core/dashboard.test.ts, test/core/third-party.test.ts and test/core/erase.test.ts check. An upload's bytes go over HTTP, which test/core/upload-http.test.ts and test/core/upload-parts.test.ts check, as an export's do, which test/core/export.test.ts checks, and a workspace's storage is for its members. */
type ToolOp = Exclude<OpType, "note.purge" | "note.discard" | "note.hold" | "note.linkDates" | "note.convertLinks" | `settings.${string}` | "timeZone.record" | `invite.${string}` | "member.invite" | "member.setRole" | "member.remove" | "member.leave" | "member.signOut" | `grant.${string}` | "note.setPrivate" | `shared.${string}` | "source.connect" | "source.disconnect" | "upload.create" | "upload.open" | "export.open" | "upload.part" | "upload.storage" | "upload.purge" | "upload.setPrivate" | "visit.mark" | "contact.update" | "contact.photo" | "contact.create" | "contact.duplicates" | "contact.dismiss" | "contact.combine" | "contact.merge" | "contact.merges" | "contact.restore" | "plugin.frame" | "plugin.trust" | "plugin.decide" | `account.${string}` | "workspace.delete" | "tag.rename" | "tag.delete" | "agentsFile.write" | "email.senders" | "email.addSender" | "email.removeSender" | "upload.transcribe" | `vocabulary.${string}`>;

/** Every one of them with arguments the core accepts, so what refuses it is who is asking. */
const everyOp = (noteId: string, folderId: string): { [K in ToolOp]: Omit<Extract<OpInput, { type: K }>, "type"> } => ({
  "agentsFile.read": {},
  "note.list": {},
  "note.create": { text: "# New" },
  "note.read": { id: noteId },
  "note.write": { id: noteId, baseRevision: 2, text: "# Plan\n\nStep\n\nMore" },
  "note.edit": { id: noteId, baseRevision: 2, edits: [{ from: 2, to: 3, text: "edited" }] },
  "note.backlinks": { id: noteId },
  "links.rebuild": {},
  "todo.list": {},
  "todo.filters": {},
  "todo.set": { id: noteId, revision: 2, line: 0, text: "- [ ] not there", done: true },
  "todo.history": { id: noteId, revision: 2, line: 0, text: "- [ ] not there" },
  "todos.rebuild": {},
  "daily.open": {},
  "daily.find": {},
  "pin.list": {},
  "pin.set": { id: noteId, pinned: true },
  "visit.read": {},
  "note.history": { id: noteId },
  "note.move": { id: noteId, folderId },
  "note.label": { id: noteId, revision: 1, name: "Start" },
  "tag.describe": { name: "plans", description: "For plans." },
  "note.revert": { id: noteId, revision: 1 },
  "note.revertChanges": { id: noteId, revisions: [2] },
  "note.previewRevert": { id: noteId, revisions: [2] },
  "note.diff": { id: noteId, revision: 1 },
  "note.blame": { id: noteId },
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
  "folder.find": { path: "plans" },
  "folder.create": { name: "Made by a test" },
  "folder.rename": { id: folderId, name: "Renamed" },
  "folder.describe": { id: folderId, description: "For plans." },
  "folder.move": { id: folderId, parentId: null },
  "folder.delete": { id: "aaaaaaaaaaaa" },
  "member.list": {},
  "tag.list": {},
  search: { query: "plan" },
  "note.archive": { id: noteId, archived: false },
  "trash.list": {},
  "note.trash": { id: noteId },
  "note.restore": { id: noteId },
  "source.list": {},
  "event.list": { from: 0, to: 1, timeZone: "UTC" },
  "event.update": { sourceId: "google-calendar", id: "none", etag: "none", title: "No" },
  "event.create": { sourceId: "google-calendar", calendarId: "none", title: "No", when: { allDay: true, from: "2026-10-14", to: "2026-10-14" } },
  "contact.list": {},
  "email.list": {},
  "email.thread": { sourceId: "email", id: "none" },
  "person.read": { who: "Sam Okafor" },
  "record.refer": { sourceId: "google-calendar", id: "none" },
  "record.read": { ref: "aaaaaaaaaaaa" },
  "upload.list": {},
  "upload.read": { id: "aaaaaaaaaaaa" },
  "upload.move": { id: "aaaaaaaaaaaa", folderId },
  "upload.place": { id: "aaaaaaaaaaaa", noteId },
  "upload.archive": { id: "aaaaaaaaaaaa", archived: false },
  "upload.trash": { id: "aaaaaaaaaaaa" },
  "upload.restore": { id: "aaaaaaaaaaaa" },
  "upload.trashed": {},
  "upload.start": { name: "a.txt", size: 3, folderId },
  "upload.resume": { id: "aaaaaaaaaaaa" },
  "upload.finish": { id: "aaaaaaaaaaaa" },
  "upload.abort": { id: "aaaaaaaaaaaa" },
  "export.plan": {},
  "record.notes": { sourceId: "google-calendar", id: "none" },
  "plugin.list": {},
  // Each is asked of a plugin that isn't there, or of a manifest that is no plugin's, so what refuses it is the role and nothing else.
  "plugin.read": { id: "aaaaaaaaaaaa" },
  "plugin.install": { manifest: "{}", code: "" },
  "plugin.uninstall": { id: "aaaaaaaaaaaa" },
  "plugin.permit": { id: "aaaaaaaaaaaa", capability: "notes.read", allowed: false },
  "plugin.request": { id: "aaaaaaaaaaaa", capability: "notes.read" },
  "plugin.proposals": {},
  "plugin.scaffold": { name: "Greeter" },
  "plugin.validate": { manifest: "{}", code: "" },
  "draft.list": {},
  "draft.read": { id: "aaaaaaaaaaaa" },
  "draft.save": { id: "aaaaaaaaaaaa", manifest: "{}", code: "", running: false },
  "draft.discard": { id: "aaaaaaaaaaaa" },
});

const refusedTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return false;
  } catch (err) {
    return (err as { code?: string }).code === "forbidden";
  }
};

// Each role's test asks every operation, as its agent and as its member, so it grows with each operation added and has outgrown the default five seconds on CI.
describe("an agent's access is its member's", { timeout: 30_000 }, () => {
  const REFUSED: Record<Role, ToolOp[]> = {
    admin: [],
    editor: ["links.rebuild", "todos.rebuild", "folder.delete", "plugin.install", "plugin.uninstall", "plugin.permit"],
    viewer: [
      "note.create",
      "note.write",
      "note.edit",
      "links.rebuild",
      "todo.set",
      "tag.describe",
      "todos.rebuild",
      "daily.open",
      "note.move",
      "note.archive",
      "note.trash",
      "note.restore",
      "upload.move",
      "upload.place",
      "upload.archive",
      "upload.trash",
      "upload.restore",
      "upload.start",
      "upload.resume",
      "upload.finish",
      "upload.abort",
      "note.label",
      "note.revert",
      "note.revertChanges",
      "note.undo",
      "note.redo",
      "history.revertAuthor",
      "history.revert",
      "folder.create",
      "folder.rename",
      "folder.describe",
      "folder.move",
      "folder.delete",
      "plugin.install",
      "plugin.uninstall",
      "plugin.permit",
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

    for (const type of ["note.read", "note.write", "note.history", "note.move", "note.label", "note.revert", "note.revertChanges", "note.diff", "note.undo", "note.redo", "folder.rename", "folder.describe", "pin.set"] as const) {
      const name = TOOLS.find((t) => t.op === type)!.name;
      expect((await tool(token, name, { workspace, ...ops[type] })).text, name).toMatch(/^not_found: No such (note|folder)$/);
      expect((await tool(token, name, { workspace: grace.workspaceId, ...ops[type] })).text, name).toBe("not_found: No such workspace");
    }
    expect(JSON.parse((await tool(token, "history", { workspace, noteIds: [hers.id] })).text).changes).toEqual([]);
    expect(JSON.parse((await tool(token, "revert_author", { workspace, author: { kind: "member", id: grace.personId } })).text)).toEqual({ reverted: [], emptied: [], failed: [], next: null });
    expect(JSON.parse((await tool(token, "list_notes", { workspace, folderId: herFolder.id })).text).notes).toEqual([]);
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
