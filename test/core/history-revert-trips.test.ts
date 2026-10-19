import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { perform } from "../../src/core/operations.ts";
import { MAX_NOTES_AT_ONCE } from "../../src/core/protocol.ts";
import { newMember } from "./members.ts";

/**
 * The database as a deployed Worker reaches it: each call waits on the network. Counts how many calls
 * were made one after another, so a revert that waits on each note in turn shows as many waits.
 */
function distant(db: D1Database) {
  let inFlight = 0;
  let waits = 0;
  const raw = new WeakMap<object, D1PreparedStatement>();
  const trip = async <T>(call: () => Promise<T>) => {
    if (inFlight++ === 0) waits++;
    try {
      await new Promise((resume) => setTimeout(resume, 5));
      return await call();
    } finally {
      inFlight--;
    }
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: (column?: string) => trip(() => (column === undefined ? statement.first() : statement.first(column))),
      all: () => trip(() => statement.all()),
      run: () => trip(() => statement.run()),
      raw: () => trip(() => statement.raw()),
    } as unknown as D1PreparedStatement;
    raw.set(wrapped, statement);
    return wrapped;
  };
  const far = {
    prepare: (query: string) => wrap(db.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => trip(() => db.batch(statements.map((s) => raw.get(s) ?? s))),
    exec: (query: string) => trip(() => db.exec(query)),
  } as unknown as D1Database;
  return { far, waits: () => waits };
}

it("reverts a part's notes waiting on the database a few times, not once or twice for each note", async () => {
  const ada = await newMember();
  const ids: string[] = [];
  for (let i = 0; i < MAX_NOTES_AT_ONCE; i++) {
    const { id } = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
    ids.push(id);
  }
  const { far, waits } = distant(env.DB);
  const done = await perform(far, ada, { type: "history.revert", changes: ids.map((noteId) => ({ noteId, revisions: [1], at: 1 })) });
  expect(done.reverted.map((r) => r.noteId)).toEqual(ids);
  expect(done.skipped).toEqual([]);
  expect(waits()).toBe(3);
  for (const id of ids) expect((await perform(env.DB, ada, { type: "note.read", id })).text).toBe("");
});
