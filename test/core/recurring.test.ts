import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signIn } from "../../src/core/accounts.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { dailySettings } from "../../src/core/daily.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { OpError, type OpInput } from "../../src/core/protocol.ts";
import { changesBetween } from "../../src/core/text.ts";
import { checkedOff, completeTodo, parseTodo, rewriteTodo, rolledForward, todoIndex } from "../../src/core/todos.ts";
import { addMember, newMember } from "./members.ts";

const SUNDAY = "2026-10-11";
/** Noon in UTC on that Sunday. */
const NOON = Date.UTC(2026, 9, 11, 12);
const WATER = "- [ ] ! Water the plants due:2026-10-10 every:1w +Home";
const WATERED = "- [ ] ! Water the plants due:2026-10-17 every:1w +Home done:2026-10-11x1";
const FILED = "- [x] ! Water the plants due:2026-10-10 +Home";

const create = (as: Actor, text: string, folderId?: string) => perform(env.DB, as, { type: "note.create", text, folderId });
const read = (as: Actor, id: string) => perform(env.DB, as, { type: "note.read", id });
const revisionOf = async (id: string) => (await env.DB.prepare("SELECT revision FROM notes WHERE id = ?").bind(id).first<{ revision: number }>())!.revision;
/** Checks a todo off as listed just now, unless `more` says which revision it was listed at. */
const check = async (as: Actor, id: string, line: number, text: string, more: Partial<Extract<OpInput, { type: "todo.set" }>> = {}, now = NOON) =>
  perform(env.DB, as, { type: "todo.set", id, revision: await revisionOf(id), line, text, done: true, on: SUNDAY, ...more }, now);
const history = async (as: Actor, id: string, line: number, text: string) => perform(env.DB, as, { type: "todo.history", id, revision: await revisionOf(id), line, text });
const settings = (as: Actor, value: object) => perform(env.DB, as, { type: "settings.write", text: JSON.stringify(value), baseRevision: 0 });
const codeOf = async (run: Promise<unknown>) => run.then(() => "done", (err) => (err instanceof OpError ? err.code : Promise.reject(err)));
const agentOf = async (member: Actor, name = "Claude"): Promise<Actor> => ({ kind: "agent", agentId: (await connectAgent(env.DB, member.personId, name)).agent.id, personId: member.personId, workspaceId: member.workspaceId });

async function dailies(of: Actor) {
  const { results } = await env.DB.prepare("SELECT d.day, d.note_id, n.text, n.private_owner, f.name AS folder FROM daily_notes d JOIN notes n ON n.id = d.note_id JOIN folders f ON f.id = n.folder_id WHERE d.workspace_id = ? AND d.person_id = ? ORDER BY d.day")
    .bind(of.workspaceId, of.personId)
    .all<{ day: string; note_id: string; text: string; private_owner: string | null; folder: string }>();
  return results;
}

async function indexed(noteId: string) {
  const { results } = await env.DB.prepare("SELECT line, done, importance, due, text FROM todos WHERE note_id = ? ORDER BY line").bind(noteId).all<Record<string, unknown>>();
  return results.map((r) => Object.values(r));
}

describe("how a recurring todo is written", () => {
  it("reads every: and done: as tokens of the todo, and leaves them out of its words", () => {
    const todo = parseTodo("- [ ] Water the plants due:2026-10-10 every:mon,thu done:2026-10-08x12 +Home")!;
    expect(todo.every).toMatchObject({ written: "mon,thu", rule: { kind: "weekdays", days: [1, 4] } });
    expect(todo.lastDone).toMatchObject({ on: "2026-10-08", times: 12 });
    expect(todo.words).toBe("Water the plants");
    expect(parseTodo("- [ ] Stretch every:1d done:2026-10-08")!.lastDone).toMatchObject({ on: "2026-10-08", times: 1 });
  });

  it.each(["every:fortnight", "every:0d", "every:2th-day", "every:Mon", "everyone:2w", "x-every:2w", "done:2026-02-30x2", "done:yesterday"])("takes %s for words", (token) => {
    const todo = parseTodo(`- [ ] Call ${token}`)!;
    expect([todo.every, todo.lastDone, todo.words]).toEqual([null, null, `Call ${token}`]);
  });

  it("reads a rule before punctuation, takes the first of two, and none in code or outside a todo", () => {
    expect(parseTodo("- [ ] Review every:2w. Then every:3d")!.every).toMatchObject({ written: "2w" });
    expect(parseTodo("- [ ] Standup every:mon, then coffee")!.every).toMatchObject({ written: "mon" });
    expect(parseTodo("- [ ] Type `every:2w` here")!.every).toBeNull();
    expect(parseTodo("Water every:2w")).toBeNull();
  });

  it("sets, changes and takes away how a todo recurs, touching nothing else on the line", () => {
    expect(rewriteTodo("  * [ ] Pay rent  due:2026-11-01 +Home", { every: "1m" })).toBe("  * [ ] Pay rent  due:2026-11-01 +Home every:1m");
    expect(rewriteTodo("- [ ] Pay rent every:1m due:2026-11-01", { every: "1st-day" })).toBe("- [ ] Pay rent every:1st-day due:2026-11-01");
    expect(rewriteTodo("- [ ] Pay rent every:1m due:2026-11-01", { every: null })).toBe("- [ ] Pay rent due:2026-11-01");
    expect(() => rewriteTodo("- [ ] Pay rent", { every: "sometimes" })).toThrow(RangeError);
  });

  it.each([WATER, "- [ ] Stretch every:mon,wed,fri done:2026-10-09x40", "1. [x] Old every:3d-after-done due:2026-01-01 done:2026-01-01", "- [ ] Bins every:2nd-last-fri."])("leaves %s as written when nothing is asked of it", (line) => {
    expect(rewriteTodo(line, {})).toBe(line);
    expect(rewriteTodo(line, { every: parseTodo(line)!.every!.written })).toBe(line);
  });

  it("checks a recurring todo off by moving its due date on, counting it, and handing back the checked line to file", () => {
    expect(completeTodo(WATER, SUNDAY)).toEqual({ line: WATERED, filed: FILED });
    expect(completeTodo(WATERED, "2026-10-17")).toEqual({ line: "- [ ] ! Water the plants due:2026-10-24 every:1w +Home done:2026-10-17x2", filed: "- [x] ! Water the plants due:2026-10-17 +Home" });
  });

  it("gives a recurring todo with no due date one, from the day it was done", () => {
    expect(completeTodo("  - [ ] Stretch every:3d", SUNDAY)).toEqual({ line: "  - [ ] Stretch every:3d due:2026-10-14 done:2026-10-11x1", filed: "- [x] Stretch" });
    expect(completeTodo("- [ ] Review every:mon,thu", SUNDAY).line).toBe("- [ ] Review every:mon,thu due:2026-10-12 done:2026-10-11x1");
  });

  it("checks a recurring todo off for good when its next due date would be past the year 9999, and leaves a done one alone", () => {
    expect(completeTodo("- [ ] Last every:1y due:9999-06-01", SUNDAY)).toEqual({ line: "- [x] Last every:1y due:9999-06-01", filed: null });
    expect(completeTodo("- [x] Done every:1w", SUNDAY)).toEqual({ line: "- [x] Done every:1w", filed: null });
  });
});

