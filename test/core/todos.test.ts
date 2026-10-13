import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import { todoIndex } from "../../src/core/todos.ts";
import { addMember, newMember } from "./members.ts";

type Listing = Omit<Extract<OpInput, { type: "todo.list" }>, "type">;

const create = (as: Actor, text: string, folderId?: string) => perform(env.DB, as, { type: "note.create", text, folderId });
const list = async (as: Actor, filters: Listing = {}) => (await perform(env.DB, as, { type: "todo.list", ...filters })).todos;
const words = async (as: Actor, filters: Listing = {}) => (await list(as, filters)).map((t) => t.words);
const codeOf = async (run: Promise<unknown>) => run.then(() => "done", (err) => (err instanceof OpError ? `${err.code}: ${err.message}` : Promise.reject(err)));

/** What the index holds for a note, read straight from the tables, in the shape the text gives. */
async function indexed(noteId: string) {
  const [todos, tags] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT line, done, importance, due, text FROM todos WHERE note_id = ? ORDER BY line").bind(noteId),
    env.DB.prepare("SELECT tag, name FROM note_tags WHERE note_id = ? ORDER BY rowid").bind(noteId),
  ]);
  return { todos: todos!.results.map((r) => Object.values(r)), tags: tags!.results.map((r) => Object.values(r)) };
}

const PLAN = "# Plan #work\n\n- [ ] !! Call the bank due:2026-10-14 +Home\n- [x] Book flights +Trip\n\n```\n- [ ] in code +Never\n```\n  - [ ] ! Water plants +home #garden\n- [ ] Nothing set";

