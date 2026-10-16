import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TRASH_MS } from "../../src/core/lifecycle.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import { KEPT, REMOVALS, purgeTrash, removing } from "../../src/core/purge.ts";
import worker from "../../src/worker/index.ts";
import { newMember } from "./members.ts";

const T0 = Date.UTC(2026, 9, 11);

/**
 * A note with something in every table that keeps anything by a note's id: changes, a label, links
 * out and in, todos, a tag, a mention, search text, a grant and a link, a completion, and a daily
 * note that a completion elsewhere was filed on. `word` is in its text and nowhere else.
 */
async function doomed(ada: Actor, word: string) {
  const other = await perform(env.DB, ada, { type: "note.create", text: "# Other\n\n- [ ] elsewhere every:1d" });
  const daily = await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" });
  await perform(env.DB, ada, { type: "note.write", id: daily.id, baseRevision: daily.revision, text: `${daily.text}\n${word} [[${other.id}]]\n- [ ] ${word}-todo every:1d #${word}tag @[[${word} Person]]\n` });
  await perform(env.DB, ada, { type: "note.label", id: daily.id, revision: 1, name: `${word}-label` });
  await perform(env.DB, ada, { type: "todo.set", id: other.id, revision: 1, line: 2, text: "- [ ] elsewhere every:1d", done: true, on: "2026-10-11" });
  const now = await perform(env.DB, ada, { type: "note.read", id: daily.id });
  const todo = (await perform(env.DB, ada, { type: "todo.list", noteId: daily.id })).todos.find((t) => t.text.includes(word))!;
  await perform(env.DB, ada, { type: "todo.set", id: daily.id, revision: now.revision, line: todo.line, text: todo.text, done: true, on: "2026-10-11" });
  await perform(env.DB, ada, { type: "grant.set", noteId: daily.id, email: `${word}@example.com`, access: "view" });
  await perform(env.DB, ada, { type: "grant.link", noteId: daily.id, link: "public" });
  const linker = await perform(env.DB, ada, { type: "note.create", text: `# Linker\n\n[[${daily.id}]]` });
  return { id: daily.id, other: other.id, linker: linker.id };
}

/** Every table and its columns, the full-text index's own tables among them, since they hold the text. */
async function tables(): Promise<{ table: string; columns: string[] }[]> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name NOT IN ('note_search', 'note_search_data', 'note_search_idx', 'note_search_docsize', 'note_search_config')").all<{ name: string }>();
  const found = [];
  for (const { name } of results) found.push({ table: name, columns: (await env.DB.prepare(`SELECT name FROM pragma_table_info('${name}')`).all<{ name: string }>()).results.map((c) => c.name) });
  return found;
}

