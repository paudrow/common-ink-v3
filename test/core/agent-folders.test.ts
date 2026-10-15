import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import { signIn } from "../../src/core/accounts.ts";
import { authenticateAgent, connectAgent, editAgent, listAgents } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { MAX_AGENT_FOLDERS, type Note } from "../../src/core/protocol.ts";
import type { Sources } from "../../src/core/sources.ts";
import { callTool } from "../../src/worker/mcp/tools.ts";
import { sign } from "../../src/worker/session.ts";
import { addMember, newMember } from "./members.ts";

/*
 * An agent limited to folders, attacked through the tools it is given. Whatever it asks of a note or
 * a folder outside its limit has to be answered exactly as the same question about one that was
 * never there, and nothing it is answered may hold a word of what is outside.
 */

const MISSING = "zzzzzzzzzzzz";
const NO_NOTE = { isError: true, text: "not_found: No such note" };
const NO_FOLDER = { isError: true, text: "not_found: No such folder" };

type Member = Extract<Actor, { kind: "member" }>;

/** Calls a tool as the agent the token belongs to, the way /mcp does: what the token may do is read from the token. */
async function asAgent(token: string, sources?: Sources) {
  const said: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const agent = await authenticateAgent(env.DB, token);
    const result = (await callTool(env.DB, agent!, name, args, sources))!;
    const answer = { isError: !!result.isError, text: result.content[0]!.text };
    said.push(answer.text);
    return answer;
  };
  const json = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const answer = await call(name, args);
    if (answer.isError) throw new Error(`${name}: ${answer.text}`);
    return JSON.parse(answer.text) as T;
  };
  return { call, json, said };
}

const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function world() {
  const ada = (await newMember("Ada Lovelace")) as Member;
  const folder = async (name: string, parentId?: string) => (await perform(env.DB, ada, { type: "folder.create", name, parentId })).id;
  const projects = await folder("Projects");
  const plans = await folder("Plans", projects);
  const journal = await folder("Journal");
  const empty = await folder("Vacant");
  const note = (folderId: string | undefined, text: string) => perform(env.DB, ada, { type: "note.create", folderId, text });
  const outside = await note(journal, "# Diary-outside\n\nprivate-words-outside");
  const loose = await note(undefined, "# Loose-outside\n\nunsorted-words-outside");
  const inside = await note(projects, `# Roadmap\n\nSee [[${outside.id}]] and [[${loose.id}]].`);
  const deep = await note(plans, "# Q3 plan\n\nShip it.");
  // The diary links back, so the roadmap has a backlink from outside.
  await perform(env.DB, ada, { type: "note.write", id: outside.id, baseRevision: 1, text: `# Diary-outside\n\nprivate-words-outside [[${inside.id}]]` });
  // An agent of Ada's that reaches everything, and has written on both sides of the limit.
  const scribe = await connectAgent(env.DB, ada.personId, "Scribe-everywhere");
  const asScribe: Actor = { kind: "agent", agentId: scribe.agent.id, personId: ada.personId, workspaceId: ada.workspaceId };
  await perform(env.DB, asScribe, { type: "note.write", id: outside.id, baseRevision: 2, text: `# Diary-outside\n\nprivate-words-outside [[${inside.id}]]\n\nscribe-words-outside` });
  await perform(env.DB, asScribe, { type: "note.write", id: deep.id, baseRevision: 1, text: "# Q3 plan\n\nShip it.\n\nScribe's line." });
  // And one that has only ever written outside it, whose name is then nothing the limited agent should hear.
  const ghost = await connectAgent(env.DB, ada.personId, "Ghost-outside");
  await perform(env.DB, { ...asScribe, agentId: ghost.agent.id }, { type: "note.write", id: loose.id, baseRevision: 1, text: "# Loose-outside\n\nunsorted-words-outside ghost" });

  const limited = await connectAgent(env.DB, ada.personId, "Claude", { workspaceId: ada.workspaceId, folderIds: [projects] });
  /** Everything that would give away what is outside the limit. The ids of the two notes the roadmap links to are written in it, so they are not among these. */
  const marks = ["Diary-outside", "private-words-outside", "scribe-words-outside", "Loose-outside", "unsorted-words-outside", "Ghost-outside", ghost.agent.id, "Journal", journal, "Vacant", empty, "Unsorted"];
  return { ada, projects, plans, journal, empty, outside, loose, inside, deep, scribe, ghost, limited, marks };
}