describe("which todos a write checked off", () => {
  const was = `# Chores\n\n${WATER}\n- [ ] Bins every:2w\n- [x] Old every:1w\n- [ ] Plain`;
  const lines = (text: string) => checkedOff(was, changesBetween(was, text)).map((t) => t.text);

  it("is each recurring todo whose box alone was checked, with x or X", () => {
    expect(lines(was.replace("- [ ] ! Water", "- [x] ! Water"))).toEqual([WATER.replace("[ ]", "[x]")]);
    expect(lines(was.replace("- [ ] ! Water", "- [X] ! Water").replace("- [ ] Bins", "- [x] Bins"))).toEqual([WATER.replace("[ ]", "[X]"), "- [x] Bins every:2w"]);
  });

  it("is a todo whose box was checked while the rest of its line was changed, lines were added around it, or its rule was written", () => {
    expect(lines(was.replace("- [ ] Bins every:2w", "- [x] Bins and boxes every:2w +Home"))).toEqual(["- [x] Bins and boxes every:2w +Home"]);
    expect(lines(was.replace("- [ ] Bins every:2w", "Above\n- [x] Bins every:2w\nBelow"))).toEqual(["- [x] Bins every:2w"]);
    expect(lines(was.replace("- [ ] Plain", "- [x] Plain every:1d"))).toEqual(["- [x] Plain every:1d"]);
  });

  it("is not a todo that doesn't recur, one that was already done, one written already checked, or one that took a deleted todo's place", () => {
    expect(lines(was.replace("- [ ] Plain", "- [x] Plain"))).toEqual([]);
    expect(lines(`${was}\n- [x] New every:1d`)).toEqual([]);
    expect(lines(was.replace(`${WATER}\n`, ""))).toEqual([]);
    expect(lines(was.replace("- [ ] Bins every:2w\n", ""))).toEqual([]);
    expect(checkedOff("- [ ] A every:1w\n- [x] B every:1w", changesBetween("- [ ] A every:1w\n- [x] B every:1w", "- [x] B every:1w"))).toEqual([]);
  });

  it("tells a line just checked from one that reads the same and stood checked", () => {
    const twice = "- [x] Bins every:2w\n- [ ] Bins every:2w";
    expect(checkedOff(twice, changesBetween(twice, "- [x] Bins every:2w\n- [x] Bins every:2w")).map((t) => t.line)).toEqual([1]);
  });

  it("rolls each forward in the text, and says what to file and where its line is", () => {
    const text = was.replace("- [ ] ! Water", "- [x] ! Water");
    const rolled = rolledForward(text, checkedOff(was, changesBetween(was, text)), SUNDAY);
    expect(rolled.text).toBe(was.replace(WATER, WATERED));
    expect(rolled.filed).toEqual([{ line: FILED, at: was.indexOf(WATER) }]);
  });
});

describe("what a member's settings say of daily notes", () => {
  it("defaults to the folder Daily, private, and no time zone, for settings that say nothing or can't be read", () => {
    for (const text of [null, "{}", "not json", "[]", JSON.stringify({ "daily.folder": 3, "daily.private": "yes", "daily.timeZone": "Mars/Olympus" }), JSON.stringify({ "daily.folder": "a/b" }), JSON.stringify({ "daily.folder": "   " })]) {
      expect(dailySettings(text), String(text)).toEqual({ folder: "Daily", private: true, timeZone: null });
    }
  });

  it("takes a folder name, whether new daily notes are private, and a time zone", () => {
    expect(dailySettings(JSON.stringify({ "daily.folder": " Journal ", "daily.private": false, "daily.timeZone": "America/Chicago" }))).toEqual({ folder: "Journal", private: false, timeZone: "America/Chicago" });
  });
});