describe("the index of todos", () => {
  it("holds what the note's text says from the moment the note is made", async () => {
    const ada = await newMember();
    const note = await create(ada, PLAN);

    expect(await indexed(note.id)).toEqual({
      todos: [
        [2, 0, 2, "2026-10-14", "- [ ] !! Call the bank due:2026-10-14 +Home"],
        [3, 1, 0, null, "- [x] Book flights +Trip"],
        [8, 0, 1, null, "  - [ ] ! Water plants +home #garden"],
        [9, 0, 0, null, "- [ ] Nothing set"],
      ],
      tags: [
        ["work", "work"],
        ["garden", "garden"],
      ],
    });
    expect(note.openTodos).toBe(3);
  });

  it("follows every way a note's text changes: a write, a revert, an undo, a redo, and reverting an author", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Plan\n\n- [ ] one +A");
    const same = async (text: string) => expect(await indexed(note.id), text).toEqual(todoIndex(text));
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Plan #q4\n\nIntro\n- [x] one +A\n- [ ] two due:2026-01-02 +B" });
    await same(written.text);
    await same((await perform(env.DB, ada, { type: "note.undo", id: note.id })).text);
    expect((await indexed(note.id)).todos).toEqual([[2, 0, 0, null, "- [ ] one +A"]]);
    await same((await perform(env.DB, ada, { type: "note.redo", id: note.id })).text);
    expect((await indexed(note.id)).tags).toEqual([["q4", "q4"]]);
    await same((await perform(env.DB, ada, { type: "note.revert", id: note.id, revision: 1 })).text);
    const byAgent = await perform(env.DB, claude, { type: "note.write", id: note.id, baseRevision: 5, text: "# Plan\n\n- [ ] one +A\n- [ ] the agent's +Z" });
    await same(byAgent.text);
    await perform(env.DB, ada, { type: "history.revertAuthor", author: { kind: "agent", id: agent.id } });
    expect(await indexed(note.id)).toEqual(todoIndex("# Plan\n\n- [ ] one +A"));
    await same((await perform(env.DB, ada, { type: "note.revertChanges", id: note.id, revisions: [7] })).text);
    expect((await indexed(note.id)).todos.length).toBe(2);
  });

  /** A note as one written before there was an index: no rows, and not marked as indexed. */
  const unindex = (noteId: string) =>
    env.DB.batch([
      env.DB.prepare("DELETE FROM todos WHERE note_id = ?").bind(noteId),
      env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?").bind(noteId),
      env.DB.prepare("UPDATE notes SET indexed = 0 WHERE id = ?").bind(noteId),
    ]);

  it("mends itself: notes written before there was an index are indexed when todos are first listed, with nobody running anything", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const notes = [];
    for (let i = 0; i < 45; i++) notes.push(await create(ada, `# N${i}\n\n- [ ] todo ${i} +P${i % 2} #t`));
    const diary = await create(eve, "# Diary\n\n- [ ] hers alone #secret");
    await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });
    for (const note of [...notes, diary]) await unindex(note.id);

    // Whoever lists first mends every note they can see. One they can't waits for someone who can, so nothing about it shows in what they are told.
    expect((await list(ada)).length).toBe(45);
    expect(await perform(env.DB, ada, { type: "todo.filters" })).toEqual({ tags: ["t"] });
    for (const note of notes) expect(await indexed(note.id)).toEqual(todoIndex(note.text));
    expect(await indexed(diary.id)).toEqual({ todos: [], tags: [] });
    expect(await words(eve, { tag: "secret" })).toEqual(["hers alone #secret"]);
    expect(await indexed(diary.id)).toEqual(todoIndex(diary.text));
  });

  it("mends a note on its next write, even one that leaves its todos as they were", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Old\n\n- [ ] from before +P #t");
    await unindex(note.id);

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: "# Old, renamed\n\n- [ ] from before +P #t" });
    expect(await indexed(note.id)).toEqual(todoIndex(written.text));
    expect(await env.DB.prepare("SELECT indexed FROM notes WHERE id = ?").bind(note.id).first()).toEqual({ indexed: 4 });
  });

  it("is made again from every note's text by an admin, another member's private note included, and the answer says nothing of how many", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const plan = await create(ada, "# Plan\n\n- [ ] in the open +Common");
    const diary = await create(eve, `# Diary\n\n- [ ] hers alone #secret [[${plan.id}]]`);
    await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });
    // An index and a record of links that say what the text doesn't, which no write would notice.
    await env.DB.batch([
      env.DB.prepare("UPDATE todos SET text = '- [ ] wrong', done = 1 WHERE note_id IN (?, ?)").bind(plan.id, diary.id),
      env.DB.prepare("DELETE FROM note_tags WHERE note_id = ?").bind(diary.id),
      env.DB.prepare("DELETE FROM links WHERE source_id = ?").bind(diary.id),
    ]);

    for (const type of ["todos.rebuild", "links.rebuild"] as const) expect(await codeOf(perform(env.DB, eve, { type }))).toBe(`forbidden: A editor can't ${type}`);
    const answer = await perform(env.DB, ada, { type: "todos.rebuild" });

    expect(answer).toEqual({ done: true });
    for (const note of [plan, diary]) expect(await indexed(note.id)).toEqual(todoIndex(note.text));
    expect((await env.DB.prepare("SELECT target_id FROM links WHERE source_id = ?").bind(diary.id).all()).results).toEqual([{ target_id: plan.id }]);
    expect(await words(ada, { includeCompleted: true })).toEqual(["in the open +Common"]);
    expect(await words(eve, { tag: "secret" })).toEqual([`hers alone #secret [[${plan.id}]]`]);
  });

  it("takes a long note that is nothing but todos", async () => {
    const ada = await newMember();
    const text = Array.from({ length: 20_000 }, (_, i) => `- [ ] t${i} +p${i}`).join("\n");
    const note = await create(ada, text);

    expect(await env.DB.prepare("SELECT COUNT(*) AS todos FROM todos WHERE note_id = ?").bind(note.id).first()).toEqual({ todos: 20_000 });
  });
});