describe("an agent limited to folders", { timeout: 30_000 }, () => {
  it("is made by naming folders of one workspace the member can see, and says what it is limited to", async () => {
    const { ada, projects, plans, limited } = await world();
    expect(limited.agent).toMatchObject({ workspaceId: ada.workspaceId, folderIds: [projects] });
    expect((await listAgents(env.DB, ada.personId)).find((a) => a.id === limited.agent.id)!.folderIds).toEqual([projects]);
    const claude = await asAgent(limited.token);
    expect(await claude.json("list_workspaces")).toMatchObject({ folderIds: [projects], workspaces: [{ id: ada.workspaceId }] });

    const other = await newMember("Grace Hopper");
    const theirs = (await perform(env.DB, other, { type: "folder.create", name: "Theirs" })).id;
    const connect = (options: object) => connectAgent(env.DB, ada.personId, "Claude", options as never);
    await expect(connect({ folderIds: [projects] })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("one workspace") });
    await expect(connect({ workspaceId: ada.workspaceId, folderIds: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(connect({ workspaceId: ada.workspaceId, folderIds: Array.from({ length: MAX_AGENT_FOLDERS + 1 }, () => projects) })).rejects.toMatchObject({ code: "invalid" });
    await expect(connect({ workspaceId: ada.workspaceId, folderIds: "all" })).rejects.toMatchObject({ code: "invalid" });
    // A folder of a workspace she isn't in, and one that was never there, are refused in the same words.
    await expect(connect({ workspaceId: ada.workspaceId, folderIds: [projects, theirs] })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    await expect(connect({ workspaceId: ada.workspaceId, folderIds: [MISSING] })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    expect((await connect({ workspaceId: ada.workspaceId, folderIds: [plans, plans, projects] })).agent.folderIds).toEqual([plans, projects]);
  });

  // Some ninety tool calls: a slow runner takes longer than the default 5 s.
  it("reads the notes in its folders and the folders under them, and is told of nothing else by any tool", async () => {
    const w = await world();
    const claude = await asAgent(w.limited.token);

    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([w.deep.id, w.inside.id].sort());
    expect(await claude.json("list_notes", { folderId: w.journal })).toEqual([]);
    expect(await claude.json("list_folders")).toEqual({
      unsortedId: null,
      folders: [
        { id: w.plans, name: "Plans", parentId: w.projects, noteCount: 1, access: "edit" },
        { id: w.projects, name: "Projects", parentId: null, noteCount: 1, access: "edit" },
      ],
    });

    // A link into a folder it can't see reads as a link to no note: the title isn't told.
    const roadmap = await claude.json<Note & { links: unknown }>("read_note", { id: w.inside.id });
    expect(roadmap.links).toEqual([
      { id: w.outside.id, title: null, state: null },
      { id: w.loose.id, title: null, state: null },
    ]);
    expect(await claude.json("backlinks", { id: w.inside.id })).toEqual([]);

    for (const id of [w.outside.id, w.loose.id]) {
      const asked: [string, Record<string, unknown>][] = [
        ["read_note", { id }],
        ["read_note", { id, revision: 1 }],
        ["backlinks", { id }],
        ["note_history", { id }],
        ["change_diff", { id, revision: 1 }],
        ["preview_revert", { id, to: 1 }],
        ["preview_revert", { id, revisions: [2] }],
        ["preview_revert", { id, author: { kind: "agent", id: w.scribe.agent.id } }],
        ["revert_note", { id, revision: 1 }],
        ["revert_changes", { id, revisions: [2] }],
        ["undo", { id }],
        ["redo", { id }],
        ["label_revision", { id, revision: 1, name: "Mine" }],
        ["write_note", { id, baseRevision: 3, text: "# Taken" }],
        ["move_note", { id, folderId: w.projects }],
      ];
      for (const [name, args] of asked) {
        const answer = await claude.call(name, args);
        expect(answer, `${name} ${JSON.stringify(args)}`).toEqual(NO_NOTE);
        expect(await claude.call(name, { ...args, id: MISSING }), `${name} of a note that was never there`).toEqual(answer);
      }
    }

    // History's tools that take several notes at once answer each note for itself: one outside is answered word for word as one that was never there.
    for (const id of [w.outside.id, w.loose.id]) {
      expect(await claude.call("history_diff", { changes: [{ noteId: id, revisions: [1] }] })).toEqual(NO_NOTE);
      expect(await claude.call("history_diff", { changes: [{ noteId: MISSING, revisions: [1] }] })).toEqual(NO_NOTE);
      // Named beside a note of its own, it still gives nothing of either away.
      expect(await claude.call("history_diff", { changes: [{ noteId: w.deep.id, revisions: [1] }, { noteId: id, revisions: [1] }] })).toEqual(NO_NOTE);
      const ways: Record<string, unknown>[] = [{ revisions: [2] }, { to: 1 }, { author: { kind: "agent", id: w.scribe.agent.id } }];
      for (const way of ways) {
        const previews = await claude.json<{ noteId: string; noteTitle: string; refused?: string }[]>("preview_reverts", { changes: [{ noteId: id, ...way }, { noteId: MISSING, ...way }, { noteId: w.deep.id, ...way }] });
        expect(previews[0], `preview_reverts ${JSON.stringify(way)}`).toEqual({ ...previews[1], noteId: id });
        expect(previews[1]).toMatchObject({ noteTitle: "", refused: "No such note" });
        expect(previews[2]).toMatchObject({ noteId: w.deep.id, noteTitle: "Q3 plan" });
        expect(previews[2]!.refused).toBeUndefined();
      }
    }

    // What changed, by whom and when, is of its own notes only: the scribe wrote on both sides, the ghost only outside.
    const summary = await claude.json<{ notes: { noteId: string }[] }>("history_summary", { limit: 100 });
    expect(summary.notes.map((n) => n.noteId).sort()).toEqual([w.deep.id, w.inside.id].sort());
    expect((await claude.json<{ notes: unknown[] }>("history_summary", { noteIds: [w.outside.id, w.loose.id] })).notes).toEqual([]);
    const changes = await claude.json<{ changes: { noteId: string }[] }>("history", { limit: 100 });
    expect([...new Set(changes.changes.map((c) => c.noteId))].sort()).toEqual([w.deep.id, w.inside.id].sort());
    expect((await claude.json<{ changes: unknown[] }>("history", { noteIds: [w.outside.id] })).changes).toEqual([]);
    expect((await claude.json<{ changes: unknown[] }>("history", { authors: [{ kind: "agent", id: w.ghost.agent.id }] })).changes).toEqual([]);
    expect((await claude.json<{ name: string }[]>("history_authors")).map((a) => a.name)).toEqual(["Ada Lovelace", "Scribe-everywhere"]);

    const said = claude.said.join("\n");
    expect(w.marks.filter((mark) => said.includes(mark))).toEqual([]);
    expect(said).toContain("Roadmap");
  });

  it("can't write its way out: no note made outside, none moved in or out, no folder made, renamed or deleted beyond its own", async () => {
    const w = await world();
    const claude = await asAgent(w.limited.token);
    const before = await perform(env.DB, w.ada, { type: "note.list" });

    // Unsorted is where a note with no folder goes, and it isn't one of its folders.
    expect(await claude.call("create_note", { text: "# Escaped" })).toEqual({ isError: true, text: "invalid: Say which folder: this agent is limited to folders, and Unsorted isn't one of them" });
    expect(await claude.call("create_note", { text: "# Escaped", folderId: w.journal })).toEqual(NO_FOLDER);
    expect(await claude.call("create_note", { text: "# Escaped", folderId: MISSING })).toEqual(NO_FOLDER);
    expect(await claude.call("move_note", { id: w.inside.id, folderId: w.journal })).toEqual(NO_FOLDER);
    expect(await claude.call("move_note", { id: w.inside.id, folderId: MISSING })).toEqual(NO_FOLDER);
    expect(await claude.call("move_note", { id: w.outside.id, folderId: w.projects })).toEqual(NO_NOTE);

    // A link by title is looked up among the notes it can see, so a title outside is as good as no title.
    const byTitle = await claude.call("write_note", { id: w.deep.id, baseRevision: 2, text: "# Q3 plan\n\n[[Diary-outside]]" });
    expect(byTitle).toEqual(await claude.call("write_note", { id: w.deep.id, baseRevision: 2, text: "# Q3 plan\n\n[[Diary-nowhere]]" }).then((a) => ({ ...a, text: a.text.replaceAll("Diary-nowhere", "Diary-outside") })));
    expect(byTitle.isError).toBe(true);
    // And by id: a note outside, and an id that was never a note's, are refused in the same words.
    const byId = (id: string) => claude.call("write_note", { id: w.deep.id, baseRevision: 2, text: `# Q3 plan\n\n[[${id}]]` }).then((a) => ({ ...a, text: a.text.replaceAll(id, "ID") }));
    expect(await byId(w.outside.id)).toEqual(await byId(MISSING));
    expect((await byId(w.outside.id)).isError).toBe(true);

    expect(await claude.call("create_folder", { name: "Mine" })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can make a folder only inside one of them" });
    expect(await claude.call("create_folder", { name: "Mine", parentId: w.journal })).toEqual(NO_FOLDER);
    // Beside Projects is Journal, which it can't see: renaming Projects to that would be refused for the name being taken.
    expect(await claude.call("rename_folder", { id: w.projects, name: "Journal" })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can rename only the folders inside one of them" });
    expect(await claude.call("rename_folder", { id: w.journal, name: "Taken" })).toEqual(NO_FOLDER);
    expect(await claude.call("rename_folder", { id: MISSING, name: "Taken" })).toEqual(NO_FOLDER);
    // An empty folder outside is deleted by nobody who can't see it, and one with notes doesn't lose them to Unsorted.
    expect(await claude.call("delete_folder", { id: w.empty })).toEqual(NO_FOLDER);
    expect(await claude.call("delete_folder", { id: w.journal })).toEqual(NO_FOLDER);
    expect(await claude.call("delete_folder", { id: MISSING })).toEqual(NO_FOLDER);

    // Reverting everything an author did reaches only its own notes.
    const reverted = await claude.json<{ reverted: { note: { id: string } }[]; failed: unknown[] }>("revert_author", { author: { kind: "agent", id: w.scribe.agent.id }, noteIds: [w.outside.id, w.deep.id] });
    expect(reverted.reverted.map((r) => r.note.id)).toEqual([w.deep.id]);
    expect(reverted.failed).toEqual([]);
    // And reverting several notes at once: the ones outside are skipped as notes that were never there, by changes, by revision and by author.
    for (const way of [{ revisions: [2] }, { to: 1 }, { author: { kind: "agent", id: w.scribe.agent.id } }] as Record<string, unknown>[]) {
      const many = await claude.json<{ reverted: unknown[]; skipped: { noteId: string }[] }>("revert_many", { changes: [w.outside.id, w.loose.id, MISSING].map((noteId) => ({ noteId, ...way })) });
      expect(many.reverted).toEqual([]);
      expect(many.skipped).toEqual([w.outside.id, w.loose.id, MISSING].map((noteId) => ({ noteId, noteTitle: "", why: "refused", message: "No such note" })));
    }
    // Rebuilding the record of links covers the notes it can see, and counts no other.
    expect(await claude.json("rebuild_links")).toEqual({ done: true });

    const after = await perform(env.DB, w.ada, { type: "note.list" });
    const untouched = (notes: typeof after) => notes.filter((n) => n.id !== w.deep.id).map((n) => [n.id, n.folderId, n.revision]);
    expect(untouched(after)).toEqual(untouched(before));
    expect((await perform(env.DB, w.ada, { type: "folder.list" })).folders.map((f) => f.name)).toEqual(["Journal", "Plans", "Projects", "Unsorted", "Vacant"]);
    expect((await perform(env.DB, w.ada, { type: "note.read", id: w.outside.id })).text).toContain("scribe-words-outside");
    // It was told Unsorted isn't one of its folders, and its own words back: the title it tried to link. Nothing else of what is outside.
    expect(w.marks.filter((mark) => claude.said.join("\n").includes(mark))).toEqual(["Diary-outside", "Unsorted"]);

    // Inside its folders it works as its member would.
    const made = await claude.json<Note>("create_note", { text: "# Made inside", folderId: w.plans });
    expect(await claude.json("move_note", { id: made.id, folderId: w.projects })).toMatchObject({ folderId: w.projects });
    const sub = await claude.json<{ id: string }>("create_folder", { name: "Sub", parentId: w.plans });
    expect(await claude.json("rename_folder", { id: w.plans, name: "Plans 2026" })).toMatchObject({ name: "Plans 2026" });
    expect(await claude.json("delete_folder", { id: sub.id })).toEqual({ id: sub.id });
  });

  it("follows the notes and the folders as they are now: moved out is gone for it, moved in is there", async () => {
    const w = await world();
    const claude = await asAgent(w.limited.token);
    expect((await claude.call("read_note", { id: w.inside.id })).isError).toBe(false);

    await perform(env.DB, w.ada, { type: "note.move", id: w.inside.id, folderId: w.journal });
    expect(await claude.call("read_note", { id: w.inside.id })).toEqual(NO_NOTE);
    expect(await claude.call("note_history", { id: w.inside.id })).toEqual(NO_NOTE);
    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([w.deep.id]);
    expect((await claude.json<{ changes: { noteId: string }[] }>("history")).changes.every((c) => c.noteId === w.deep.id)).toBe(true);

    await perform(env.DB, w.ada, { type: "note.move", id: w.outside.id, folderId: w.plans });
    expect((await claude.json<Note>("read_note", { id: w.outside.id })).title).toBe("Diary-outside");

    // No operation moves a folder yet. Whatever comes to, the limit is read from where each folder is at the time.
    await env.DB.prepare("UPDATE folders SET parent_id = NULL WHERE id = ?").bind(w.plans).run();
    expect(await claude.call("read_note", { id: w.deep.id })).toEqual(NO_NOTE);
    expect(await claude.json("list_notes")).toEqual([]);
    await env.DB.prepare("UPDATE folders SET parent_id = ? WHERE id = ?").bind(w.projects, w.journal).run();
    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([w.inside.id]);
  });

  it("is left with nothing, and never with everything, once its folders are deleted", async () => {
    const w = await world();
    const { agent, token } = await connectAgent(env.DB, w.ada.personId, "Narrow", { workspaceId: w.ada.workspaceId, folderIds: [w.plans] });
    const narrow = await asAgent(token);
    expect(idsOf(await narrow.json<Note[]>("list_notes"))).toEqual([w.deep.id]);

    await perform(env.DB, w.ada, { type: "note.move", id: w.deep.id, folderId: w.projects });
    await perform(env.DB, w.ada, { type: "folder.delete", id: w.plans });

    expect(await narrow.json("list_notes")).toEqual([]);
    expect(await narrow.json("list_folders")).toEqual({ unsortedId: null, folders: [] });
    expect(await narrow.call("read_note", { id: w.deep.id })).toEqual(NO_NOTE);
    expect(await narrow.json("history_authors")).toEqual([]);
    expect((await narrow.json<{ notes: unknown[] }>("history_summary")).notes).toEqual([]);
    // The agent still says what it was limited to, so its member can see why it reaches nothing.
    expect((await listAgents(env.DB, w.ada.personId)).find((a) => a.id === agent.id)!.folderIds).toEqual([w.plans]);
  });

  it("lists the todos and tags of its own notes only, learns nothing of a folder outside by asking for its todos, and sets no todo outside", async () => {
    const w = await world();
    const todo = "- [ ] buy-outside +proj-outside";
    await perform(env.DB, w.ada, { type: "note.create", folderId: w.journal, text: `# Chores-outside\n\n${todo}\n\n#tag-outside` });
    const chores = (await perform(env.DB, w.ada, { type: "note.list", folderId: w.journal })).find((n) => n.title === "Chores-outside")!;
    await perform(env.DB, w.ada, { type: "note.create", folderId: w.plans, text: "# Sprint\n\n- [ ] ship-inside +proj-inside\n\n#tag-inside" });
    const claude = await asAgent(w.limited.token);

    const listed = await claude.json<{ todos: { text: string }[] }>("list_todos", { includeCompleted: true });
    expect(listed.todos.map((t) => t.text)).toEqual(["- [ ] ship-inside +proj-inside"]);
    // Narrowed to a folder: one inside its limit with the folders under it, and a folder outside is no folder, as one that never was.
    expect((await claude.json<{ todos: { text: string }[] }>("list_todos", { folderId: w.projects })).todos.map((t) => t.text)).toEqual(["- [ ] ship-inside +proj-inside"]);
    expect((await claude.json<{ todos: { text: string }[] }>("list_todos", { folderId: w.plans })).todos.map((t) => t.text)).toEqual(["- [ ] ship-inside +proj-inside"]);
    expect(await claude.call("list_todos", { folderId: w.journal })).toEqual(NO_FOLDER);
    expect(await claude.call("list_todos", { folderId: w.journal, includeCompleted: true, tag: "tag-outside" })).toEqual(await claude.call("list_todos", { folderId: MISSING, includeCompleted: true, tag: "tag-outside" }));
    expect((await claude.json<{ todos: unknown[] }>("list_todos", { tag: "tag-outside" })).todos).toEqual([]);
    expect(await claude.json("todo_filters")).toEqual({ tags: ["tag-inside"], assignees: [] });
    const set = (id: string) => claude.call("set_todo", { id, revision: 1, line: 3, text: todo, done: true });
    expect(await set(chores.id)).toEqual(NO_NOTE);
    expect(await set(MISSING)).toEqual(NO_NOTE);
    expect((await perform(env.DB, w.ada, { type: "note.read", id: chores.id })).text).toContain(todo);
    expect(claude.said.join("\n")).not.toMatch(/buy-outside|proj-outside|tag-outside|Chores-outside|Journal/);
  });

  it("skips a recurring todo inside its folders and completes the last time of one that ends, with nothing filed outside them, and neither outside", async () => {
    const w = await world();
    const todo = "- [ ] Water-inside every:1w-times-2 due:2026-10-10";
    const chores = await perform(env.DB, w.ada, { type: "note.create", folderId: w.plans, text: todo });
    const elsewhere = await perform(env.DB, w.ada, { type: "note.create", text: "- [ ] Water-outside every:1w due:2026-10-10" });
    const daily = await perform(env.DB, w.ada, { type: "daily.open", on: "2026-10-11" });
    const claude = await asAgent(w.limited.token);

    const skipped = await claude.json<{ text: string; revision: number; filed?: unknown }>("set_todo", { id: chores.id, revision: 1, line: 0, text: todo, skip: true, on: "2026-10-11" });
    expect(skipped.text).toBe("- [ ] Water-inside every:1w-times-1 due:2026-10-17");
    expect(skipped.filed).toBeUndefined();

    const last = await claude.json<{ text: string; filed: { dailyNoteId: string | null; todos: number } }>("set_todo", { id: chores.id, revision: skipped.revision, line: 0, text: skipped.text, done: true, on: "2026-10-11" });
    expect(last.text).toBe("- [x] Water-inside every:1w-times-1 due:2026-10-17");
    expect(last.filed).toEqual({ on: "2026-10-11", dailyNoteId: null, todos: 1 });
    expect((await perform(env.DB, w.ada, { type: "note.read", id: daily.id })).revision).toBe(1);

    expect(await claude.call("set_todo", { id: elsewhere.id, revision: 1, line: 0, text: "- [ ] Water-outside every:1w due:2026-10-10", skip: true, on: "2026-10-11" })).toEqual(NO_NOTE);
    expect((await perform(env.DB, w.ada, { type: "note.read", id: elsewhere.id })).revision).toBe(1);
    expect(await claude.call("set_todo", { id: chores.id, revision: 3, line: 0, text: last.text, skip: true })).toMatchObject({ isError: true, text: expect.stringContaining("invalid") });
  });

  it("completes a recurring todo inside its folders and files nothing on a daily note outside them, makes no daily folder, and is told of no daily note", async () => {
    const w = await world();
    const todo = "- [ ] Water-inside every:1w due:2026-10-10";
    const chores = await perform(env.DB, w.ada, { type: "note.create", folderId: w.plans, text: `# Chores\n\n${todo}\n- [ ] Bins-inside every:1w due:2026-10-10` });
    const claude = await asAgent(w.limited.token);
    const folders = async () => (await perform(env.DB, w.ada, { type: "folder.list" })).folders.map((f) => f.name).sort();
    const before = await folders();

    // With no daily folder yet: the todo is completed, and no folder or note is made at the top of the workspace for it.
    const first = await claude.json<{ text: string; revision: number; filed: { dailyNoteId: string | null; todos: number } }>("set_todo", { id: chores.id, revision: 1, line: 2, text: todo, done: true, on: "2026-10-11" });
    expect(first.text).toContain("- [ ] Water-inside every:1w due:2026-10-17 done:2026-10-11x1");
    expect(first.filed).toEqual({ on: "2026-10-11", dailyNoteId: null, todos: 1 });
    expect(await folders()).toEqual(before);
    expect(await claude.call("daily_note", { on: "2026-10-11" })).toEqual({ isError: true, text: "forbidden: An agent limited to folders can't daily.open" });
    expect(await folders()).toEqual(before);

    // With Ada's daily note there, outside the limit: it is not written on, and the agent is not told its id.
    const daily = await perform(env.DB, w.ada, { type: "daily.open", on: "2026-10-11" });
    const written = await claude.json<{ text: string; revision: number; filed: { dailyNoteId: string | null } }>("write_note", { id: chores.id, baseRevision: first.revision, text: first.text.replace("- [ ] Bins-inside", "- [x] Bins-inside"), on: "2026-10-11" });
    expect(written.text).toContain("- [ ] Bins-inside every:1w due:2026-10-17 done:2026-10-11x1");
    expect(written.filed.dailyNoteId).toBeNull();
    expect((await perform(env.DB, w.ada, { type: "note.read", id: daily.id })).revision).toBe(1);

    // What Ada files herself is on her daily note, which the agent's history of the todo doesn't name.
    const adas = await perform(env.DB, w.ada, { type: "todo.set", id: chores.id, revision: written.revision, line: 2, text: "- [ ] Water-inside every:1w due:2026-10-17 done:2026-10-11x1", done: true, on: "2026-10-11" });
    expect(adas.filed!.dailyNoteId).toBe(daily.id);
    const told = await claude.json<{ completions: { dailyNoteId: string | null }[] }>("todo_history", { id: chores.id, revision: adas.revision, line: 2, text: "- [ ] Water-inside every:1w due:2026-10-24 done:2026-10-11x2" });
    expect(told.completions.map((c) => c.dailyNoteId)).toEqual([null, null]);
    expect(await claude.call("read_note", { id: daily.id })).toEqual(NO_NOTE);
    expect(await claude.call("todo_history", { id: w.outside.id, revision: 3, line: 0, text: "- [ ] x" })).toEqual(NO_NOTE);
    expect(await claude.call("todo_history", { id: MISSING, revision: 3, line: 0, text: "- [ ] x" })).toEqual(NO_NOTE);
    expect(claude.said.join("\n")).not.toContain(daily.id);
    expect(claude.said.join("\n")).not.toMatch(/# 2026-10-11/);
  });

  it("finds, tags, archives, trashes and restores only inside its folders, and a search, a tag or a count is the same with the notes outside as without them", async () => {
    const w = await world();
    const { ada } = w;
    const note = (folderId: string | undefined, text: string) => perform(env.DB, ada, { type: "note.create", folderId, text });
    // Inside and outside share a word, a tag and a todo's word, so a count that took in what is outside would be one too many.
    const tagged = await note(w.projects, "# Budget\n\ncommonword #sharedtag #insidetag\n\n- [ ] file it sharedtodo");
    const filed = await note(w.plans, "# Old plan\n\ncommonword archived-inside");
    const binned = await note(w.plans, "# Scrapped plan\n\ncommonword trashed-inside");
    const hush = await note(w.journal, "# Hush-outside\n\ncommonword #sharedtag #hushtag\n\n- [ ] hide it sharedtodo Hideout");
    const shelved = await note(w.journal, "# Shelved-outside\n\ncommonword #sharedtag archived-words-outside");
    const dumped = await note(undefined, "# Dumped-outside\n\ncommonword #sharedtag trashed-words-outside");
    await perform(env.DB, ada, { type: "note.archive", id: filed.id, archived: true });
    await perform(env.DB, ada, { type: "note.archive", id: shelved.id, archived: true });
    await perform(env.DB, ada, { type: "note.trash", id: binned.id });
    await perform(env.DB, ada, { type: "note.trash", id: dumped.id });
    const marks = [...w.marks, "Hush-outside", "hushtag", "Hideout", "Shelved-outside", "archived-words-outside", "Dumped-outside", "trashed-words-outside", hush.id, shelved.id, dumped.id];
    const claude = await asAgent(w.limited.token);
    type Found = { results: { note: { id: string }; matches: unknown[] }[]; next: number | null; indexing: boolean };
    const found = async (args: Record<string, unknown>) => idsOf((await claude.json<Found>("search", args)).results.map((r) => r.note));

    // A word only notes outside have finds what a word no note has finds, to the letter.
    const nothing = await claude.call("search", { query: "nosuchwordanywhere" });
    expect(JSON.parse(nothing.text)).toEqual({ results: [], next: null, indexing: false });
    for (const query of ["private-words-outside", "Diary-outside", "Hush-outside", "#hushtag", "Hideout", "archived-words-outside", "trashed-words-outside", "scribe-words-outside", '"unsorted-words-outside ghost"']) {
      for (const includeArchived of [false, true, "only"]) expect(await claude.call("search", { query, includeArchived }), `${query} ${includeArchived}`).toEqual(nothing);
    }
    // A word, a tag and a todo's word both sides have find its own notes, in each state asked for, however they are sorted and paged.
    expect(await found({ query: "commonword" })).toEqual([tagged.id]);
    expect(await found({ query: "commonword", includeArchived: true })).toEqual([filed.id, tagged.id].sort());
    expect(await found({ query: "commonword", includeArchived: "only" })).toEqual([filed.id]);
    expect(await found({ query: "#sharedtag", includeArchived: true })).toEqual([tagged.id]);
    expect(await found({ query: "sharedtodo", includeArchived: true })).toEqual([tagged.id]);
    expect(await found({ query: "commonword", hasTodos: true, includeArchived: true })).toEqual([tagged.id]);
    for (const sort of ["match", "recent", "created", "title"]) {
      const paged: string[] = [];
      for (let offset: number | null = 0, asked = 0; offset !== null; asked++) {
        const page: Found = await claude.json<Found>("search", { query: "commonword", includeArchived: true, sort, limit: 1, offset });
        expect(page.results.length, `${sort}: a page of its own notes`).toBe(1);
        paged.push(page.results[0]!.note.id);
        offset = page.next;
        expect(asked, `${sort}: no more pages than it has notes`).toBeLessThan(2);
      }
      expect(paged.sort(), sort).toEqual([filed.id, tagged.id].sort());
    }
    // A search narrowed to a folder outside is a search in a folder that was never there.
    for (const folderId of [w.journal, w.empty, MISSING]) expect(await claude.call("search", { query: "commonword", folderId })).toEqual(NO_FOLDER);
    expect(await found({ query: "commonword", folderId: w.plans, includeArchived: true })).toEqual([filed.id]);

    // Tags and their counts are of its own notes.
    expect(await claude.json("list_tags")).toEqual({ tags: [{ name: "insidetag", notes: 1 }, { name: "sharedtag", notes: 1 }], indexing: false });
    expect(await claude.json("list_tags", { includeArchived: true })).toEqual({ tags: [{ name: "insidetag", notes: 1 }, { name: "sharedtag", notes: 1 }], indexing: false });
    expect(idsOf(await claude.json<Note[]>("list_notes", { tag: "sharedtag", includeArchived: true }))).toEqual([tagged.id]);
    expect(await claude.json("list_notes", { tag: "hushtag", includeArchived: true })).toEqual(await claude.json("list_notes", { tag: "nosuchtag", includeArchived: true }));
    expect(await claude.json("todo_filters", { includeArchived: true })).toEqual({ tags: ["insidetag", "sharedtag"], assignees: [] });

    // The archived notes and Trash it is shown are its own.
    expect(idsOf(await claude.json<Note[]>("list_notes", { includeArchived: "only" }))).toEqual([filed.id]);
    expect(idsOf(await claude.json<Note[]>("list_trash"))).toEqual([binned.id]);
    expect((await claude.json<{ noteCount: number }[] & { folders: { id: string; noteCount: number }[] }>("list_folders")).folders.map((f) => [f.id, f.noteCount]).sort()).toEqual([[w.plans, 1], [w.projects, 2]].sort());

    // Archiving, trashing and restoring a note outside, whatever state it is in, is refused as for a note that was never there, and changes nothing.
    const states = () => env.DB.prepare("SELECT id, state, folder_id, revision FROM notes WHERE workspace_id = ? ORDER BY id").bind(ada.workspaceId).all();
    const before = (await states()).results;
    for (const id of [w.outside.id, w.loose.id, hush.id, shelved.id, dumped.id, MISSING]) {
      expect(await claude.call("read_note", { id }), id).toEqual(NO_NOTE);
      expect(await claude.call("archive_note", { id, archived: true }), id).toEqual(NO_NOTE);
      expect(await claude.call("archive_note", { id, archived: false }), id).toEqual(NO_NOTE);
      expect(await claude.call("trash_note", { id }), id).toEqual(NO_NOTE);
      expect(await claude.call("restore_note", { id }), id).toEqual(NO_NOTE);
    }
    // Reverting an author into Trash reaches no note outside. (No tool removes a note for good: agent-parity.test.ts.)
    await claude.json("revert_author", { author: { kind: "agent", id: w.ghost.agent.id }, trashEmptied: true });
    expect((await states()).results).toEqual(before);

    // Inside, it does all three, and a note of its own whose folder is deleted while in Trash has left its folders with it.
    expect(await claude.json("archive_note", { id: tagged.id, archived: true })).toMatchObject({ id: tagged.id, state: "archived" });
    expect(await claude.json("trash_note", { id: tagged.id })).toMatchObject({ id: tagged.id, state: "trashed" });
    expect(await claude.json("restore_note", { id: tagged.id })).toMatchObject({ id: tagged.id, state: "archived", folderGone: false });
    await perform(env.DB, ada, { type: "note.move", id: w.deep.id, folderId: w.projects });
    await perform(env.DB, ada, { type: "note.move", id: filed.id, folderId: w.projects });
    await perform(env.DB, ada, { type: "folder.delete", id: w.plans });
    expect(await claude.call("restore_note", { id: binned.id })).toEqual(NO_NOTE);
    expect(await claude.json("list_trash")).toEqual([]);

    for (const mark of marks) expect(claude.said.filter((text) => text.includes(mark)), mark).toEqual([]);
  });

  it("learns nothing through the query language: a filter naming what is outside is one naming what was never there, and no filter finds or counts a note outside", async () => {
    const w = await world();
    const { ada } = w;
    const note = (folderId: string | undefined, text: string) => perform(env.DB, ada, { type: "note.create", folderId, text });
    // Both sides have a todo with the same words, due the same day, and a note of each is shared and one outside is private.
    const tagged = await note(w.projects, "# Budget\n\ncommonword #sharedtag\n\n- [ ] !! sharedtodo due:2026-10-01 every:1w");
    const hush = await note(w.journal, "# Hush-outside\n\ncommonword #sharedtag #hushtag\n\n- [ ] !!! sharedtodo Hideout due:2026-10-01 every:1w");
    const sealed = await note(w.journal, "# Sealed-outside\n\ncommonword sealed-words-outside");
    await perform(env.DB, ada, { type: "note.setPrivate", id: sealed.id, private: true });
    await perform(env.DB, ada, { type: "grant.link", noteId: hush.id, link: "public" });
    await perform(env.DB, ada, { type: "grant.link", noteId: tagged.id, link: "public" });
    const marks = [...w.marks, "Hush-outside", "hushtag", "Hideout", "Sealed-outside", "sealed-words-outside", hush.id, sealed.id];
    const claude = await asAgent(w.limited.token);
    /** What it asks by a name of its own choosing says that name back, so those answers are compared and not searched for marks. */
    const naming = await asAgent(w.limited.token);
    const today = "2026-10-13";
    type Found = { results: { note: { id: string } }[]; next: number | null; indexing: boolean };
    type Listed = { todos: { noteId: string }[]; next: number | null };
    const found = async (query: string) => idsOf((await claude.json<Found>("search", { query, today })).results.map((r) => r.note));
    const listed = async (query: string) => (await claude.json<Listed>("list_todos", { query, today })).todos.map((t) => t.noteId).sort();
    const INSIDE = [w.inside.id, w.deep.id, tagged.id].sort();

    // A folder outside, by name or by id, one that is empty, and Unsorted: each is refused in the words a folder that never was is.
    const blank = (text: string) => text.replace(/"[^"]*"/g, '"…"');
    for (const tool of ["search", "list_todos"]) {
      const never = await naming.call(tool, { query: "folder:Nowhere commonword", today });
      expect(never).toEqual({ isError: true, text: 'invalid: No folder named "Nowhere"' });
      for (const name of ["Journal", "journal", w.journal, "Vacant", w.empty, "Unsorted", MISSING]) {
        for (const query of [`folder:${name} commonword`, `-folder:${name}`, `commonword OR folder:${name}`, `NOT (folder:${name} OR nosuchword)`]) {
          const answer = await naming.call(tool, { query, today });
          expect({ ...answer, text: blank(answer.text) }, `${tool} ${query}`).toEqual({ ...never, text: blank(never.text) });
        }
      }
      // Someone who has only written outside is nobody, as a name nobody has is; and one who has written on both sides is found for the inside alone.
      const nobody = await naming.call(tool, { query: "editor:Nobody-at-all", today });
      expect(nobody).toEqual({ isError: true, text: 'invalid: Nobody named "Nobody-at-all" has changed a note you can see' });
      for (const query of ['editor:"Ghost-outside"', 'author:"Ghost-outside"', 'edited-by:"ghost-outside" OR commonword', '-editor:"Ghost-outside"']) {
        const answer = await naming.call(tool, { query, today });
        expect({ ...answer, text: blank(answer.text) }, `${tool} ${query}`).toEqual({ ...nobody, text: blank(nobody.text) });
      }
    }
    expect(await found('editor:"Scribe-everywhere"')).toEqual([w.deep.id]);
    expect(await found('editor:"Ada Lovelace"')).toEqual(INSIDE);
    expect(await found('author:"Ada Lovelace" -editor:"Scribe-everywhere"')).toEqual([w.inside.id, tagged.id].sort());
    expect(await found("editor:@me")).toEqual([]);
    expect(await found('folder:Projects -folder:Plans')).toEqual([w.inside.id, tagged.id].sort());
    expect(await found(`folder:${w.plans} OR #sharedtag`)).toEqual([w.deep.id, tagged.id].sort());

    // Every filter and operator, over words and tags both sides have: only its own notes are found, and no page is left over.
    const nothing = await claude.call("search", { query: "nosuchwordanywhere" });
    expect(JSON.parse(nothing.text)).toEqual({ results: [], next: null, indexing: false });
    for (const query of [
      "private-words-outside OR Hideout OR sealed-words-outside",
      "#hushtag",
      "tag:hushtag OR Diary-outside in:title",
      "is:private",
      "is:private OR is:shared",
      "is:shared",
      "has:backlink",
      "commonword is:private",
      "commonword -folder:Projects",
      'sharedtodo "Hideout"',
      "commonword (has:backlink OR is:shared OR #hushtag)",
      "scribe-words-outside updated:>=2020-01-01",
    ]) {
      expect(await claude.call("search", { query, today }), query).toEqual(nothing);
    }
    for (const [query, ids] of [
      ["commonword", [tagged.id]],
      ["commonword OR nosuchword", [tagged.id]],
      ["-nosuchword", INSIDE],
      ["NOT (Hideout OR #hushtag OR is:private OR is:shared)", INSIDE],
      ["no:backlink", INSIDE],
      ["-is:shared -is:private", INSIDE],
      ["has:link", [w.inside.id]],
      ["#sharedtag", [tagged.id]],
      ["has:open-todo", [tagged.id]],
      ["has:todo OR has:tag", [tagged.id]],
      ["updated:>=7d OR created:<=today", INSIDE],
      ["is:open sort:title-desc", INSIDE],
      ["commonword in:body", [tagged.id]],
    ] as const) {
      expect(await found(query), query).toEqual([...ids].sort());
      const page = await claude.json<Found>("search", { query, today, limit: Math.max(1, ids.length) });
      expect(page.next, `${query}: nothing more than its own notes to page to`).toBeNull();
    }

    // Todos the same: a todo outside with the same words, the same due date and a higher importance is never listed, counted or sorted in.
    const none = await claude.call("list_todos", { query: "nosuchwordanywhere" });
    expect(JSON.parse(none.text)).toEqual({ todos: [], next: null });
    for (const query of ["Hideout", "importance:3", "sharedtodo importance:>2", "is:shared", "is:private", "has:backlink", "#hushtag", "sharedtodo -folder:Projects", "Hush-outside in:title", "is:done"]) {
      expect(await claude.call("list_todos", { query, today }), query).toEqual(none);
    }
    for (const query of ["", "sharedtodo", "due:<today", "due:2026-10-01", "priority:>=medium", "has:repeat", "has:due", "#sharedtag", "sort:priority-desc", "sharedtodo OR Hideout", "-Hideout", "NOT is:shared", "Budget in:title", "is:open OR is:done"]) {
      expect(await listed(query), query).toEqual([tagged.id]);
      expect((await claude.json<Listed>("list_todos", { query, today, limit: 1 })).next, `${query}: one todo, and no page after it`).toBeNull();
    }

    // A query it can't be read says where, in its own words alone.
    expect(await claude.call("search", { query: "commonword titel:x" })).toEqual({ isError: true, text: 'invalid: There is no filter "titel:". To search for the words, put them in quotes (characters 12 to 17 of the query: titel:)' });
    expect(await claude.call("list_todos", { query: "due:today" })).toEqual({ isError: true, text: 'invalid: "today" is counted from today, and the server doesn\'t know your day: pass today, as YYYY-MM-DD' });

    for (const mark of marks) expect(claude.said.filter((text) => text.includes(mark)), mark).toEqual([]);
    // And what named a thing outside was told nothing but that name back.
    for (const text of naming.said) expect(text).toMatch(/^invalid: (No folder named|Nobody named) "[^"]*"( has changed a note you can see)?$/);
  });

  it("is told its own notes are still being indexed, and nothing of the notes outside that are", async () => {
    const w = await world();
    // More notes outside than one call reads in, none of them read in yet, and every note inside is.
    const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('notes')").all<{ name: string }>()).results.map((c) => c.name).filter((name) => name !== "id");
    for (let n = 0; n < 31; n++) {
      await env.DB.batch(Array.from({ length: 10 }, (_, i) => env.DB.prepare(`INSERT INTO notes (id, ${columns.join(", ")}) SELECT ?1, ${columns.join(", ")} FROM notes WHERE id = ?2`).bind(`bulk${String(n * 10 + i).padStart(8, "0")}`, w.outside.id)));
    }
    await env.DB.prepare("UPDATE notes SET indexed = 0 WHERE folder_id = ?").bind(w.journal).run();
    const claude = await asAgent(w.limited.token);
    const everywhere = await asAgent(w.scribe.token);
    expect(await claude.json("search", { query: "nosuchwordanywhere" })).toEqual({ results: [], next: null, indexing: false });
    await env.DB.prepare("UPDATE notes SET indexed = 0 WHERE folder_id = ?").bind(w.journal).run();
    expect(await claude.json("list_tags")).toEqual({ tags: [], indexing: false });
    // The same moment, asked by an agent that sees those notes: there is more to read in.
    await env.DB.prepare("UPDATE notes SET indexed = 0 WHERE folder_id = ?").bind(w.journal).run();
    expect(await everywhere.json("search", { query: "nosuchwordanywhere" })).toMatchObject({ indexing: true });
    await env.DB.prepare("UPDATE notes SET indexed = 0 WHERE folder_id = ?").bind(w.journal).run();
    expect(await everywhere.json("list_tags")).toMatchObject({ indexing: true });
    // However many notes outside wait ahead of its own, its own are read in on the first ask, and it is told there is no more.
    await env.DB.prepare("UPDATE notes SET indexed = 0 WHERE workspace_id = ?").bind(w.ada.workspaceId).run();
    await env.DB.prepare("DELETE FROM note_search").run();
    expect(await claude.json("search", { query: "roadmap" })).toMatchObject({ results: [{ note: { id: w.inside.id } }], next: null, indexing: false });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE folder_id = ? AND indexed = 0").bind(w.journal).first<{ n: number }>())!.n).toBe(311);
    // A rebuild it asks for is of its own notes, done in one call, and leaves the rest as they were.
    expect(await claude.json("rebuild_links")).toEqual({ done: true });
    expect(await claude.json("rebuild_todos")).toEqual({ done: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE folder_id = ? AND indexed = 0").bind(w.journal).first<{ n: number }>())!.n).toBe(311);
    expect(await everywhere.json("rebuild_links")).toEqual({ done: false });
    // And of its own notes it is told.
    await env.DB.prepare("UPDATE notes SET indexed = 0, folder_id = ?2 WHERE folder_id = ?1").bind(w.journal, w.projects).run();
    expect(await claude.json("list_tags")).toMatchObject({ indexing: true });
  });

  it("is refused its member's calendar and contacts, which are in no folder, and reads a reference in its notes as its label alone", async () => {
    const w = await world();
    const asked: string[] = [];
    const lunch = { sourceId: "cal", id: "a1", calendarId: "mine", calendar: "Mine-calendar-outside", color: null, title: "Lunch with Sam", when: { allDay: false, from: 1, to: 2 }, timeZone: null, location: "Cafe-Lula-outside", description: "contract-outside", recurring: false, editable: true, etag: "e1", url: null } as const;
    const mine = { sourceId: "cal", id: "mine", name: "Mine-calendar-outside", color: null, writable: true };
    const sam = { sourceId: "people", id: "people/c1", name: "Sam Okafor", emails: [{ value: "sam-outside@example.com", type: null }], phones: [], organization: null, url: null, title: "Plumber-outside", addresses: [{ value: "Lane-outside", type: null }], birthday: null, notes: "notes-outside", photo: null, urls: [], etag: "e1" };
    const changed: unknown[] = [];
    const sources: Sources = {
      async of(personId) {
        asked.push(personId);
        const info = (id: string, name: string) => ({ id, name, provider: "Test", state: "connected" as const, account: "ada-account-outside@test" });
        return [
          {
            kind: "calendar",
            info: info("cal", "Calendar-source-outside"),
            list: async () => ({ calendars: [mine], events: [lunch] }),
            get: async (id) => (id === "a1" ? lunch : null),
            calendar: async (id) => (id === mine.id ? mine : null),
            update: async (id, change) => (changed.push([id, change]), lunch),
            create: async (calendarId, fields) => (changed.push([calendarId, fields]), lunch),
          },
          { kind: "contacts", info: info("people", "Contacts-source-outside"), list: async () => ({ contacts: [sam], more: false }), get: async (id) => (id === sam.id ? sam : null) },
        ];
      },
      connect: async () => ({ redirect: null }),
      disconnect: async () => {},
    };
    const refer = (sourceId: string, id: string) => perform(env.DB, w.ada, { type: "record.refer", sourceId, id }, Date.now(), sources);
    const event = await refer("cal", "a1");
    const contact = await refer("people", "people/c1");
    // The references are written inside the limit and outside it.
    await perform(env.DB, w.ada, { type: "note.write", id: w.deep.id, baseRevision: 2, text: `# Q3 plan\n\n${event.text} with ${contact.text}` });
    await perform(env.DB, w.ada, { type: "note.write", id: w.loose.id, baseRevision: 2, text: `# Loose-outside\n\n${event.text}` });
    const readOnly = await connectAgent(env.DB, w.ada.personId, "Reader", { workspaceId: w.ada.workspaceId, folderIds: [w.projects], readOnly: true });
    const before = asked.length;

    for (const token of [w.limited.token, readOnly.token]) {
      const claude = await asAgent(token, sources);
      const refused = (op: string) => ({ isError: true, text: `forbidden: An agent limited to folders can't ${op}` });
      expect(await claude.call("list_sources")).toEqual(refused("source.list"));
      expect(await claude.call("list_events", { from: 0, to: 10, timeZone: "UTC" })).toEqual(refused("event.list"));
      expect(await claude.call("list_contacts")).toEqual(refused("contact.list"));
      expect(await claude.call("list_contacts", { query: "sam" })).toEqual(refused("contact.list"));
      // A reference in a note it reads, one in a note it can't, and one that was never made are refused alike.
      for (const ref of [event.ref, contact.ref, MISSING]) expect(await claude.call("read_record", { ref })).toEqual(refused("record.read"));
      // Which notes reference an event, the one inside the limit or the one outside it, is refused too.
      expect(await claude.call("notes_about_record", { sourceId: "cal", id: "a1" })).toEqual(refused("record.notes"));
      const changes = token === readOnly.token ? (op: string) => ({ isError: true, text: `forbidden: A read-only token can't ${op}` }) : refused;
      expect(await claude.call("refer_record", { sourceId: "cal", id: "a1" })).toEqual(changes("record.refer"));
      expect(await claude.call("update_event", { sourceId: "cal", id: "a1", etag: "e1", title: "Taken" })).toEqual(changes("event.update"));
      expect(await claude.call("create_event", { sourceId: "cal", calendarId: "mine", title: "Taken", when: { allDay: true, from: "2026-10-14", to: "2026-10-14" } })).toEqual(changes("event.create"));
      // What its note says of them is what every reader of the note is told: the reference and its label.
      expect((await claude.json<Note>("read_note", { id: w.deep.id })).text).toBe(`# Q3 plan\n\n::event{${event.ref} Lunch with Sam} with ::contact{${contact.ref} Sam Okafor}`);
      await claude.json("search", { query: "Lunch" });
      await claude.json("note_history", { id: w.deep.id });
      // Sam's page tells it the name it asked by and nothing of its member's contact.
      expect(await claude.json("read_person", { who: "Sam Okafor" })).toMatchObject({ who: "Sam Okafor", name: "Sam Okafor", member: null, contacts: [] });
      expect(claude.said.join("\n")).not.toMatch(/Cafe-Lula-outside|contract-outside|sam-outside@example\.com|Plumber-outside|Lane-outside|notes-outside|Mine-calendar-outside|ada-account-outside|source-outside|people\/c1/);
      for (const mark of w.marks) expect(claude.said.join("\n")).not.toContain(mark);
    }
    // Refused before anything was asked of a data source, and nothing was changed there.
    expect(asked).toHaveLength(before);
    expect(changed).toEqual([]);
    // Her agent that reaches everything reads the record, as she does.
    expect((await (await asAgent(w.scribe.token, sources)).json<{ event: { location: string } }>("read_record", { ref: event.ref })).event.location).toBe("Cafe-Lula-outside");
  });

  it("is told by no mention who is a member: a name it writes stays a name, an id is given no name, and nobody's todos outside are found by who they are assigned to", async () => {
    const w = await world();
    const bob = await addMember(w.ada, "editor", "Bob-outside-only");
    const twin = await addMember(w.ada, "editor", "Twin-outside");
    const twin2 = await addMember(w.ada, "editor", "Twin-outside");
    // Bob is renamed after he is mentioned inside, and is assigned a todo outside.
    await perform(env.DB, w.ada, { type: "note.create", folderId: w.journal, text: `# Chores-outside\n\n- [ ] buy-outside @[[${bob.personId}|Bob-outside-only]] @[[Carol-outside]]` });
    const sprint = await perform(env.DB, w.ada, { type: "note.create", folderId: w.plans, text: `# Sprint\n\n- [ ] ship-inside @[[Robert]] @[[Dana-inside]]\n\nAsk @[[${bob.personId}|Robert]].` });
    expect(sprint.text).toContain("@[[Dana-inside]]");
    const claude = await asAgent(w.limited.token);

    // What its note says of a mention is the note's text, and nothing is added from who is a member now.
    const read = await claude.json<{ mentions: unknown[] }>("read_note", { id: sprint.id });
    expect(read.mentions).toEqual([{ id: null, name: "Robert", member: false }, { id: null, name: "Dana-inside", member: false }, { id: bob.personId, name: "Robert", member: false }]);
    expect(await claude.json("todo_filters")).toEqual({ tags: [], assignees: [{ id: null, name: "Dana-inside", member: false }, { id: null, name: "Robert", member: false }] });
    for (const assignee of [bob.personId, "Carol-outside", "Bob-outside-only"]) expect((await claude.json<{ todos: unknown[] }>("list_todos", { assignee })).todos, assignee).toEqual([]);
    expect((await claude.json<{ todos: unknown[] }>("list_todos", { assignedToMe: true })).todos).toEqual([]);

    // A member's name, a name two members have, a member's id, and a name nobody has are all written as they were given.
    const written = `# Sprint\n\n- [ ] ship-inside @[[Robert]] @[[Dana-inside]]\n\nAsk @[[${bob.personId}|Robert]].\n\n@[[Bob-outside-only]] @[[Twin-outside]] @[[${twin.personId}]] @[[Nobody-at-all]]`;
    const wrote = await claude.json<Note>("write_note", { id: sprint.id, baseRevision: sprint.revision, text: written });
    expect(wrote.text).toBe(written);
    const set = await claude.json<{ text: string }>("set_todo", { id: sprint.id, revision: wrote.revision, line: 2, text: "- [ ] ship-inside @[[Robert]] @[[Dana-inside]]", assign: "Twin-outside" });
    expect(set.text).toContain("- [ ] ship-inside @[[Robert]] @[[Dana-inside]] @[[Twin-outside]]");
    expect(claude.said.join("\n")).not.toMatch(new RegExp(`${twin2.personId}|members are named|Chores-outside|buy-outside|Carol-outside`));
    // Her agent that sees everything is told, as she is.
    const scribe = await asAgent(w.scribe.token);
    expect((await scribe.json<{ mentions: { name: string; member: boolean }[] }>("read_note", { id: sprint.id })).mentions).toContainEqual({ id: bob.personId, name: "Bob-outside-only", member: true });
    expect(await scribe.call("write_note", { id: sprint.id, baseRevision: wrote.revision + 1, text: `${set.text}\n\n@[[twin-OUTSIDE]]` })).toMatchObject({ isError: true, text: expect.stringContaining("2 members are named") });
  });

  it("isn't told who is in the workspace, some of whom have only written outside its folders", async () => {
    const w = await world();
    await addMember(w.ada, "editor", "Bob-outside-only");
    const claude = await asAgent(w.limited.token);
    expect(await claude.call("list_members")).toEqual({ isError: true, text: "forbidden: An agent limited to folders can't member.list" });
    expect((await (await asAgent(w.scribe.token)).json<{ name: string }[]>("list_members")).map((m) => m.name)).toContain("Bob-outside-only");
  });

  it("limited to a folder inside another, or to Unsorted, is told nothing of what is above or beside it", async () => {
    const w = await world();
    const { unsortedId } = await perform(env.DB, w.ada, { type: "folder.list" });
    const inner = await asAgent((await connectAgent(env.DB, w.ada.personId, "Inner", { workspaceId: w.ada.workspaceId, folderIds: [w.plans] })).token);
    expect(await inner.json("list_folders")).toEqual({ unsortedId: null, folders: [{ id: w.plans, name: "Plans", parentId: null, noteCount: 1, access: "edit" }] });
    expect(inner.said.join("\n")).not.toContain(w.projects);

    const loose = await asAgent((await connectAgent(env.DB, w.ada.personId, "Loose", { workspaceId: w.ada.workspaceId, folderIds: [unsortedId!] })).token);
    expect(await loose.json("list_folders")).toEqual({ unsortedId, folders: [{ id: unsortedId, name: "Unsorted", parentId: null, noteCount: 1, access: "edit" }] });
    expect((await loose.json<Note>("create_note", { text: "# No folder named" })).folderId).toBe(unsortedId);
    expect((await loose.call("create_folder", { name: "Mine" })).text).toBe("forbidden: An agent limited to folders can make a folder only inside one of them");
    expect((await loose.call("rename_folder", { id: unsortedId, name: "Mine" })).isError).toBe(true);
    expect((await loose.call("delete_folder", { id: unsortedId })).isError).toBe(true);
    expect(await loose.call("read_note", { id: w.inside.id })).toEqual(NO_NOTE);
  });

  it("deletes a folder of its own that is empty to it as its admin would: a note there it can't see goes to Unsorted, and it is told nothing of it", async () => {
    const w = await world();
    const bob = await addMember(w.ada, "editor", "Bob Editor");
    const vault = (await perform(env.DB, w.ada, { type: "folder.create", name: "Vault", parentId: w.projects })).id;
    const diary = await perform(env.DB, bob, { type: "note.create", folderId: vault, text: "# Bob-private" });
    await perform(env.DB, bob, { type: "note.setPrivate", id: diary.id, private: true });
    const claude = await asAgent(w.limited.token);

    expect(await claude.json("delete_folder", { id: vault })).toEqual({ id: vault });
    expect((await perform(env.DB, bob, { type: "note.read", id: diary.id })).folderId).toBe((await perform(env.DB, bob, { type: "folder.list" })).unsortedId);
    expect(claude.said.join("\n")).not.toMatch(/Bob-private|Unsorted/);
  });

  it("is limited to nothing by anything kept as its limit that isn't a list of folders: only no limit at all is no limit", async () => {
    const w = await world();
    const claude = await asAgent(w.limited.token);
    for (const kept of ["null", "[]", "0", '""', "false", "[null]", '[["x"]]', "{}", "not json"]) {
      await env.DB.prepare("UPDATE agents SET folder_ids = ? WHERE id = ?").bind(kept, w.limited.agent.id).run();
      expect(await claude.json("list_notes"), kept).toEqual([]);
      expect((await listAgents(env.DB, w.ada.personId)).find((a) => a.id === w.limited.agent.id)!.folderIds, kept).toEqual([]);
    }
  });

  it("is held to its limit by the core in any workspace: folders named with no workspace are folders of none", async () => {
    const w = await world();
    const team = (await newMember("Team Owner")) as Member;
    await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'admin')").bind(team.workspaceId, w.ada.personId).run();
    await perform(env.DB, team, { type: "note.create", text: "# Team's" });
    const agent: Actor = { kind: "agent", agentId: w.limited.agent.id, personId: w.ada.personId, workspaceId: team.workspaceId, scope: { folderIds: [w.projects] } };
    expect(await perform(env.DB, agent, { type: "note.list" })).toEqual([]);
    expect(await perform(env.DB, agent, { type: "folder.list" })).toEqual({ unsortedId: null, folders: [] });
    // And the token itself, which is held to its one workspace, finds no other.
    expect(await (await asAgent(w.limited.token)).call("list_notes", { workspace: team.workspaceId })).toEqual({ isError: true, text: "not_found: No such workspace" });
  });

  it("has what its member has inside the limit and no more: a guest's agent, a viewer's, and a member narrowed there", async () => {
    const ada = (await newMember("Ada Lovelace")) as Member;
    const team = (await perform(env.DB, ada, { type: "folder.create", name: "Team" })).id;
    const hidden = (await perform(env.DB, ada, { type: "folder.create", name: "Hidden-folder" })).id;
    const shared = await perform(env.DB, ada, { type: "note.create", folderId: team, text: "# Shared" });
    const lone = await perform(env.DB, ada, { type: "note.create", folderId: hidden, text: "# Lone-note" });
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    await perform(env.DB, ada, { type: "grant.set", folderId: team, email: guestEmail, access: "view" });
    await perform(env.DB, ada, { type: "grant.set", noteId: lone.id, email: guestEmail, access: "edit" });
    const gus = (await signIn(env.DB, { email: guestEmail, name: "Gus Guest" })).personId;

    // A guest limits their agent to a folder shared with them, and not to one they can't see, which is no folder to them.
    await expect(connectAgent(env.DB, gus, "Claude", { workspaceId: ada.workspaceId, folderIds: [hidden] })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    const { token } = await connectAgent(env.DB, gus, "Claude", { workspaceId: ada.workspaceId, folderIds: [team] });
    const claude = await asAgent(token);
    // The note shared with the guest alone is in a folder outside the limit, so it is outside too.
    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([shared.id]);
    expect(await claude.call("read_note", { id: lone.id })).toEqual(NO_NOTE);
    expect(await claude.call("write_note", { id: lone.id, baseRevision: 1, text: "# Lone-note\n\nMine now" })).toEqual(NO_NOTE);
    expect(await claude.call("write_note", { id: shared.id, baseRevision: 1, text: "# Shared\n\nMine now" })).toEqual({ isError: true, text: "forbidden: You can read this note, and not change it" });
    expect(claude.said.join("\n")).not.toMatch(/Lone-note|Hidden-folder/);

    // The grant is taken back: the folder is still the agent's limit, and there is nothing in it for the guest any more.
    const grants = await perform(env.DB, ada, { type: "grant.list", folderId: team });
    await perform(env.DB, ada, { type: "grant.revoke", id: grants.grants.find((g) => g.to.kind === "person")!.id });
    expect(await claude.json("list_notes")).toEqual([]);
    expect(await claude.call("read_note", { id: shared.id })).toEqual(NO_NOTE);
  });

  it("leaves its member, and their other agents, reaching what they did", async () => {
    const w = await world();
    const all = [w.deep.id, w.inside.id, w.loose.id, w.outside.id].sort();
    expect(idsOf(await perform(env.DB, w.ada, { type: "note.list" }))).toEqual(all);
    expect(idsOf(await (await asAgent(w.scribe.token)).json<Note[]>("list_notes"))).toEqual(all);
    expect((await perform(env.DB, w.ada, { type: "folder.list" })).unsortedId).not.toBeNull();
  });
});

describe("changing what an agent is limited to", { timeout: 30_000 }, () => {
  it("is an edit: to other folders, to all notes, and back, on the token it already has", async () => {
    const w = await world();
    const claude = await asAgent(w.limited.token);
    const edit = (change: object) => editAgent(env.DB, w.ada.personId, w.limited.agent.id, change as never);

    expect((await edit({ folderIds: [w.journal] })).folderIds).toEqual([w.journal]);
    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([w.outside.id]);
    expect(await claude.call("read_note", { id: w.inside.id })).toEqual(NO_NOTE);

    expect((await edit({ folderIds: null })).folderIds).toBeNull();
    expect((await claude.json<Note[]>("list_notes")).length).toBe(4);

    expect(await edit({ folderIds: [w.plans], readOnly: true })).toMatchObject({ folderIds: [w.plans], readOnly: true });
    expect(idsOf(await claude.json<Note[]>("list_notes"))).toEqual([w.deep.id]);
    expect((await claude.call("write_note", { id: w.deep.id, baseRevision: 2, text: "# No" })).text).toBe("forbidden: A read-only token can't note.write");
    // An edit that says nothing of folders leaves the limit as it is.
    expect(await edit({ readOnly: false })).toMatchObject({ folderIds: [w.plans], readOnly: false });

    await expect(edit({ folderIds: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(edit({ folderIds: [MISSING] })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    expect((await listAgents(env.DB, w.ada.personId)).find((a) => a.id === w.limited.agent.id)!.folderIds).toEqual([w.plans]);
  });

  it("keeps the limit and the workspace together: folders are of the one workspace the token reaches", async () => {
    const w = await world();
    const team = (await newMember("Team Owner")) as Member;
    await env.DB.prepare("INSERT INTO members (workspace_id, person_id, role) VALUES (?, ?, 'editor')").bind(team.workspaceId, w.ada.personId).run();
    const theirs = (await perform(env.DB, team, { type: "folder.create", name: "Theirs" })).id;
    const edit = (change: object) => editAgent(env.DB, w.ada.personId, w.limited.agent.id, change as never);

    // To every workspace, or to another one, a limited token doesn't go with folders it would find nothing in.
    await expect(edit({ workspaceId: null })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("limited to folders") });
    await expect(edit({ workspaceId: team.workspaceId })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("limited to folders") });
    await expect(edit({ workspaceId: team.workspaceId, folderIds: [w.projects] })).rejects.toMatchObject({ code: "not_found", message: "No such folder" });
    await expect(edit({ workspaceId: null, folderIds: [w.projects] })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("one workspace") });
    expect(await edit({ workspaceId: team.workspaceId, folderIds: [theirs] })).toMatchObject({ workspaceId: team.workspaceId, folderIds: [theirs] });
    expect(await edit({ workspaceId: null, folderIds: null })).toMatchObject({ workspaceId: null, folderIds: null });
    // And one that reaches every workspace is limited only together with a workspace.
    await expect(edit({ folderIds: [w.projects] })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("one workspace") });
    expect(await edit({ workspaceId: w.ada.workspaceId, folderIds: [w.projects] })).toMatchObject({ workspaceId: w.ada.workspaceId, folderIds: [w.projects] });
  });

  it("holds only if the workspace and the folders are still the ones it was checked against, so two edits at once can't leave folders of one workspace on a token of another", async () => {
    const w = await world();
    const { agent } = await connectAgent(env.DB, w.ada.personId, "Racer", { workspaceId: w.ada.workspaceId });
    const done = await Promise.allSettled([editAgent(env.DB, w.ada.personId, agent.id, { workspaceId: null }), editAgent(env.DB, w.ada.personId, agent.id, { folderIds: [w.projects] })]);
    const now = (await listAgents(env.DB, w.ada.personId)).find((a) => a.id === agent.id)!;
    expect(done.filter((d) => d.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(now.folderIds === null || now.workspaceId === w.ada.workspaceId).toBe(true);
    for (const d of done) if (d.status === "rejected") expect(d.reason).toMatchObject({ code: "conflict" });
  });

  it("is the member's alone, signed in: not another member's, not an admin's, and not the agent's own with its token", async () => {
    const w = await world();
    const eve = (await addMember(w.ada, "admin", "Eve Admin")) as Member;
    await expect(editAgent(env.DB, eve.personId, w.limited.agent.id, { folderIds: null })).rejects.toMatchObject({ code: "not_found", message: "No such agent" });

    const send = (init: RequestInit & { headers: Record<string, string> }, path = `/api/agents/${w.limited.agent.id}`) => worker.fetch(new Request(`https://ink.test${path}`, init) as never, { ...env, SESSION_SECRET: "test-secret" });
    const session = async (personId: string) => ({ Cookie: `__Host-ink_session=${encodeURIComponent(await sign({ personId }, "test-secret", 3600))}` });
    const body = JSON.stringify({ folderIds: null });
    const json = { Origin: "https://ink.test", "Content-Type": "application/json" };
    // The agent's token is no session: with it, the limit can be neither lifted nor read, and no second agent made.
    expect((await send({ method: "PATCH", headers: { ...json, Authorization: `Bearer ${w.limited.token}` }, body })).status).toBe(401);
    expect((await send({ method: "POST", headers: { ...json, Authorization: `Bearer ${w.limited.token}` }, body: JSON.stringify({ name: "Free" }) }, "/api/agents")).status).toBe(401);
    expect((await send({ method: "GET", headers: { Authorization: `Bearer ${w.limited.token}` } }, "/api/agents")).status).toBe(401);
    // Nor is there a tool for it.
    const claude = await asAgent(w.limited.token);
    for (const name of ["edit_agent", "connect_agent", "set_folders"]) expect(await callTool(env.DB, (await authenticateAgent(env.DB, w.limited.token))!, name, {})).toBeNull();
    expect((await claude.call("list_notes", { folderIds: null })).text).toMatch(/^invalid: list_notes takes no "folderIds"/);

    const cookie = await session(w.ada.personId);
    expect((await send({ method: "PATCH", headers: { ...cookie, "Content-Type": "application/json", Origin: "https://evil.example" }, body })).status).toBe(403);
    expect((await send({ method: "PATCH", headers: { ...json, ...(await session(eve.personId)) }, body })).status).toBe(404);
    expect((await listAgents(env.DB, w.ada.personId)).find((a) => a.id === w.limited.agent.id)!.folderIds).toEqual([w.projects]);

    const lifted = await send({ method: "PATCH", headers: { ...cookie, ...json }, body });
    expect(lifted.status).toBe(200);
    expect(((await lifted.json()) as { agent: { folderIds: unknown } }).agent.folderIds).toBeNull();
    const made = await send({ method: "POST", headers: { ...cookie, ...json }, body: JSON.stringify({ name: "Fenced", workspaceId: w.ada.workspaceId, folderIds: [w.journal] }) }, "/api/agents");
    expect(made.status).toBe(201);
    expect(((await made.json()) as { agent: { folderIds: unknown } }).agent.folderIds).toEqual([w.journal]);
    expect((await send({ method: "POST", headers: { ...cookie, ...json }, body: JSON.stringify({ name: "Fenced", workspaceId: w.ada.workspaceId, folderIds: [MISSING] }) }, "/api/agents")).status).toBe(404);
  });
});