describe("checking off a recurring todo", () => {
  it("keeps the line with its next due date, and files the checked line on the completer's daily note, which is made for it", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}\n- [ ] Plain`);

    const done = await check(ada, note.id, 2, WATER);

    expect(done.text).toBe(`# Chores\n\n${WATERED}\n- [ ] Plain`);
    const [daily, ...others] = await dailies(ada);
    expect(others).toEqual([]);
    expect(daily).toMatchObject({ day: SUNDAY, folder: "Daily", private_owner: ada.personId, text: `# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n` });
    expect(done.filed).toEqual({ on: SUNDAY, dailyNoteId: daily!.note_id, todos: 1 });
    expect((await read(ada, daily!.note_id)).title).toBe(SUNDAY);
    expect((await perform(env.DB, ada, { type: "note.backlinks", id: note.id })).map((n) => n.id)).toEqual([daily!.note_id]);
  });

  it("records the change in both notes as the completer's, and keeps the index of todos in step with both", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}`);
    const claude = await agentOf(ada);

    const done = await check(claude, note.id, 2, WATER);

    const by = async (id: string) => (await perform(env.DB, ada, { type: "note.history", id })).at(-1)!.author;
    expect(await by(note.id)).toMatchObject({ kind: "agent", name: "Claude" });
    expect(await by(done.filed!.dailyNoteId!)).toMatchObject({ kind: "agent", name: "Claude" });
    for (const id of [note.id, done.filed!.dailyNoteId!]) expect(await indexed(id)).toEqual(todoIndex((await read(ada, id)).text).todos);
  });

  it("files an agent's completion on its member's daily note, and each member's on their own", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const note = await create(ada, `# Chores\n\n${WATER}\n- [ ] Bins every:2w`);

    await check(await agentOf(eve), note.id, 2, WATER);
    await check(ada, note.id, 3, "- [ ] Bins every:2w");

    expect((await dailies(eve)).map((d) => d.text)).toEqual([`# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`]);
    expect((await dailies(ada)).map((d) => d.text)).toEqual([`# ${SUNDAY}\n\n- [x] Bins [[${note.id}]]\n`]);
    expect((await perform(env.DB, eve, { type: "note.list" })).some((n) => n.title === SUNDAY && n.private)).toBe(true);
    // A daily note is private, so the todo's words go no further than the one who checked it.
    expect((await perform(env.DB, eve, { type: "todo.list", includeCompleted: true })).todos.filter((t) => t.done).map((t) => t.text)).toEqual([`${FILED} [[${note.id}]]`]);
  });

  it("adds to the day's daily note once it is there, and starts another the next day", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}\n- [ ] Bins every:2w`);

    await check(ada, note.id, 2, WATER);
    await check(ada, note.id, 3, "- [ ] Bins every:2w");
    await check(ada, note.id, 2, WATERED, { on: "2026-10-18" });

    expect((await dailies(ada)).map((d) => [d.day, d.text])).toEqual([
      [SUNDAY, `# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n- [x] Bins [[${note.id}]]\n`],
      ["2026-10-18", `# 2026-10-18\n\n- [x] ! Water the plants due:2026-10-17 +Home [[${note.id}]]\n`],
    ]);
    expect((await read(ada, note.id)).text).toContain("due:2026-10-24 every:1w +Home done:2026-10-18x2");
  });

  it("adds after whatever the member wrote on their daily note, on a line of its own", async () => {
    const ada = await newMember();
    const daily = await perform(env.DB, ada, { type: "daily.open", on: SUNDAY });
    await perform(env.DB, ada, { type: "note.write", id: daily.id, baseRevision: daily.revision, text: `# ${SUNDAY}\n\nSlept well` });
    const note = await create(ada, WATER);

    await check(ada, note.id, 0, WATER);

    expect((await read(ada, daily.id)).text).toBe(`# ${SUNDAY}\n\nSlept well\n${FILED} [[${note.id}]]\n`);
  });

  it("is done once when asked twice, as a double click or a call sent again is", async () => {
    const ada = await newMember();
    const note = await create(ada, WATER);

    const first = await check(ada, note.id, 0, WATER, { revision: 1 });
    const again = await check(ada, note.id, 0, WATER, { revision: 1 });

    expect(again.text).toBe(WATERED);
    expect(again.revision).toBe(first.revision);
    expect((await dailies(ada)).map((d) => d.text)).toEqual([`# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`]);
    expect((await history(ada, note.id, 0, WATERED)).completions).toHaveLength(1);
  });

  it("is done once when asked twice in a note where another todo reads the same, which is not completed in its place", async () => {
    const ada = await newMember();
    const note = await create(ada, `${WATER}\n${WATER}`);

    await check(ada, note.id, 0, WATER, { revision: 1 });
    const again = await check(ada, note.id, 0, WATER, { revision: 1 });

    expect(again.text).toBe(`${WATERED}\n${WATER}`);
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`);
  });

  it("is done once when the write that checked the box is sent again with no id, and leaves the box open", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}`);
    const write = { type: "note.write", id: note.id, baseRevision: 1, text: `# Chores\n\n${WATER.replace("[ ]", "[x]")}`, on: SUNDAY } as const;

    const first = await perform(env.DB, ada, write);
    const again = await perform(env.DB, ada, write);

    expect(again.text).toBe(`# Chores\n\n${WATERED}`);
    expect(again.revision).toBe(first.revision);
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`);
  });

  it("makes one daily note when two todos are checked off at the same moment", async () => {
    const ada = await newMember();
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((name) => create(ada, `- [ ] ${name} every:1d`)));

    await Promise.all([a, b, c].map((note, i) => check(ada, note!.id, 0, `- [ ] ${"ABC"[i]} every:1d`)));

    const mine = await dailies(ada);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text.split("\n").filter((line) => line.startsWith("- [x]")).map((line) => line.slice(6, 7)).sort()).toEqual(["A", "B", "C"]);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM folders WHERE workspace_id = ? AND name = 'Daily'").bind(ada.workspaceId).all<{ n: number }>();
    expect(results[0]!.n).toBe(1);
  });

  it("changes neither note when either can't be changed", async () => {
    const ada = await newMember();
    const note = await create(ada, WATER);
    // The record of this completion is already taken, which fails the batch after both notes' statements.
    await env.DB.prepare("INSERT INTO completions (note_id, revision, at, author_kind, author_id, done_on, created_at) VALUES (?, 2, 0, 'member', ?, ?, 0)").bind(note.id, ada.personId, SUNDAY).run();

    await expect(check(ada, note.id, 0, WATER)).rejects.toThrow();

    expect((await read(ada, note.id)).text).toBe(WATER);
    expect(await dailies(ada)).toEqual([]);
    const { results } = await env.DB.prepare("SELECT name FROM folders WHERE workspace_id = ? AND name = 'Daily'").bind(ada.workspaceId).all();
    expect(results).toEqual([]);
  });

  it("is the same completion when the box is checked by a write: typed, in vim, or by an agent writing the note", async () => {
    const ada = await newMember();
    const set = await create(ada, `# Chores\n\n${WATER}`);
    const typed = await create(ada, `# Chores\n\n${WATER}`);

    const bySet = await check(ada, set.id, 2, WATER);
    const byWrite = await perform(env.DB, await agentOf(ada), { type: "note.write", id: typed.id, baseRevision: 1, text: `# Chores\n\n${WATER.replace("[ ]", "[x]")}`, on: SUNDAY }, NOON);

    expect(byWrite.text).toBe(bySet.text);
    expect(byWrite.filed).toEqual({ on: SUNDAY, dailyNoteId: bySet.filed!.dailyNoteId, todos: 1 });
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n${FILED} [[${set.id}]]\n${FILED} [[${typed.id}]]\n`);
  });

  it("completes a todo checked by a write that was based on an older revision, with the other changes kept", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}`);
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `# Chores\n\nA line above\n${WATER}` });

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `# Chores\n\n${WATER.replace("[ ]", "[x]")}\nAnd one below`, on: SUNDAY });

    expect(written.text).toBe(`# Chores\n\nA line above\n${WATERED}\nAnd one below`);
    expect(written.filed?.todos).toBe(1);
  });

  it("records a write once that is sent twice with the same id, and files once", async () => {
    const ada = await newMember();
    const note = await create(ada, WATER);
    const write = { type: "note.write", id: note.id, baseRevision: 1, text: WATER.replace("[ ]", "[x]"), writeId: "w1", on: SUNDAY } as const;

    await perform(env.DB, ada, write);
    const again = await perform(env.DB, ada, write);

    expect(again.text).toBe(WATERED);
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`);
  });

  it("leaves a write alone that checks nothing off: a new line written checked, and a plain todo", async () => {
    const ada = await newMember();
    const note = await create(ada, `${WATER}\n- [ ] Plain`);
    const text = `${WATER}\n- [x] Plain\n- [x] New every:1d`;

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text, on: SUNDAY });

    expect(written.text).toBe(text);
    expect(written.filed).toBeUndefined();
    expect(await dailies(ada)).toEqual([]);
  });

  it("completes a todo whose box was checked in the same write that changed its line, as a word typed right after the click is", async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}`);

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `# Chores\n\n- [x] ! Water the plants today due:2026-10-10 every:1w +Home`, on: SUNDAY });

    expect(written.text).toBe("# Chores\n\n- [ ] ! Water the plants today due:2026-10-17 every:1w +Home done:2026-10-11x1");
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n- [x] ! Water the plants today due:2026-10-10 +Home [[${note.id}]]\n`);
  });

  it("completes a todo checked on an older revision when someone else changed its line since, and not one someone else completed since", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const note = await create(ada, `${WATER}\n- [ ] Bins every:2w`);
    await perform(env.DB, eve, { type: "note.write", id: note.id, baseRevision: 1, text: `${WATER.replace("! Water", "!!! Water")}\n- [ ] Bins every:2w` });
    await check(eve, note.id, 1, "- [ ] Bins every:2w");

    const written = await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 1, text: `${WATER.replace("[ ]", "[x]")}\n- [x] Bins every:2w`, on: SUNDAY });

    expect(written.text).toBe(`${WATERED.replace("! Water", "!!! Water")}\n- [ ] Bins every:2w due:2026-10-25 done:${SUNDAY}x1`);
    expect(written.filed?.todos).toBe(1);
    expect((await dailies(ada))[0]!.text).toBe(`# ${SUNDAY}\n\n- [x] !!! Water the plants due:2026-10-10 +Home [[${note.id}]]\n`);
  });

  it("is not done again by an undo, a redo or a revert, which put the line back as it was", async () => {
    const ada = await newMember();
    const note = await create(ada, WATER);
    await check(ada, note.id, 0, WATER);

    expect((await perform(env.DB, ada, { type: "note.undo", id: note.id })).text).toBe(WATER);
    expect((await history(ada, note.id, 0, WATER)).completions).toEqual([]);
    expect((await perform(env.DB, ada, { type: "note.redo", id: note.id })).text).toBe(WATERED);
    expect((await perform(env.DB, ada, { type: "note.revert", id: note.id, revision: 1 })).text).toBe(WATER);
  });

  it("files a todo that is on the daily note itself with the one change", async () => {
    const ada = await newMember();
    const daily = await perform(env.DB, ada, { type: "daily.open", on: SUNDAY });
    const written = await perform(env.DB, ada, { type: "note.write", id: daily.id, baseRevision: daily.revision, text: `# ${SUNDAY}\n\n- [ ] Stretch every:1d\n` });

    const done = await check(ada, daily.id, 2, "- [ ] Stretch every:1d");

    expect(done.text).toBe(`# ${SUNDAY}\n\n- [ ] Stretch every:1d due:2026-10-12 done:${SUNDAY}x1\n- [x] Stretch [[${daily.id}]]\n`);
    expect(done.revision).toBe(written.revision + 1);
  });

  it("sets how a todo recurs and checks it off in one call, and stops it recurring", async () => {
    const ada = await newMember();
    const note = await create(ada, "- [ ] Bins due:2026-10-09\n- [ ] Rent every:1m");

    expect((await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 1, line: 0, text: "- [ ] Bins due:2026-10-09", every: "2w" })).text).toContain("- [ ] Bins due:2026-10-09 every:2w\n");
    expect((await perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 2, line: 1, text: "- [ ] Rent every:1m", every: null, done: true, on: SUNDAY })).text).toContain("- [x] Rent");
    expect(await codeOf(perform(env.DB, ada, { type: "todo.set", id: note.id, revision: 3, line: 0, text: "- [ ] Bins due:2026-10-09 every:2w", every: "sometimes" }))).toBe("invalid");
    expect(await dailies(ada)).toEqual([]);
  });

  it("lists a todo with how it recurs and when it was last done", async () => {
    const ada = await newMember();
    const note = await create(ada, `${WATER}\n- [ ] Plain`);
    await check(ada, note.id, 0, WATER);

    const { todos } = await perform(env.DB, ada, { type: "todo.list", noteId: note.id });

    expect(todos.map((t) => [t.words, t.every, t.lastDone, t.due])).toEqual([
      ["Water the plants", "1w", { on: SUNDAY, times: 1 }, "2026-10-17"],
      ["Plain", null, null, null],
    ]);
  });
});

