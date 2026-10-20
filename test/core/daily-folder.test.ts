import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { addMember, newMember } from "./members.ts";

const SUNDAY = "2026-10-11";
const MONDAY = "2026-10-12";

const pick = (as: Actor, folder: string) => perform(env.DB, as, { type: "settings.write", text: JSON.stringify({ "daily.folder": folder }), baseRevision: 0 });
const folderOf = async (as: Actor, day: string) => {
  const note = await perform(env.DB, as, { type: "daily.open", on: day });
  const folder = (await perform(env.DB, as, { type: "folder.list" })).folders.find((f) => f.id === note.folderId)!;
  return { noteId: note.id, folderId: folder.id, path: folder.path };
};
const agentOf = async (member: Actor): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, "Claude")).agent.id, personId: member.personId, workspaceId: member.workspaceId });

describe("the folder a member's settings pick for daily notes", () => {
  it("is the folder picked by id, nested ones too, for the member and for their agent", async () => {
    const ada = await newMember();
    const projects = await perform(env.DB, ada, { type: "folder.create", name: "Projects" });
    const journal = await perform(env.DB, ada, { type: "folder.create", name: "Journal", parentId: projects.id });
    await pick(ada, journal.id);

    const hers = await folderOf(ada, SUNDAY);
    const note = await perform(env.DB, ada, { type: "note.create", text: "- [ ] Stretch every:1d" });
    const done = await perform(env.DB, await agentOf(ada), { type: "todo.set", id: note.id, revision: 1, line: 0, text: "- [ ] Stretch every:1d", done: true, on: MONDAY });

    expect([hers.folderId, hers.path]).toEqual([journal.id, "Projects/Journal"]);
    expect((await perform(env.DB, ada, { type: "note.read", id: done.filed!.dailyNoteId! })).folderId).toBe(journal.id);
  });

  it("is a folder at the top by the name the setting once held, made when it isn't there", async () => {
    const ada = await newMember();
    await pick(ada, "Journal");

    expect((await folderOf(ada, SUNDAY)).path).toBe("Journal");
    expect((await folderOf(ada, MONDAY)).path).toBe("Journal");
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.filter((f) => f.name === "Journal")).toHaveLength(1);
  });

  it("is the folder at the top by a name the setting once held that is shaped like an id", async () => {
    const ada = await newMember();
    const meetings = await perform(env.DB, ada, { type: "folder.create", name: "MeetingNotes" });
    await pick(ada, "meetingnotes");

    expect((await folderOf(ada, SUNDAY)).folderId).toBe(meetings.id);
  });

  it("is Daily at the top when the folder picked is gone, or never was", async () => {
    const ada = await newMember();
    const gone = await perform(env.DB, ada, { type: "folder.create", name: "Gone" });
    await perform(env.DB, ada, { type: "folder.delete", id: gone.id });
    await pick(ada, gone.id);

    expect((await folderOf(ada, SUNDAY)).path).toBe("Daily");

    const eve = await addMember(ada, "editor", "Eve");
    await pick(eve, "zzzzzzzzzzzz");
    expect((await folderOf(eve, SUNDAY)).path).toBe("Daily");
    expect((await perform(env.DB, ada, { type: "folder.list" })).folders.map((f) => f.path).sort()).toEqual(["Daily", "Unsorted"]);
  });

  it("is Daily at the top when the member can no longer edit the folder picked", async () => {
    const ada = await newMember();
    const ned = await addMember(ada, "editor", "Ned");
    const nedEmail = (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(ned.personId).first<{ email: string }>())!.email;
    const team = await perform(env.DB, ada, { type: "folder.create", name: "Team" });
    await pick(ned, team.id);
    await perform(env.DB, ada, { type: "grant.set", folderId: team.id, email: nedEmail, access: "view" });

    expect((await folderOf(ned, SUNDAY)).path).toBe("Daily");
  });

  it("leaves the daily notes already made where they are when it changes", async () => {
    const ada = await newMember();
    const sunday = await folderOf(ada, SUNDAY);
    const journal = await perform(env.DB, ada, { type: "folder.create", name: "Journal" });
    await pick(ada, journal.id);

    expect(await folderOf(ada, SUNDAY)).toEqual(sunday);
    expect(sunday.path).toBe("Daily");
    expect((await folderOf(ada, MONDAY)).folderId).toBe(journal.id);
  });
});