/** Where anything is still kept of a note: a row with the note's id in a column that holds a note's id, or `word` anywhere. */
async function remains(noteId: string, word: string): Promise<string[]> {
  const left: string[] = [];
  for (const { table, columns } of await tables()) {
    for (const column of columns) {
      // Another note's text may still say it links to the note. That is the other note's, and so is the row of `links` that records it.
      const byId = /(^|_)id$/.test(column) && !(table === "links" && column === "target_id");
      const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${byId ? `"${column}" = ?1 OR ` : ""}instr(CAST("${column}" AS TEXT), ?2) > 0`).bind(noteId, word).first<{ n: number }>())!;
      if (n) left.push(`${table}.${column}`);
    }
  }
  return left;
}

describe("removing notes from Trash", () => {
  it("keeps a trashed note until its 30 days are up, then removes it and everything kept by its id", async () => {
    const ada = await newMember();
    const note = await doomed(ada, "xyzzyplugh");
    const before = await remains(note.id, "xyzzyplugh");
    // The check below means something only if the note was in every one of these to begin with.
    expect(before).toEqual(expect.arrayContaining(["notes.id", "notes.text", "changes.note_id", "changes.diff", "labels.note_id", "links.source_id", "todos.note_id", "note_tags.note_id", "mentions.note_id", "note_search_rows.note_id", "note_search_content.c2", "grants.note_id", "completions.note_id", "completions.daily_note_id", "daily_notes.note_id"]));
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0);

    expect(await purgeTrash(env.DB, T0 + TRASH_MS - 1)).toEqual({ removed: 0, failed: [], more: false });
    expect((await perform(env.DB, ada, { type: "note.read", id: note.id })).state).toBe("trashed");

    expect(await purgeTrash(env.DB, T0 + TRASH_MS)).toEqual({ removed: 1, failed: [], more: false });
    expect(await remains(note.id, "xyzzyplugh")).toEqual([]);
    expect(await purgeTrash(env.DB, T0 + TRASH_MS)).toEqual({ removed: 0, failed: [], more: false });

    // Everything else is as it was: the other notes, their history, and the todo completed elsewhere, now filed nowhere.
    expect((await perform(env.DB, ada, { type: "note.read", id: note.linker })).links).toEqual([{ id: note.id, title: null, state: null }]);
    expect((await perform(env.DB, ada, { type: "note.history", id: note.other })).length).toBe(2);
    const [todo] = (await perform(env.DB, ada, { type: "todo.list", noteId: note.other })).todos;
    expect((await perform(env.DB, ada, { type: "todo.history", id: note.other, revision: todo!.revision, line: todo!.line, text: todo!.text })).completions).toMatchObject([{ on: "2026-10-11", dailyNoteId: null }]);
    expect((await perform(env.DB, ada, { type: "search", query: "xyzzyplugh" })).results).toEqual([]);
    expect((await perform(env.DB, ada, { type: "daily.open", on: "2026-10-11" })).id).not.toBe(note.id);
  });

  it("shows a link to a removed note exactly as a link to a note that never was, to someone who could see it and to someone who couldn't", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Was here" });
    const linker = await perform(env.DB, ada, { type: "note.create", text: `[[${note.id}]] [[zzzzzzzzzzzz]]`, linkTitles: "keep" });
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0);
    await purgeTrash(env.DB, T0 + TRASH_MS);

    const [removed, never] = (await perform(env.DB, ada, { type: "note.read", id: linker.id })).links;
    expect({ ...removed, id: "" }).toEqual({ ...never, id: "" });
    const read = (id: string) => perform(env.DB, ada, { type: "note.read", id }).catch((err: Error) => `${(err as { code?: string }).code}: ${err.message}`);
    expect(await read(note.id)).toBe(await read("zzzzzzzzzzzz"));
  });

  it("never removes a note that was restored a moment before, though it was named to be removed", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Saved\n\n- [ ] kept #tag" });
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0);
    const statements = removing(env.DB, note.id, T0);
    await perform(env.DB, ada, { type: "note.restore", id: note.id });

    await env.DB.batch(statements);

    expect(await perform(env.DB, ada, { type: "note.read", id: note.id })).toMatchObject({ text: "# Saved\n\n- [ ] kept #tag", state: "live" });
    expect((await perform(env.DB, ada, { type: "note.history", id: note.id })).length).toBe(1);
    expect((await perform(env.DB, ada, { type: "search", query: "kept #tag" })).results.map((r) => r.note.id)).toEqual([note.id]);
    expect((await perform(env.DB, ada, { type: "todo.list" })).todos.map((t) => t.text)).toEqual(["- [ ] kept #tag"]);
  });

  it("leaves a note trashed again after being restored its full 30 days from the second time", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Twice" });
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0);
    await perform(env.DB, ada, { type: "note.restore", id: note.id }, T0 + 1000);
    await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0 + TRASH_MS - 1000);

    expect((await purgeTrash(env.DB, T0 + TRASH_MS)).removed).toBe(0);
    expect((await purgeTrash(env.DB, T0 + 2 * TRASH_MS - 1000)).removed).toBe(1);
  });

  it("removes more notes than one batch holds, across workspaces, and carries on where a run that stopped left off", async () => {
    const ada = await newMember();
    const bob = await newMember("Bob");
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const by = i % 2 ? ada : bob;
      const note = await perform(env.DB, by, { type: "note.create", text: `# Note ${i}\n\n- [ ] todo #tag` });
      await perform(env.DB, by, { type: "note.trash", id: note.id }, T0 + i);
      ids.push(note.id);
    }
    const kept = await perform(env.DB, ada, { type: "note.create", text: "# Kept" });
    const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).first<{ n: number }>())!.n;

    // A run that stopped after the notes whose time was up by then.
    expect(await purgeTrash(env.DB, T0 + TRASH_MS + 9)).toEqual({ removed: 10, failed: [], more: false });
    expect(await count()).toBe(35);
    expect(await purgeTrash(env.DB, T0 + TRASH_MS + 1000)).toEqual({ removed: 35, failed: [], more: false });
    expect(await count()).toBe(0);
    expect((await perform(env.DB, ada, { type: "note.read", id: kept.id })).title).toBe("Kept");
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM changes WHERE note_id IN (SELECT value FROM json_each(?1))) + (SELECT COUNT(*) FROM note_tags WHERE note_id IN (SELECT value FROM json_each(?1))) AS n").bind(JSON.stringify(ids)).first()).toEqual({ n: 0 });
  });

  it("names every column of the schema that can hold a note's id, as removed or as kept with a reason", async () => {
    // A column can hold a note's id when it refers to `notes`, or its name says so. `notes.id` is the note itself.
    const holds: string[] = [];
    for (const { table, columns } of await tables()) {
      const refers = (await env.DB.prepare(`SELECT "from" AS col FROM pragma_foreign_key_list('${table}') WHERE "table" = 'notes'`).all<{ col: string }>()).results.map((r) => r.col);
      for (const column of columns) if (refers.includes(column) || /note|^(source|target)_id$/.test(column)) holds.push(`${table}.${column}`);
    }
    expect(holds).toEqual(expect.arrayContaining(["changes.note_id", "completions.daily_note_id", "links.source_id", "links.target_id", "grants.note_id", "note_search_rows.note_id"]));

    const removed = (at: string) => {
      const [table, column] = at.split(".") as [string, string];
      return REMOVALS.some((sql) => new RegExp(`^(DELETE FROM|UPDATE) ${table} .*\\b${column} = (\\?1|NULL)`).test(sql));
    };
    expect(holds.filter((at) => !removed(at) && !(at in KEPT))).toEqual([]);
    expect(Object.keys(KEPT).filter((at) => !holds.includes(at) || removed(at))).toEqual([]);
  });

  it("leaves a note it can't remove whole, says which, and removes every other note that is due", async () => {
    const ada = await newMember();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const note = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
      await perform(env.DB, ada, { type: "note.trash", id: note.id }, T0 + i);
      ids.push(note.id);
    }
    // Something `REMOVALS` doesn't know of refers to the oldest note, so removing that note fails, and the batch it is in with it.
    const stuck = ids[0]!;
    await env.DB.batch([env.DB.prepare("CREATE TABLE unknown_to_purge (holds TEXT REFERENCES notes (id))"), env.DB.prepare("INSERT INTO unknown_to_purge (holds) VALUES (?)").bind(stuck)]);
    const said: string[] = [];
    try {
      expect(await purgeTrash(env.DB, T0 + TRASH_MS + 1000, (message) => said.push(message))).toEqual({ removed: 24, failed: [stuck], more: false });
      expect(said).toEqual([expect.stringContaining(`Couldn't remove note ${stuck} from Trash`)]);
      expect(await perform(env.DB, ada, { type: "note.read", id: stuck })).toMatchObject({ title: "Note 0", state: "trashed", revision: 1 });
      expect((await perform(env.DB, ada, { type: "note.history", id: stuck })).length).toBe(1);
      expect((await perform(env.DB, ada, { type: "trash.list" })).map((n) => n.id)).toEqual([stuck]);
    } finally {
      await env.DB.prepare("DROP TABLE unknown_to_purge").run();
    }
    expect(await purgeTrash(env.DB, T0 + TRASH_MS + 1000)).toEqual({ removed: 1, failed: [], more: false });
  });

  it("runs on the Worker's timer, at the time the timer says", async () => {
    const ada = await newMember();
    const due = await perform(env.DB, ada, { type: "note.create", text: "# Due" });
    const waiting = await perform(env.DB, ada, { type: "note.create", text: "# Waiting" });
    await perform(env.DB, ada, { type: "note.trash", id: due.id }, T0);
    await perform(env.DB, ada, { type: "note.trash", id: waiting.id }, T0 + 5000);

    await worker.scheduled!({ scheduledTime: T0 + TRASH_MS, cron: "17 * * * *", noRetry() {} } as ScheduledController, env as unknown as Env);

    expect((await perform(env.DB, ada, { type: "trash.list" })).map((n) => n.title)).toEqual(["Waiting"]);
    await expect(perform(env.DB, ada, { type: "note.read", id: due.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("leaves no word of a removed note in the search index's own pages, removed by the clock or by a member", async () => {
    const ada = await newMember();
    const held = async (word: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM note_search_data WHERE instr(block, CAST(?1 AS BLOB)) > 0").bind(word).first<{ n: number }>())!.n;
    const doomed = await perform(env.DB, ada, { type: "note.create", text: "# Doomed\n\nxyzzyplughword" }, 1000);
    const shredded = await perform(env.DB, ada, { type: "note.create", text: "# Shredded\n\nqwertyfrobword" }, 1000);
    await perform(env.DB, ada, { type: "note.create", text: "# Kept\n\nstayingword" }, 1000);
    await perform(env.DB, ada, { type: "note.trash", id: doomed.id }, 2000);
    await perform(env.DB, ada, { type: "note.trash", id: shredded.id }, 2000);
    expect(await held("xyzzyplughword")).toBeGreaterThan(0);

    await perform(env.DB, ada, { type: "note.purge", id: shredded.id }, 3000);
    expect(await held("qwertyfrobword")).toBe(0);
    expect((await purgeTrash(env.DB, 2000 + TRASH_MS)).removed).toBe(1);
    expect(await held("xyzzyplughword")).toBe(0);
    expect((await perform(env.DB, ada, { type: "search", query: "stayingword" })).results.map((r) => r.note.title)).toEqual(["Kept"]);
  });

});