describe("the day a todo is completed on", () => {
  it("is the day the completer says, and without one today in the zone their settings name, or in UTC", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const note = await create(ada, "- [ ] A every:1d-after-done\n- [ ] B every:1d-after-done\n- [ ] C every:1d-after-done");
    const done = async (line: number, on?: string) => perform(env.DB, claude, { type: "todo.set", id: note.id, revision: await revisionOf(note.id), line, text: `- [ ] ${"ABC"[line]} every:1d-after-done`, done: true, on }, NOON);

    expect((await done(0)).filed!.on).toBe("2026-10-11");
    // Noon in UTC is already Monday on Kiritimati, fourteen hours ahead.
    await settings(ada, { "daily.timeZone": "Pacific/Kiritimati" });
    expect((await done(1)).filed!.on).toBe("2026-10-12");
    expect((await done(2, "2026-10-09")).filed!.on).toBe("2026-10-09");
    expect((await read(ada, note.id)).text).toBe("- [ ] A every:1d-after-done due:2026-10-12 done:2026-10-11x1\n- [ ] B every:1d-after-done due:2026-10-13 done:2026-10-12x1\n- [ ] C every:1d-after-done due:2026-10-10 done:2026-10-09x1");
    expect((await dailies(ada)).map((d) => d.day)).toEqual(["2026-10-09", "2026-10-11", "2026-10-12"]);
  });
});