describe("listing todos", () => {
  it("lists open todos, the soonest due first and then the most important, and done ones only when asked", async () => {
    const ada = await newMember();
    const plan = await create(ada, PLAN);
    await create(ada, "# Later\n\n- [ ] !!! Urgent, no date\n- [ ] Taxes due:2026-04-15 +Money");

    expect(await words(ada)).toEqual(["Taxes +Money", "Call the bank +Home", "Urgent, no date", "Water plants +home #garden", "Nothing set"]);
    expect(await words(ada, { includeCompleted: true })).toEqual(["Taxes +Money", "Call the bank +Home", "Urgent, no date", "Water plants +home #garden", "Nothing set", "Book flights +Trip"]);
    expect((await list(ada)).find((t) => t.words === "Water plants +home #garden")).toEqual({
      noteId: plan.id,
      noteTitle: "Plan #work",
      revision: 1,
      line: 8,
      text: "  - [ ] ! Water plants +home #garden",
      done: false,
      importance: 1,
      due: null,
      every: null,
      recurs: null,
      lastDone: null,
      tags: ["work", "garden"],
      words: "Water plants +home #garden",
      access: "edit",
    });
  });

  it("narrows by tag ignoring case, by importance, by a range of due days, and to those with no date", async () => {
    const ada = await newMember();
    const plan = await create(ada, PLAN);
    await create(ada, "# Later\n\n- [ ] !!! Urgent, no date\n- [ ] Taxes due:2026-04-15 +Money\n- [ ] Rent due:2026-10-15 +HOME");

    expect(await words(ada, { tag: "GARDEN" })).toEqual(["Call the bank +Home", "Water plants +home #garden", "Nothing set"]);
    expect(await words(ada, { importance: [2, 3] })).toEqual(["Call the bank +Home", "Urgent, no date"]);
    expect(await words(ada, { importance: [0] })).toEqual(["Taxes +Money", "Rent +HOME", "Nothing set"]);
    expect(await words(ada, { dueFrom: "2026-10-14", dueTo: "2026-10-14" })).toEqual(["Call the bank +Home"]);
    expect(await words(ada, { dueTo: "2026-10-14" })).toEqual(["Taxes +Money", "Call the bank +Home"]);
    expect(await words(ada, { dueFrom: "2026-10-15" })).toEqual(["Rent +HOME"]);
    expect(await words(ada, { noDue: true })).toEqual(["Urgent, no date", "Water plants +home #garden", "Nothing set"]);
    expect(await words(ada, { noteId: plan.id, tag: "work", importance: [1] })).toEqual(["Water plants +home #garden"]);
    expect(await codeOf(perform(env.DB, ada, { type: "todo.list", dueTo: "2026-02-30" }))).toMatch(/^invalid: /);
  });

  it("refuses a filter or a change it doesn't know, such as the project todos once had, and never reads it as none", async () => {
    const ada = await newMember();
    const note = await create(ada, "# Plan\n\n- [ ] Call the bank +Home\n- [ ] Taxes");
    const stale = (op: object) => codeOf(perform(env.DB, ada, op as never));
    expect(await stale({ type: "todo.list", project: "Home" })).toMatch(/^invalid: .*project/);
    expect(await stale({ type: "todo.set", id: note.id, revision: note.revision, line: 2, text: "- [ ] Call the bank +Home", removeProject: "Home" })).toMatch(/^invalid: .*removeProject/);
    expect(await stale({ type: "todo.set", id: note.id, revision: note.revision, line: 3, text: "- [ ] Taxes", done: true, addProject: "Home" })).toMatch(/^invalid: .*addProject/);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).revision).toBe(note.revision);
  });

  it("counts a todo as tagged with the tags on its own line and with its note's, the same #tags notes have", async () => {
    const ada = await newMember();
    await create(ada, "# Garden #outside\n\n- [ ] Water plants #weekly\n- [ ] Mow\n\nSomewhere else in the note: #someday");
    await create(ada, "# Desk\n\n- [ ] File papers #weekly\n- [ ] Dust");

    // Its own line's tag, which tags the note too, so the note's other todo is listed under it as well.
    expect(await words(ada, { tag: "weekly" })).toEqual(["File papers #weekly", "Dust", "Water plants #weekly", "Mow"]);
    // The note's tag, from its title and from a line that is no todo.
    expect(await words(ada, { tag: "outside" })).toEqual(["Water plants #weekly", "Mow"]);
    expect(await words(ada, { tag: "SomeDay" })).toEqual(["Water plants #weekly", "Mow"]);
    // A listed todo says its note's tags, and its own are the ones its text writes.
    expect((await list(ada, { tag: "outside" })).map((t) => [t.text, t.tags])).toEqual([
      ["- [ ] Water plants #weekly", ["outside", "weekly", "someday"]],
      ["- [ ] Mow", ["outside", "weekly", "someday"]],
    ]);
    expect(await perform(env.DB, ada, { type: "todo.filters" })).toEqual({ tags: ["outside", "someday", "weekly"] });
  });

  it("narrows to a folder with every folder under it, inside what the asker can see, and a folder they can't see is no folder", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const folder = async (name: string, parentId?: string) => (await perform(env.DB, ada, { type: "folder.create", name, parentId })).id;
    const [house, work] = [await folder("House"), await folder("Work")];
    const inGarden = await folder("Garden", house);
    const deepest = await folder("Shed", inGarden);
    await create(ada, "# Loose\n\n- [ ] unsorted one");
    await create(ada, "# Rooms\n\n- [ ] paint the hall #home", house);
    await create(ada, "# Beds\n\n- [ ] weed", inGarden);
    await create(ada, "# Tools\n\n- [ ] oil the shears\n- [x] sharpen the spade", deepest);
    await create(ada, "# Launch\n\n- [ ] ship it", work);
    const diary = await create(eve, "# Diary\n\n- [ ] hers alone", inGarden);
    await perform(env.DB, eve, { type: "note.setPrivate", id: diary.id, private: true });

    expect((await words(ada, { folderId: house })).sort()).toEqual(["oil the shears", "paint the hall #home", "weed"]);
    expect((await words(ada, { folderId: inGarden, includeCompleted: true })).sort()).toEqual(["oil the shears", "sharpen the spade", "weed"]);
    expect(await words(ada, { folderId: deepest })).toEqual(["oil the shears"]);
    expect(await words(ada, { folderId: work })).toEqual(["ship it"]);
    // It narrows with the other filters, and never widens what is seen: the private note in the folder is its owner's only.
    expect(await words(ada, { folderId: house, tag: "home" })).toEqual(["paint the hall #home"]);
    expect((await words(eve, { folderId: house })).sort()).toEqual(["hers alone", "oil the shears", "paint the hall #home", "weed"]);

    // A guest given one folder: the folder above it, and a folder beside it, are no folders to them, in the words any op uses.
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email: guestEmail, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
    await perform(env.DB, ada, { type: "grant.set", folderId: inGarden, email: guestEmail, access: "view" });
    const NO_FOLDER = "not_found: No such folder";
    expect((await words(guest, { folderId: inGarden })).sort()).toEqual(["oil the shears", "weed"]);
    expect(await codeOf(perform(env.DB, guest, { type: "todo.list", folderId: house }))).toBe(NO_FOLDER);
    expect(await codeOf(perform(env.DB, guest, { type: "todo.list", folderId: work }))).toBe(NO_FOLDER);
    expect(await codeOf(perform(env.DB, ada, { type: "todo.list", folderId: "nosuchfolder" }))).toBe(NO_FOLDER);
    const other = await newMember();
    expect(await codeOf(perform(env.DB, other, { type: "todo.list", folderId: house }))).toBe(NO_FOLDER);
  });

  it("comes a page at a time", async () => {
    const ada = await newMember();
    await create(ada, `# Many\n\n${Array.from({ length: 5 }, (_, i) => `- [ ] t${i} due:2026-01-0${i + 1}`).join("\n")}`);

    const first = await perform(env.DB, ada, { type: "todo.list", limit: 2 });
    const second = await perform(env.DB, ada, { type: "todo.list", limit: 2, offset: first.next! });
    const third = await perform(env.DB, ada, { type: "todo.list", limit: 2, offset: second.next! });
    expect([first, second, third].map((page) => [page.todos.map((t) => t.words), page.next])).toEqual([[["t0", "t1"], 2], [["t2", "t3"], 4], [["t4"], null]]);
  });

  it("says nothing of a todo in a note the asker can't see: not the todo, its note's tag, or a count", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve Editor");
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email: guestEmail, name: "Gus Guest" })).personId, workspaceId: ada.workspaceId };
    const shared = await create(ada, "# Shared #open\n\n- [ ] seen by all +Common");
    const granted = await create(ada, "# Granted #lent\n\n- [ ] for the guest +Lent");
    const secret = await create(eve, "# Diary #private\n\n- [ ] hidden +Secret due:2026-01-01\n- [x] hidden and done +Secret");
    await perform(env.DB, eve, { type: "note.setPrivate", id: secret.id, private: true });
    await perform(env.DB, ada, { type: "grant.set", noteId: granted.id, email: guestEmail, access: "view" });
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const adasAgent: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    const seenBy = async (as: Actor) => ({
      todos: (await words(as, { includeCompleted: true })).sort(),
      byTag: await words(as, { tag: "private", includeCompleted: true }),
      byNote: await words(as, { noteId: secret.id, includeCompleted: true }),
      filters: await perform(env.DB, as, { type: "todo.filters" }),
    });
    const hidden = { byTag: [], byNote: [] };

    expect(await seenBy(eve)).toEqual({ todos: ["for the guest +Lent", "hidden +Secret", "hidden and done +Secret", "seen by all +Common"], byTag: ["hidden +Secret", "hidden and done +Secret"], byNote: ["hidden +Secret", "hidden and done +Secret"], filters: { tags: ["lent", "open", "private"] } });
    for (const admin of [ada, adasAgent]) expect(await seenBy(admin)).toEqual({ ...hidden, todos: ["for the guest +Lent", "seen by all +Common"], filters: { tags: ["lent", "open"] } });
    expect(await seenBy(guest)).toEqual({ ...hidden, todos: ["for the guest +Lent"], filters: { tags: ["lent"] } });
    expect((await list(guest))[0]!.access).toBe("view");
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: secret.id, revision: 1, line: 2, text: "- [ ] hidden +Secret due:2026-01-01", done: true }))).toBe("not_found: No such note");
  });
});