describe("the folder daily notes go in", () => {
  it("is the one the member's settings name, made when it isn't there, and a change of setting leaves daily notes where they are", async () => {
    const ada = await newMember();
    const note = await create(ada, "- [ ] A every:1d");
    await check(ada, note.id, 0, "- [ ] A every:1d");

    await settings(ada, { "daily.folder": "Journal" });
    await check(ada, note.id, 0, `- [ ] A every:1d due:2026-10-12 done:${SUNDAY}x1`, { on: "2026-10-12" });
    await check(ada, note.id, 0, "- [ ] A every:1d due:2026-10-13 done:2026-10-12x2", { on: SUNDAY });

    expect((await dailies(ada)).map((d) => [d.day, d.folder, d.text.split("\n").filter((l) => l.startsWith("- [x]")).length])).toEqual([
      [SUNDAY, "Daily", 2],
      ["2026-10-12", "Journal", 1],
    ]);
  });

  it("is a folder of that name already there, whatever its case, and each member's setting is their own", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const journal = await perform(env.DB, ada, { type: "folder.create", name: "journal" });
    await settings(eve, { "daily.folder": "JOURNAL", "daily.private": false });

    const hers = await perform(env.DB, eve, { type: "daily.open", on: SUNDAY });
    const adas = await perform(env.DB, ada, { type: "daily.open", on: SUNDAY });

    expect([hers.folderId, hers.private]).toEqual([journal.id, false]);
    expect(adas.id).not.toBe(hers.id);
    expect((await dailies(ada)).map((d) => [d.folder, d.private_owner])).toEqual([["Daily", ada.personId]]);
  });

  it("files nothing for a member who can't write in their daily folder, or a guest, who complete the todo all the same", async () => {
    const ada = await newMember();
    const ned = await addMember(ada, "editor", "Ned");
    const nedEmail = (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(ned.personId).first<{ email: string }>())!.email;
    const daily = await perform(env.DB, ada, { type: "folder.create", name: "Daily" });
    await perform(env.DB, ada, { type: "grant.set", folderId: daily.id, email: nedEmail, access: "view" });
    const guestEmail = `${crypto.randomUUID()}@example.com`;
    const guest: Actor = { kind: "member", personId: (await signIn(env.DB, { email: guestEmail, name: "Gus" })).personId, workspaceId: ada.workspaceId };
    const note = await create(ada, "- [ ] A every:1d\n- [ ] B every:1d");
    await perform(env.DB, ada, { type: "grant.set", noteId: note.id, email: guestEmail, access: "edit" });

    const byNed = await check(ned, note.id, 0, "- [ ] A every:1d");
    const byGuest = await check(guest, note.id, 1, "- [ ] B every:1d");

    expect(byNed.filed).toEqual({ on: SUNDAY, dailyNoteId: null, todos: 1 });
    expect(byGuest.filed).toEqual({ on: SUNDAY, dailyNoteId: null, todos: 1 });
    expect(byGuest.text).toBe(`- [ ] A every:1d due:2026-10-12 done:${SUNDAY}x1\n- [ ] B every:1d due:2026-10-12 done:${SUNDAY}x1`);
    expect([...(await dailies(ned)), ...(await dailies(guest))]).toEqual([]);
    expect(await codeOf(perform(env.DB, ned, { type: "daily.open", on: SUNDAY }))).toBe("forbidden");
    expect(await codeOf(perform(env.DB, guest, { type: "daily.open", on: SUNDAY }))).toBe("forbidden");
  });
});

describe("a member's daily note", () => {
  it("is found or made by daily.open: one for a member and a day, headed by the date, however often and at once it is asked for", async () => {
    const ada = await newMember();

    const opened = await Promise.all([1, 2, 3].map(() => perform(env.DB, ada, { type: "daily.open", on: SUNDAY })));
    const tomorrow = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-12" });

    expect(new Set(opened.map((n) => n.id)).size).toBe(1);
    expect(opened.map((n) => [n.title, n.text, n.private])).toEqual(Array(3).fill([SUNDAY, `# ${SUNDAY}\n\n`, true]));
    expect(tomorrow.id).not.toBe(opened[0]!.id);
    expect((await dailies(ada)).map((d) => d.day)).toEqual([SUNDAY, "2026-10-12"]);
  });

  it("is still the member's daily note after they move it or write over its heading", async () => {
    const ada = await newMember();
    const daily = await perform(env.DB, ada, { type: "daily.open", on: SUNDAY });
    const other = await perform(env.DB, ada, { type: "folder.create", name: "Archive" });
    await perform(env.DB, ada, { type: "note.move", id: daily.id, folderId: other.id });
    await perform(env.DB, ada, { type: "note.write", id: daily.id, baseRevision: 1, text: "# A good Sunday\n" });

    expect((await perform(env.DB, ada, { type: "daily.open", on: SUNDAY })).id).toBe(daily.id);
    expect((await perform(env.DB, await agentOf(ada), { type: "daily.open", on: SUNDAY })).id).toBe(daily.id);
  });

  it("is today's, where the member's settings say they are, when no day is given", async () => {
    const ada = await newMember();
    await settings(ada, { "daily.timeZone": "Pacific/Kiritimati" });
    expect((await perform(env.DB, ada, { type: "daily.open" }, NOON)).title).toBe("2026-10-12");
  });

  it("can't be had by a viewer, who can make no note", async () => {
    const ada = await newMember();
    const vera = await addMember(ada, "viewer", "Vera");
    expect(await codeOf(perform(env.DB, vera, { type: "daily.open", on: SUNDAY }))).toBe("forbidden");
  });
});