describe("changing a todo from a listing", () => {
  const setUp = async () => {
    const ada = await newMember("Ada Lovelace");
    const note = await create(ada, PLAN);
    const todo = (await list(ada)).find((t) => t.words === "Call the bank +Home")!;
    return { ada, note, todo, at: { id: note.id, line: todo.line, text: todo.text, revision: todo.revision } };
  };
  const lineOf = async (as: Actor, id: string, line: number) => (await perform(env.DB, as, { type: "note.read", id })).text.split("\n")[line];

  it("checks it off as one recorded change by whoever asked, and touches no other line", async () => {
    const { ada, note, at } = await setUp();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude");
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId };

    const after = await perform(env.DB, claude, { type: "todo.set", ...at, done: true });

    expect(after.text).toBe(PLAN.replace("- [ ] !! Call", "- [x] !! Call"));
    expect([after.revision, after.openTodos, after.updatedBy.kind]).toEqual([2, 2, "agent"]);
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).map((c) => [c.revision, c.author.name])).toEqual([[1, "Ada Lovelace"], [2, "Claude"]]);
    expect(await words(ada)).toEqual(["Water plants +home #garden", "Nothing set"]);
    expect((await perform(env.DB, claude, { type: "note.undo", id: note.id })).text).toBe(PLAN);
  });

  it("changes importance and the due date, each by rewriting its token, and a +Name on the line stays as it is written", async () => {
    const { ada, note, at } = await setUp();

    const changed = await perform(env.DB, ada, { type: "todo.set", ...at, importance: 3, due: "2026-11-01" });
    expect(changed.text.split("\n")[2]).toBe("- [ ] !!! Call the bank due:2026-11-01 +Home");
    const cleared = await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 2, line: 2, text: "- [ ] !!! Call the bank due:2026-11-01 +Home", importance: 0, due: null, done: false });
    expect(cleared.text).toBe(PLAN.replace("- [ ] !! Call the bank due:2026-10-14 +Home", "- [ ] Call the bank +Home"));
    expect(cleared.revision).toBe(3);
    expect(await perform(env.DB, ada, { type: "todo.filters" })).toEqual({ tags: ["garden", "work"] });
  });

  it("follows the todo through the changes made since it was listed, and refuses when the todo itself was changed", async () => {
    const { ada, note, at } = await setUp();
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `New first line\n- [ ] Another todo\n${PLAN}` });

    const moved = await perform(env.DB, ada, { type: "todo.set", ...at, done: true });
    expect(moved.text).toBe(`New first line\n- [ ] Another todo\n${PLAN.replace("- [ ] !! Call", "- [x] !! Call")}`);

    const CONFLICT = "conflict: This todo was changed since it was listed. List the todos again.";
    // Listed as it never read, at the revision named.
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 3, line: 11, text: "- [ ] Nothing set at all", done: true }))).toBe(CONFLICT);
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 3, line: 7, text: "- [ ] in code +Never", done: true }))).toBe(CONFLICT);
    // Changed since: the line that was listed now reads otherwise.
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 3, text: moved.text.replace("- [ ] Nothing set", "- [ ] Something set") });
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 3, line: 11, text: "- [ ] Nothing set", done: true }))).toBe(CONFLICT);
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 9, line: 11, text: "- [ ] Something set", done: true }))).toMatch(/^invalid: The note has no revision 9/);
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).revision).toBe(4);
  });

  describe("with another todo that reads exactly the same", () => {
    const TWINS = "# Twins\n\n- [ ] same +P\n- [ ] same +P\nAfter";
    const twins = async () => {
      const ada = await newMember();
      const note = await create(ada, TWINS);
      return { ada, note, second: { id: note.id, revision: 1, line: 3, text: "- [ ] same +P" } };
    };
    const lines = async (as: Actor, id: string) => (await perform(env.DB, as, { type: "note.read", id })).text.split("\n");

    it("changes the one that was listed and never its twin, however often the same call is made", async () => {
      for (const change of [{ done: true }, { importance: 2 as const }, { due: "2026-10-14" }]) {
        const { ada, note, second } = await twins();
        const once = await perform(env.DB, ada, { type: "todo.set", ...second, ...change });
        const again = await perform(env.DB, ada, { type: "todo.set", ...second, ...change });

        expect([once.revision, again.revision], JSON.stringify(change)).toEqual([2, 2]);
        expect((await lines(ada, note.id))[2], JSON.stringify(change)).toBe("- [ ] same +P");
        expect((await lines(ada, note.id))[3], JSON.stringify(change)).not.toBe("- [ ] same +P");
      }
    });

    it("follows the listed one when a line added above puts its twin on the line it was listed on", async () => {
      const { ada, note, second } = await twins();
      await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: TWINS.replace("# Twins\n", "# Twins\nA new line\n") });

      await perform(env.DB, ada, { type: "todo.set", ...second, done: true });
      expect(await lines(ada, note.id)).toEqual(["# Twins", "A new line", "", "- [ ] same +P", "- [x] same +P", "After"]);
    });

    it("refuses when the listed one was rewritten in place, and leaves its twin alone", async () => {
      const { ada, note, second } = await twins();
      const edited = TWINS.replace("- [ ] same +P\nAfter", "- [ ] other words\nAfter");
      await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: edited });

      expect(await codeOf(perform(env.DB, ada, { type: "todo.set", ...second, done: true }))).toMatch(/^conflict: /);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe(edited);
    });

    it("completes at most one todo when one of the two was deleted, whichever was listed", async () => {
      const { ada, note, second } = await twins();
      const deleted = "# Twins\n\n- [ ] same +P\nAfter";
      await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: deleted });

      // Which of two identical lines a deletion took is not in the text: the one left is the one the record says was kept.
      const outcomes = [await codeOf(perform(env.DB, ada, { type: "todo.set", ...second, line: 2, done: true })), await codeOf(perform(env.DB, ada, { type: "todo.set", ...second, done: true }))];
      expect(outcomes.filter((o) => o === "done")).toEqual(["done"]);
      expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).text).toBe(deleted.replace("[ ]", "[x]"));
    });
  });

  it("is done once when the same call is made again, and records nothing when nothing changes", async () => {
    const { ada, note, at } = await setUp();

    await perform(env.DB, ada, { type: "todo.set", ...at, done: true, due: "2026-12-01" });
    const again = await perform(env.DB, ada, { type: "todo.set", ...at, done: true, due: "2026-12-01" });
    expect([again.revision, await lineOf(ada, note.id, 2)]).toEqual([2, "- [x] !! Call the bank due:2026-12-01 +Home"]);
    const same = await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 2, line: 9, text: "- [ ] Nothing set", done: false, importance: 0, due: null });
    expect(same.revision).toBe(2);
  });

  it("is refused to a viewer, to a guest who can only view, and to a read-only agent, and takes a guest with edit", async () => {
    const { ada, note, at } = await setUp();
    const vera = await addMember(ada, "viewer", "Vera Viewer");
    const guestOf = async (access: "view" | "edit") => {
      const email = `${crypto.randomUUID()}@example.com`;
      await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email, access });
      return { kind: "member", personId: (await signIn(env.DB, { email, name: "A Guest" })).personId, workspaceId: ada.workspaceId } satisfies Actor;
    };
    const [viewing, editing] = [await guestOf("view"), await guestOf("edit")];
    const { agent } = await connectAgent(env.DB, ada.personId, "Reader", { readOnly: true });
    const reader: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId, scope: { readOnly: true } };

    expect(await codeOf(perform(env.DB, vera, { type: "todo.set", ...at, done: true }))).toBe("forbidden: A viewer can't todo.set");
    expect(await codeOf(perform(env.DB, viewing, { type: "todo.set", ...at, done: true }))).toMatch(/^forbidden: /);
    expect(await codeOf(perform(env.DB, reader, { type: "todo.set", ...at, done: true }))).toBe("forbidden: A read-only token can't todo.set");
    expect(await lineOf(ada, note.id, 2)).toBe(at.text);
    expect((await list(vera)).map((t) => t.access)).toEqual(["view", "view", "view"]);
    expect((await perform(env.DB, editing, { type: "todo.set", ...at, done: true })).updatedBy.name).toBe("A Guest");
  });

  it("refuses a change that would make the note too long", async () => {
    const ada = await newMember();
    const note = await create(ada, `- [ ] a\n${"x".repeat(499_990)}`);

    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 0, text: "- [ ] a", due: "2026-01-01" }))).toMatch(/^invalid: With the other changes merged in, the note would be over/);
  });
});