describe("the history of a recurring todo", () => {
  it("lists each completion with its day and who did it, latest first, and follows the line as it is reworded and moved down", async () => {
    const ada = await newMember("Ada Lovelace");
    const eve = await addMember(ada, "editor", "Eve");
    const claude = await agentOf(eve, "Claude");
    const note = await create(ada, `# Chores\n\n${WATER}\n- [ ] Bins every:2w`);
    await check(ada, note.id, 2, WATER);
    await check(claude, note.id, 2, WATERED, { on: "2026-10-17" });
    await check(eve, note.id, 3, "- [ ] Bins every:2w", { on: "2026-10-17" });
    const now = "- [ ] ! Water the ferns due:2026-10-24 every:1w +Home done:2026-10-17x2";
    await perform(env.DB, ada, { type: "note.write", id: note.id, baseRevision: 4, text: `# Chores\n\nA new line above\n\n${now}\n- [ ] Bins every:2w due:2026-10-31 done:2026-10-17x1` });

    const mine = await history(ada, note.id, 4, now);
    const hers = await history(eve, note.id, 4, now);

    expect(mine.completions.map((c) => [c.on, c.by.kind, c.by.name])).toEqual([
      ["2026-10-17", "agent", "Claude"],
      [SUNDAY, "member", "Ada Lovelace"],
    ]);
    // Each is told of the daily note it was filed on only when they can see it, and a daily note is private.
    expect(mine.completions.map((c) => c.dailyNoteId !== null)).toEqual([false, true]);
    expect(hers.completions.map((c) => c.dailyNoteId !== null)).toEqual([true, false]);
  });

  it("is refused as a conflict for a todo that was changed since it was listed, and is nothing for a todo never checked off", async () => {
    const ada = await newMember();
    const note = await create(ada, WATER);
    expect(await history(ada, note.id, 0, WATER)).toEqual({ completions: [] });
    expect(await codeOf(history(ada, note.id, 0, "- [ ] Something else"))).toBe("conflict");
  });
});

describe("taking a completion back", () => {
  const filedLine = (noteId: string) => `${FILED} [[${noteId}]]`;
  const setUp = async () => {
    const ada = await newMember();
    const note = await create(ada, `# Chores\n\n${WATER}`);
    const done = await check(ada, note.id, 2, WATER);
    const daily = done.filed!.dailyNoteId!;
    const text = async () => (await read(ada, daily)).text;
    return { ada, note, daily, text };
  };

  it("takes its filed line off the daily note with an undo, files it again with a redo, and once however often", async () => {
    const { ada, note, daily, text } = await setUp();

    const undone = await perform(env.DB, ada, { type: "note.undo", id: note.id });
    expect(undone.unfiled).toEqual({ removed: 1, left: 0, dailyNoteIds: [daily] });
    expect(await text()).toBe(`# ${SUNDAY}\n\n`);

    const redone = await perform(env.DB, ada, { type: "note.redo", id: note.id });
    expect(redone.text).toBe(`# Chores\n\n${WATERED}`);
    expect(await text()).toBe(`# ${SUNDAY}\n\n${filedLine(note.id)}\n`);
    expect((await history(ada, note.id, 2, WATERED)).completions).toHaveLength(1);

    await perform(env.DB, ada, { type: "note.undo", id: note.id });
    expect(await text()).toBe(`# ${SUNDAY}\n\n`);
    await check(ada, note.id, 2, WATER);
    expect(await text()).toBe(`# ${SUNDAY}\n\n${filedLine(note.id)}\n`);
    expect((await read(ada, note.id)).text).toBe(`# Chores\n\n${WATERED}`);
  });

  it("does so for a revert to a revision, a revert of chosen changes, and putting them back, as the one who took it back", async () => {
    const { ada, note, daily, text } = await setUp();
    const eve = await addMember(ada, "editor", "Eve");

    await perform(env.DB, eve, { type: "note.revert", id: note.id, revision: 1 });
    expect(await text()).toBe(`# ${SUNDAY}\n\n`);
    expect((await perform(env.DB, ada, { type: "note.history", id: daily })).at(-1)!.author).toMatchObject({ kind: "member", name: "Eve" });

    await perform(env.DB, ada, { type: "note.reapplyChanges", id: note.id, revisions: [2] });
    expect(await text()).toBe(`# ${SUNDAY}\n\n${filedLine(note.id)}\n`);

    const reverted = await perform(env.DB, eve, { type: "note.revertChanges", id: note.id, revisions: [2] });
    expect(await text()).toBe(`# ${SUNDAY}\n\n`);
    // The daily note is Ada's and private: Eve's change took the line off it, and she is told of no note she can't see.
    expect(reverted.unfiled).toEqual({ removed: 1, left: 0, dailyNoteIds: [] });
  });

  it.each(["the todo's note first", "the daily note first"] as const)("takes an agent's completions back out of the daily note when the agent's changes are reverted, %s", async (order) => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const author = { kind: "agent", id: (claude as Extract<Actor, { kind: "agent" }>).agentId } as const;
    const note = await create(ada, `# Chores\n\n${WATER}\n- [ ] Bins every:2w`);
    const done = await check(claude, note.id, 2, WATER);
    const daily = done.filed!.dailyNoteId!;
    await check(ada, note.id, 3, "- [ ] Bins every:2w");
    // Reverting an author goes through notes in the order of their ids, which are random, and a page at a time: each order is asked for here.
    const revert = (id: string) => perform(env.DB, ada, { type: "history.revertAuthor", author, noteIds: [id] });

    const answers = order === "the todo's note first" ? [await revert(note.id), await revert(daily)] : [await revert(daily), await revert(note.id)].reverse();

    expect(answers[0]!.reverted[0]!.note.unfiled).toEqual({ removed: 1, left: 0, dailyNoteIds: [daily] });
    // The agent's completion made the daily note, so its heading was the agent's change too and goes with the rest. What Ada filed stays.
    expect((await read(ada, daily)).text).toBe(`- [x] Bins [[${note.id}]]\n`);
    expect((await read(ada, note.id)).text).toBe(`# Chores\n\n${WATER}\n- [ ] Bins every:2w due:2026-10-25 done:${SUNDAY}x1`);
    expect((await perform(env.DB, ada, { type: "daily.open", on: SUNDAY })).id).toBe(daily);
  });

  it("finds the line where it now is, leaves everything else on the daily note, and leaves a line the member edited or deleted", async () => {
    const { ada, note, daily, text } = await setUp();
    await perform(env.DB, ada, { type: "note.write", id: daily, baseRevision: 1, text: `# A good Sunday\n\nSlept well\n${filedLine(note.id)}\n${filedLine(note.id)}\nAnd then to bed\n` });

    await perform(env.DB, ada, { type: "note.undo", id: note.id });
    // Two lines read the same. The one that was filed goes, and the one the member wrote stays.
    expect(await text()).toBe(`# A good Sunday\n\nSlept well\n${filedLine(note.id)}\nAnd then to bed\n`);

    await perform(env.DB, ada, { type: "note.redo", id: note.id });
    const filedAgain = `# A good Sunday\n\nSlept well\n${filedLine(note.id)}\nAnd then to bed\n${filedLine(note.id)}\n`;
    expect(await text()).toBe(filedAgain);
    await perform(env.DB, ada, { type: "note.write", id: daily, baseRevision: 4, text: filedAgain.replace(/Water the plants(?!.*Water)/s, "Watered everything") });

    const undone = await perform(env.DB, ada, { type: "note.undo", id: note.id });
    expect(undone.unfiled).toEqual({ removed: 0, left: 1, dailyNoteIds: [] });
    expect(await text()).toContain("Watered everything");
  });
});

describe("what is filed, by who can read the daily note", () => {
  const filed = async (of: Actor) => (await dailies(of))[0]!.text.split("\n").filter((line) => line.startsWith("- [x]"));

  it("is the todo's words on a daily note private to its member, and on an open one from a note nothing is shared on", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    await settings(eve, { "daily.private": false });
    const note = await create(ada, `${WATER}\n- [ ] Bins every:2w`);

    await check(ada, note.id, 0, WATER);
    await check(eve, note.id, 1, "- [ ] Bins every:2w");

    expect(await filed(ada)).toEqual([`${FILED} [[${note.id}]]`]);
    expect(await filed(eve)).toEqual([`- [x] Bins [[${note.id}]]`]);
  });

  it("is the link alone on a daily note others can read, from a note that is private or under a grant", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const eveEmail = (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(eve.personId).first<{ email: string }>())!.email;
    await settings(ada, { "daily.private": false });
    const secret = await create(ada, "- [ ] Secret plan every:1d");
    await perform(env.DB, ada, { type: "note.setPrivate", id: secret.id, private: true });
    const team = await perform(env.DB, ada, { type: "folder.create", name: "Team" });
    const inner = await perform(env.DB, ada, { type: "folder.create", name: "Inner", parentId: team.id });
    await perform(env.DB, ada, { type: "grant.set", folderId: team.id, email: eveEmail, access: "view" });
    const narrowed = await create(ada, "- [ ] Narrow plan every:1d", inner.id);

    await check(ada, secret.id, 0, "- [ ] Secret plan every:1d");
    await check(ada, narrowed.id, 0, "- [ ] Narrow plan every:1d");

    expect(await filed(ada)).toEqual([`- [x] [[${secret.id}]]`, `- [x] [[${narrowed.id}]]`]);
    expect((await perform(env.DB, eve, { type: "todo.list", includeCompleted: true })).todos.map((t) => t.text).join("\n")).not.toMatch(/Secret plan/);
  });

  it("is the link alone on a private daily note its member has shared", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const eveEmail = (await env.DB.prepare("SELECT email FROM people WHERE id = ?").bind(eve.personId).first<{ email: string }>())!.email;
    const daily = await perform(env.DB, ada, { type: "daily.open", on: SUNDAY });
    await perform(env.DB, ada, { type: "grant.set", noteId: daily.id, email: eveEmail, access: "view" });
    const note = await create(ada, WATER);

    await check(ada, note.id, 0, WATER);

    expect(await filed(ada)).toEqual([`- [x] [[${note.id}]]`]);
  });
});

describe("leaving a workspace with daily notes", () => {
  it("is not held up by them: they stop being private, as a removed member's private notes do, and keep whose they were", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    const note = await create(ada, WATER);
    const done = await check(eve, note.id, 0, WATER);

    expect(await perform(env.DB, eve, { type: "member.leave" })).toEqual({ memberId: eve.personId });

    const daily = await read(ada, done.filed!.dailyNoteId!);
    expect([daily.private, daily.text]).toEqual([false, `# ${SUNDAY}\n\n${FILED} [[${note.id}]]\n`]);
    expect((await perform(env.DB, ada, { type: "grant.list", noteId: daily.id })).note?.released).toMatchObject({ from: "Eve", by: "Eve" });
  });

  it("is still refused for another private note, which the refusal counts apart from the daily notes", async () => {
    const ada = await newMember();
    const eve = await addMember(ada, "editor", "Eve");
    await perform(env.DB, eve, { type: "daily.open", on: SUNDAY });
    const own = await create(eve, "# Mine");
    await perform(env.DB, eve, { type: "note.setPrivate", id: own.id, private: true });

    await expect(perform(env.DB, eve, { type: "member.leave" })).rejects.toThrow("You have a private note here besides your daily notes");
    expect((await dailies(eve))[0]!.private_owner).toBe(eve.personId);
  });
});
