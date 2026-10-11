import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { HistoryEntry, OpInput } from "../../src/core/protocol.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 2, 1, 12);

const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await worker.fetch(
    new Request("https://ink.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }) as never,
    env,
  );
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: result.content[0]!.text, isError: !!result.isError, json: () => JSON.parse(result.content[0]!.text) };
};

/** The agent `member` connected, as an actor and with its token for /mcp. */
async function agentOf(member: Actor, name = "Claude", options: { readOnly?: boolean } = {}) {
  const { agent, token } = await connectAgent(env.DB, member.personId, name, options);
  const actor: Actor = { kind: "agent", agentId: agent.id, personId: member.personId, workspaceId: member.workspaceId, scope: { readOnly: options.readOnly } };
  return { actor, token, ref: { kind: "agent" as const, id: agent.id } };
}

const memberRef = (actor: Actor) => ({ kind: "member" as const, id: actor.personId });
const read = async (actor: Actor, id: string) => (await perform(env.DB, actor, { type: "note.read", id })).text;
const write = async (actor: Actor, id: string, text: string, now?: number) => {
  const { revision } = await perform(env.DB, actor, { type: "note.read", id });
  return perform(env.DB, actor, { type: "note.write", id, baseRevision: revision, text }, now);
};
const history = (actor: Actor, id: string) => perform(env.DB, actor, { type: "note.history", id });
const lines = (entry: HistoryEntry) => entry.diff!.hunks.flatMap((h) => h.lines.map((l) => `${{ same: " ", add: "+", del: "-" }[l.kind]}${l.text}`));

/** A note Ada made and edited, which her agent then edited, which she edited again. */
async function sharedNote() {
  const ada = await newMember("Ada Lovelace");
  const claude = await agentOf(ada);
  const note = await perform(env.DB, ada, { type: "note.create", text: "# Plan" }, T0);
  await write(ada, note.id, "# Plan\n\nAda's step", T0 + HOUR);
  expect(await tool(claude.token, "write_note", { id: note.id, baseRevision: 2, text: "# Plan\n\nAda's step\n\nClaude's step" })).toMatchObject({ isError: false });
  await write(ada, note.id, "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");
  return { ada, claude, id: note.id };
}

describe("workspace history", () => {
  it("lists every change newest first with its note, its author, and what it changed", async () => {
    const ada = await newMember("Ada Lovelace");
    const plan = await perform(env.DB, ada, { type: "note.create", text: "# Plan" }, T0);
    const trip = await perform(env.DB, ada, { type: "note.create", text: "# Trip" }, T0 + HOUR);
    await write(ada, plan.id, "# Plan\n\nStep one", T0 + 2 * HOUR);

    const { changes, next } = await perform(env.DB, ada, { type: "history.list" });

    expect(next).toBeNull();
    expect(changes.map((c) => [c.noteTitle, c.noteId, c.revision, c.author.name, c.createdAt])).toEqual([
      ["Plan", plan.id, 2, "Ada Lovelace", T0 + 2 * HOUR],
      ["Trip", trip.id, 1, "Ada Lovelace", T0 + HOUR],
      ["Plan", plan.id, 1, "Ada Lovelace", T0],
    ]);
    expect(lines(changes[0]!)).toEqual([" # Plan", "+", "+Step one"]);
    expect([changes[0]!.diff!.added, changes[0]!.diff!.removed]).toEqual([2, 0]);
  });

  it("filters by author, and an agent's changes are the agent's, not its member's", async () => {
    const { ada, claude, id } = await sharedNote();

    const byClaude = await perform(env.DB, ada, { type: "history.list", authors: [claude.ref] });
    const byAda = await perform(env.DB, ada, { type: "history.list", authors: [memberRef(ada)] });
    const byBoth = await perform(env.DB, ada, { type: "history.list", authors: [memberRef(ada), claude.ref] });

    expect(byClaude.changes.map((c) => [c.noteId, c.revision, c.author])).toEqual([[id, 3, { kind: "agent", agentId: claude.ref.id, name: "Claude", onBehalfOf: ada.personId }]]);
    expect(lines(byClaude.changes[0]!)).toEqual([" ", " Ada's step", "+", "+Claude's step"]);
    expect(byAda.changes.map((c) => c.revision)).toEqual([4, 2, 1]);
    expect(byBoth.changes.map((c) => c.revision)).toEqual([4, 3, 2, 1]);
    expect((await perform(env.DB, ada, { type: "history.list", authors: [{ kind: "member", id: claude.ref.id }] })).changes).toEqual([]);
  });

  it("names everyone who has changed a note, members and agents apart", async () => {
    const { ada, claude } = await sharedNote();
    await perform(env.DB, await addMember(ada, "editor", "Grace Hopper"), { type: "note.create", text: "# Grace's" });

    const authors = await perform(env.DB, ada, { type: "history.authors" });

    expect(authors.map((a) => [a.kind, a.name, a.kind === "agent" ? a.agentId : a.personId])).toEqual([
      ["member", "Ada Lovelace", ada.personId],
      ["agent", "Claude", claude.ref.id],
      ["member", "Grace Hopper", expect.any(String)],
    ]);
  });

  it("filters by when a change was made: from a time, and before another", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" }, T0);
    await write(ada, note.id, "one two", T0 + HOUR);
    await write(ada, note.id, "one two three", T0 + 2 * HOUR);
    const revisions = async (range: { from?: number; to?: number }) => (await perform(env.DB, ada, { type: "history.list", ...range })).changes.map((c) => c.revision);

    expect(await revisions({ from: T0 + HOUR })).toEqual([3, 2]);
    expect(await revisions({ to: T0 + HOUR })).toEqual([1]);
    expect(await revisions({ from: T0 + HOUR, to: T0 + 2 * HOUR })).toEqual([2]);
    expect(await revisions({ from: T0 + 3 * HOUR })).toEqual([]);
  });

  it("is scoped to one note, to several, or to all of them", async () => {
    const ada = await newMember();
    const [a, b, c] = await Promise.all(["# A", "# B", "# C"].map((text, i) => perform(env.DB, ada, { type: "note.create", text }, T0 + i)));
    const titles = async (noteIds?: string[]) => (await perform(env.DB, ada, { type: "history.list", noteIds })).changes.map((change) => change.noteTitle);

    expect(await titles([b!.id])).toEqual(["B"]);
    expect(await titles([a!.id, c!.id])).toEqual(["C", "A"]);
    expect(await titles()).toEqual(["C", "B", "A"]);
  });

  it("comes a page at a time, each page starting where the last one stopped", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "0" }, T0);
    for (let i = 1; i <= 4; i++) await write(ada, note.id, `${i}`, T0);

    const first = await perform(env.DB, ada, { type: "history.list", limit: 2 });
    const second = await perform(env.DB, ada, { type: "history.list", limit: 2, before: first.next! });
    const third = await perform(env.DB, ada, { type: "history.list", limit: 2, before: second.next! });

    expect([first, second, third].map((page) => page.changes.map((c) => c.revision))).toEqual([[5, 4], [3, 2], [1]]);
    expect(third.next).toBeNull();
  });

  it("leaves the diffs out when asked to", async () => {
    const { ada } = await sharedNote();
    const { changes } = await perform(env.DB, ada, { type: "history.list", diffs: false });
    expect(changes.map((c) => [c.revision, c.diff])).toEqual([4, 3, 2, 1].map((revision) => [revision, null]));
  });

  it("shows nothing of another workspace, even when its note is asked for by id", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const hers = await perform(env.DB, grace, { type: "note.create", text: "# Grace's" });
    await perform(env.DB, ada, { type: "note.create", text: "# Ada's" });

    expect((await perform(env.DB, ada, { type: "history.list" })).changes.map((c) => c.noteTitle)).toEqual(["Ada's"]);
    expect((await perform(env.DB, ada, { type: "history.list", noteIds: [hers.id] })).changes).toEqual([]);
    expect((await perform(env.DB, ada, { type: "history.authors" })).map((a) => a.name)).toEqual(["Ada Lovelace"]);
  });
});

describe("a label", () => {
  it("names one revision, shows in history, and can be renamed and taken away", async () => {
    const { ada, id } = await sharedNote();
    const labels = async () => (await history(ada, id)).map((c) => c.label);

    expect(await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: "  Before Claude " })).toEqual({ id, revision: 2, label: "Before Claude" });
    expect(await labels()).toEqual([null, "Before Claude", null, null]);
    expect((await perform(env.DB, ada, { type: "history.list", noteIds: [id] })).changes.map((c) => c.label)).toEqual([null, null, "Before Claude", null]);

    await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: "Draft" });
    expect(await labels()).toEqual([null, "Draft", null, null]);
    await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: null });
    expect(await labels()).toEqual([null, null, null, null]);
  });

  it("is used once in a note, whatever its case, and only on a revision the note has", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: "Draft" });

    await expect(perform(env.DB, ada, { type: "note.label", id, revision: 3, name: "draft" })).rejects.toMatchObject({ code: "invalid", message: 'Another revision of this note is already labeled "draft"' });
    await expect(perform(env.DB, ada, { type: "note.label", id, revision: 9, name: "Later" })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, ada, { type: "note.label", id, revision: 1, name: " " })).rejects.toMatchObject({ code: "invalid" });
    expect((await history(ada, id)).map((c) => c.label)).toEqual([null, "Draft", null, null]);
  });
});

describe("reverting a note to a revision", () => {
  it("puts its text back as a new change, and keeps every change before it on the record", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: "Before Claude" });

    const reverted = await perform(env.DB, ada, { type: "note.revert", id, revision: 2 }, T0 + 9 * HOUR);

    expect(reverted).toMatchObject({ revision: 5, text: "# Plan\n\nAda's step", updatedAt: T0 + 9 * HOUR });
    expect(await read(ada, id)).toBe("# Plan\n\nAda's step");
    const entries = await history(ada, id);
    expect(entries.map((c) => [c.revision, c.revertedBy])).toEqual([
      [1, null],
      [2, null],
      [3, 5],
      [4, 5],
      [5, null],
    ]);
    expect(entries[4]).toMatchObject({ baseRevision: 4, reverts: { how: "revert", revisions: [3, 4], to: 2 }, author: { name: "Ada Lovelace" } });
    expect((await perform(env.DB, ada, { type: "note.read", id, revision: 4 })).text).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");
  });

  it("changes nothing when the note is already at that revision, and refuses one it doesn't have", async () => {
    const { ada, id } = await sharedNote();

    expect((await perform(env.DB, ada, { type: "note.revert", id, revision: 4 })).revision).toBe(4);
    await expect(perform(env.DB, ada, { type: "note.revert", id, revision: 5 })).rejects.toMatchObject({ code: "not_found" });
    expect(await history(ada, id)).toHaveLength(4);
  });

  it("can go all the way back to the empty note", async () => {
    const { ada, id } = await sharedNote();
    expect(await perform(env.DB, ada, { type: "note.revert", id, revision: 0 })).toMatchObject({ revision: 5, text: "", title: "" });
  });
});

describe("applying a selection of changes", () => {
  it("takes an agent's change back out and keeps the changes made after it", async () => {
    const { ada, claude, id } = await sharedNote();
    const theirs = (await perform(env.DB, ada, { type: "history.list", authors: [claude.ref] })).changes.map((c) => c.revision);

    const without = await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: theirs });

    expect(without).toMatchObject({ revision: 5, text: "# Plan\n\nAda's step\n\nAda's last word" });
    const entries = await history(ada, id);
    expect(entries.map((c) => c.revertedBy)).toEqual([null, null, 5, null, null]);
    expect(entries[4]!.reverts).toEqual({ how: "revert", revisions: [3] });
  });

  it("takes several out as one change", async () => {
    const { ada, id } = await sharedNote();

    const without = await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [4, 2, 4] });

    expect(without).toMatchObject({ revision: 5, text: "# Plan\n\nClaude's step" });
    expect((await history(ada, id)).at(-1)!.reverts).toEqual({ how: "revert", revisions: [2, 4] });
  });

  it("refuses a change the note doesn't have, and one that was already taken out", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] });

    await expect(perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] })).rejects.toMatchObject({ code: "invalid", message: "Change 3 was already taken back out, by change 5" });
    await expect(perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [9] })).rejects.toMatchObject({ code: "not_found" });
    await expect(perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [] })).rejects.toMatchObject({ code: "invalid" });
    expect(await history(ada, id)).toHaveLength(5);
  });

  it("puts a taken-out change back, as another new change", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] });

    const back = await perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3] });

    expect(back).toMatchObject({ revision: 6, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word" });
    expect((await history(ada, id)).map((c) => c.revertedBy)).toEqual([null, null, null, null, 6, null]);
  });

  it("takes a change out again after it was taken out and put back, and puts it back again", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] });
    await perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3] });

    expect(await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] })).toMatchObject({ revision: 7, text: "# Plan\n\nAda's step\n\nAda's last word" });
    expect((await history(ada, id)).map((c) => c.revertedBy)).toEqual([null, null, 7, null, 6, null, null]);
    expect(await perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3] })).toMatchObject({ revision: 8, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word" });
  });

  it("takes out a change its author undid and redid", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" });
    await write(ada, note.id, "one two");
    await perform(env.DB, ada, { type: "note.undo", id: note.id });
    await perform(env.DB, ada, { type: "note.redo", id: note.id });

    expect(await perform(env.DB, grace, { type: "note.revertChanges", id: note.id, revisions: [2] })).toMatchObject({ revision: 5, text: "one" });
  });

  it("puts back together what one change took out together, and nothing that still stands", async () => {
    const { ada, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.revert", id, revision: 2 });

    await expect(perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3] })).rejects.toMatchObject({ code: "invalid", message: "Change 5 took changes 3 and 4 out together, so put them back together" });
    await expect(perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [2] })).rejects.toMatchObject({ code: "invalid" });
    expect(await perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3, 4] })).toMatchObject({ revision: 6, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word" });
  });
});

describe("undo and redo", () => {
  it("take back the author's own latest change and put it back, each as a new change", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" });
    await write(ada, note.id, "one two");
    await write(ada, note.id, "one two three");
    const step = async (type: "note.undo" | "note.redo") => (await perform(env.DB, ada, { type, id: note.id })).text;

    expect(await step("note.undo")).toBe("one two");
    expect(await step("note.undo")).toBe("one");
    expect(await step("note.redo")).toBe("one two");
    expect(await step("note.redo")).toBe("one two three");
    await expect(step("note.redo")).rejects.toMatchObject({ code: "invalid", message: "There's nothing of yours to redo in this note" });
    expect(await step("note.undo")).toBe("one two");

    expect((await history(ada, note.id)).map((c) => c.reverts?.how ?? "edit")).toEqual(["edit", "edit", "edit", "undo", "undo", "redo", "redo", "undo"]);
  });

  it("leave another author's later change in place", async () => {
    const { ada, claude, id } = await sharedNote();
    await perform(env.DB, claude.actor, { type: "note.write", id, baseRevision: 4, text: "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word\n\nClaude again" });

    expect((await perform(env.DB, ada, { type: "note.undo", id })).text).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nClaude again");
    expect((await perform(env.DB, claude.actor, { type: "note.undo", id })).text).toBe("# Plan\n\nAda's step\n\nClaude's step");
    expect((await history(ada, id)).slice(-2).map((c) => [c.author.name, c.reverts])).toEqual([
      ["Ada Lovelace", { how: "undo", revisions: [4] }],
      ["Claude", { how: "undo", revisions: [5] }],
    ]);
  });

  it("have nothing to redo once the author edits after an undo, and nothing to undo in a note they never changed", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" });
    await perform(env.DB, ada, { type: "note.undo", id: note.id });
    await write(ada, note.id, "two");

    await expect(perform(env.DB, ada, { type: "note.redo", id: note.id })).rejects.toMatchObject({ code: "invalid" });
    await expect(perform(env.DB, grace, { type: "note.undo", id: note.id })).rejects.toMatchObject({ code: "invalid", message: "There's nothing of yours to undo in this note" });
    expect(await read(ada, note.id)).toBe("two");
  });

  it("skip a change someone else already took out", async () => {
    const ada = await newMember();
    const grace = await addMember(ada, "editor");
    const note = await perform(env.DB, ada, { type: "note.create", text: "one" });
    await write(ada, note.id, "one two");
    await perform(env.DB, grace, { type: "note.revertChanges", id: note.id, revisions: [2] });

    expect(await perform(env.DB, ada, { type: "note.undo", id: note.id })).toMatchObject({ revision: 4, text: "" });
  });
});

describe("activity", () => {
  it("counts the changes an author made on each day in the zone asked for", async () => {
    const ada = await newMember();
    const note = await perform(env.DB, ada, { type: "note.create", text: "0" }, Date.UTC(2026, 2, 1, 3));
    await write(ada, note.id, "1", Date.UTC(2026, 2, 1, 7));
    await write(ada, note.id, "2", Date.UTC(2026, 2, 1, 23));
    await write(ada, note.id, "3", Date.UTC(2026, 2, 3, 12));
    const days = async (timeZone: string) => (await perform(env.DB, ada, { type: "history.activity", timeZone })).days;

    expect(await days("UTC")).toEqual([
      { date: "2026-03-01", count: 3 },
      { date: "2026-03-03", count: 1 },
    ]);
    expect(await days("America/Los_Angeles")).toEqual([
      { date: "2026-02-28", count: 2 },
      { date: "2026-03-01", count: 1 },
      { date: "2026-03-03", count: 1 },
    ]);
    expect(await days("Pacific/Auckland")).toEqual([
      { date: "2026-03-01", count: 2 },
      { date: "2026-03-02", count: 1 },
      { date: "2026-03-04", count: 1 },
    ]);
  });

  it("counts an agent's changes for the agent, not for its member, and another author's when asked", async () => {
    const { ada, claude } = await sharedNote();
    const total = async (actor: Actor, author?: { kind: "agent"; id: string }) =>
      (await perform(env.DB, actor, { type: "history.activity", timeZone: "UTC", author })).days.reduce((sum, day) => sum + day.count, 0);

    expect(await total(ada)).toBe(3);
    expect(await total(claude.actor)).toBe(1);
    expect(await total(ada, claude.ref)).toBe(1);
  });

  it("is bounded by a time range, and refuses a zone that doesn't exist", async () => {
    const ada = await newMember();
    await perform(env.DB, ada, { type: "note.create", text: "0" }, T0);
    await perform(env.DB, ada, { type: "note.create", text: "1" }, T0 + 48 * HOUR);

    expect((await perform(env.DB, ada, { type: "history.activity", timeZone: "UTC", from: T0 + HOUR })).days).toEqual([{ date: "2026-03-03", count: 1 }]);
    expect((await perform(env.DB, ada, { type: "history.activity", timeZone: "UTC", to: T0 + HOUR })).days).toEqual([{ date: "2026-03-01", count: 1 }]);
    await expect(perform(env.DB, ada, { type: "history.activity", timeZone: "Mars/Olympus" })).rejects.toMatchObject({ code: "invalid", message: "There's no time zone named Mars/Olympus" });
  });
});

/** The database, counting the rows each read returns, and failing any statement `breaks` picks out. */
function watched(breaks: (sql: string, args: unknown[]) => boolean = () => false) {
  const seen = { rows: 0 };
  const real = new Map<object, { statement: D1PreparedStatement; check: () => void }>();
  const wrap = (statement: D1PreparedStatement, sql: string, args: unknown[]): D1PreparedStatement => {
    const check = () => {
      if (breaks(sql, args)) throw new Error("D1_ERROR: internal error at statement 3: SQLITE_BUSY");
    };
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql, values),
      all: async () => {
        check();
        const answer = await statement.all();
        seen.rows += answer.results.length;
        return answer;
      },
      first: async () => (check(), statement.first()),
      run: async () => (check(), statement.run()),
    } as unknown as D1PreparedStatement;
    real.set(wrapped, { statement, check });
    return wrapped;
  };
  const db = {
    prepare: (sql: string) => wrap(env.DB.prepare(sql), sql, []),
    batch: async (statements: D1PreparedStatement[]) => {
      for (const s of statements) real.get(s)!.check();
      return env.DB.batch(statements.map((s) => real.get(s)!.statement));
    },
  } as unknown as D1Database;
  return { db, seen };
}

describe("reverting an author", () => {
  const NOTHING = { reverted: [], emptied: [], failed: [], next: null };
  const revertAuthor = (actor: Actor, author: { kind: "member" | "agent"; id: string }, noteIds?: string[]) => perform(env.DB, actor, { type: "history.revertAuthor", author, noteIds });

  it("takes an agent's changes back out of every note, as one new change in each by the member who asked", async () => {
    const { ada, claude, id } = await sharedNote();
    const other = await perform(env.DB, ada, { type: "note.create", text: "# Trip" });
    await write(claude.actor, other.id, "# Trip\n\nPack");
    await write(claude.actor, other.id, "# Trip\n\nPack\n\nGo");
    const untouched = await perform(env.DB, ada, { type: "note.create", text: "# Mine" });

    const { reverted, failed, next } = await revertAuthor(ada, claude.ref);

    expect([failed, next]).toEqual([[], null]);
    expect(reverted.map((r) => [r.note.id, r.note.revision, r.revisions]).sort()).toEqual(
      [
        [id, 5, [3]],
        [other.id, 4, [2, 3]],
      ].sort(),
    );
    expect(await read(ada, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
    expect(await read(ada, other.id)).toBe("# Trip");
    expect((await history(ada, id)).at(-1)).toMatchObject({ author: { kind: "member", personId: ada.personId }, reverts: { how: "revert", revisions: [3] } });
    expect((await history(ada, other.id)).map((c) => c.revertedBy)).toEqual([null, 4, 4, null]);
    expect(await history(ada, untouched.id)).toHaveLength(1);
    expect((await perform(env.DB, ada, { type: "history.list", authors: [claude.ref] })).changes.every((c) => c.revertedBy !== null)).toBe(true);
  });

  it("changes nothing when asked again, or when the author changed nothing here", async () => {
    const { ada, claude, id } = await sharedNote();
    await revertAuthor(ada, claude.ref);

    expect(await revertAuthor(ada, claude.ref)).toEqual(NOTHING);
    expect(await revertAuthor(ada, { kind: "agent", id: "aaaaaaaaaaaa" })).toEqual(NOTHING);
    expect(await history(ada, id)).toHaveLength(5);
  });

  it("skips a change that was already taken out, and a note where every one was", async () => {
    const { ada, claude, id } = await sharedNote();
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [3] });
    await write(claude.actor, id, "# Plan\n\nAda's step\n\nAda's last word\n\nClaude again");
    const done = await perform(env.DB, ada, { type: "note.create", text: "# Done" });
    await write(claude.actor, done.id, "# Done\n\nClaude");
    await perform(env.DB, ada, { type: "note.revertChanges", id: done.id, revisions: [2] });

    const { reverted } = await revertAuthor(ada, claude.ref);

    expect(reverted.map((r) => [r.note.id, r.revisions])).toEqual([[id, [6]]]);
    expect(await read(ada, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
    expect(await history(ada, done.id)).toHaveLength(3);
  });

  it("leaves alone a change the agent undid itself, and puts back what the agent took out of a member's", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const undone = await perform(env.DB, ada, { type: "note.create", text: "# Undone" });
    await write(claude.actor, undone.id, "# Undone\n\nClaude");
    await perform(env.DB, claude.actor, { type: "note.undo", id: undone.id });
    const cut = await perform(env.DB, ada, { type: "note.create", text: "# Cut" });
    await write(ada, cut.id, "# Cut\n\nAda's line");
    await perform(env.DB, claude.actor, { type: "note.revertChanges", id: cut.id, revisions: [2] });

    expect((await revertAuthor(ada, claude.ref)).reverted.map((r) => [r.note.id, r.revisions])).toEqual([[cut.id, [3]]]);

    expect(await history(ada, undone.id)).toHaveLength(3);
    expect(await read(ada, cut.id)).toBe("# Cut\n\nAda's line");
    expect((await history(ada, cut.id)).map((c) => c.revertedBy)).toEqual([null, null, 4, null]);
    expect(await revertAuthor(ada, claude.ref)).toEqual(NOTHING);
  });

  it("takes an agent's changes out again after they were put back and the agent wrote more, whoever asks", async () => {
    const { ada, claude, id } = await sharedNote();
    await revertAuthor(ada, claude.ref);
    await perform(env.DB, ada, { type: "note.reapplyChanges", id, revisions: [3] });
    expect(await read(ada, id)).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");
    await write(claude.actor, id, "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word\n\nClaude again");

    expect((await revertAuthor(claude.actor, claude.ref)).reverted.map((r) => r.revisions)).toEqual([[3, 7]]);

    expect(await read(ada, id)).toBe("# Plan\n\nAda's step\n\nAda's last word");
    expect(await revertAuthor(claude.actor, claude.ref)).toEqual(NOTHING);
    expect(await revertAuthor(ada, claude.ref)).toEqual(NOTHING);
    expect(await history(ada, id)).toHaveLength(8);
  });

  it("names a note the revert left empty, which only the agent wrote in, and not one that keeps a member's text", async () => {
    const { ada, claude, id } = await sharedNote();
    const draft = await perform(env.DB, claude.actor, { type: "note.create", text: "# Draft\n\nClaude's own" });
    await write(claude.actor, draft.id, "# Draft\n\nClaude's own, longer");
    const joint = await perform(env.DB, claude.actor, { type: "note.create", text: "# Joint" });
    await write(ada, joint.id, "# Joint\n\nAda's line");

    const { reverted, emptied } = await revertAuthor(ada, claude.ref);

    expect(emptied).toEqual([{ noteId: draft.id, title: "Draft" }]);
    expect(reverted.map((r) => r.note.id).sort()).toEqual([id, draft.id, joint.id].sort());
    expect([await read(ada, draft.id), await read(ada, joint.id)]).toEqual(["", "\n\nAda's line"]);
    expect((await revertAuthor(ada, claude.ref)).emptied).toEqual([]);
  });

  it("prints the notes left empty from the ink command", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const draft = await perform(env.DB, claude.actor, { type: "note.create", text: "# Draft" });
    const said: string[] = [];
    const io = {
      env: { INK_TOKEN: (await agentOf(ada, "Reverter")).token, INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line: string) => said.push(line),
      fetch: ((url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env)) as unknown as typeof fetch,
    };

    expect(await run(["revert-author", `agent:${claude.ref.id}`], io)).toBe(0);

    expect(said.map((line) => JSON.parse(line).emptied)).toEqual([[{ noteId: draft.id, title: "Draft" }]]);
  });

  it("passes over a note that refuses the change, names it, and reverts the notes after it", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const long = "x".repeat(300_000);
    const notes = [];
    for (let i = 0; i < 3; i++) notes.push(await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` }));
    for (const note of notes) await write(claude.actor, note.id, `${note.text}\n\nClaude`);
    const [full] = notes.map((n) => n.id).sort();
    await perform(env.DB, ada, { type: "note.revert", id: full!, revision: 0 });
    await write(ada, full!, long);
    await write(claude.actor, full!, "short");
    await write(ada, full!, `short${long}`);

    const { reverted, failed, next } = await revertAuthor(ada, claude.ref);

    expect(failed).toEqual([{ noteId: full, title: "", message: "With the other changes merged in, the note would be over 500000 characters" }]);
    expect(reverted.map((r) => r.note.id).sort()).toEqual(notes.map((n) => n.id).sort().slice(1));
    expect(next).toBeNull();
    expect(await read(ada, full!)).toBe(`short${long}`);
  });

  it("keeps to the notes named, and to the one token asked for when two share a name", async () => {
    const { ada, claude, id } = await sharedNote();
    const twin = await agentOf(ada, "Claude");
    await write(twin.actor, id, "# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word\n\nTwin's step");
    const other = await perform(env.DB, ada, { type: "note.create", text: "# Trip" });
    await write(claude.actor, other.id, "# Trip\n\nPack");

    expect((await revertAuthor(ada, claude.ref, [id])).reverted.map((r) => [r.note.id, r.revisions])).toEqual([[id, [3]]]);

    expect(await read(ada, id)).toBe("# Plan\n\nAda's step\n\nAda's last word\n\nTwin's step");
    expect(await read(ada, other.id)).toBe("# Trip\n\nPack");
  });

  it("covers ten notes a request and says where to carry on from, so asking again finishes", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    for (let i = 0; i < 12; i++) {
      const note = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
      await write(claude.actor, note.id, `# Note ${i}\n\nClaude`);
    }

    const first = await revertAuthor(ada, claude.ref);
    const second = await perform(env.DB, ada, { type: "history.revertAuthor", author: claude.ref, after: first.next! });

    expect([first.reverted.length, second.reverted.length, second.next]).toEqual([10, 2, null]);
    expect(first.next).toBe(first.reverted.map((r) => r.note.id).sort().at(-1));
    expect((await perform(env.DB, ada, { type: "note.list" })).map((n) => n.snippet)).toEqual(Array(12).fill(""));
  });

  it("reads only the notes of the page it covers, however many more the author changed", async () => {
    const rowsForFirstPage = async (notes: number) => {
      const ada = await newMember("Ada Lovelace");
      const claude = await agentOf(ada);
      for (let i = 0; i < notes; i++) {
        const note = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
        await write(claude.actor, note.id, `# Note ${i}\n\nClaude`);
      }
      const { db, seen } = watched();
      expect((await perform(db, ada, { type: "history.revertAuthor", author: claude.ref })).reverted).toHaveLength(10);
      return seen.rows;
    };

    expect(await rowsForFirstPage(30)).toBe(await rowsForFirstPage(11));
  });

  it("carries on past a page of notes that need nothing", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const note = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
      await write(claude.actor, note.id, `# Note ${i}\n\nClaude`);
      ids.push(note.id);
    }
    ids.sort();
    for (const id of ids.slice(0, 10)) await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [2] });

    const first = await revertAuthor(ada, claude.ref);
    const second = await perform(env.DB, ada, { type: "history.revertAuthor", author: claude.ref, after: first.next! });

    expect(first).toEqual({ reverted: [], emptied: [], failed: [], next: ids[9] });
    expect([second.reverted.map((r) => r.note.id).sort(), second.next]).toEqual([ids.slice(10), null]);
  });

  it("passes over a note the database fails on, without saying how it failed, and still answers with the rest", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const note = await perform(env.DB, ada, { type: "note.create", text: `# Note ${i}` });
      await write(claude.actor, note.id, `# Note ${i}\n\nClaude`);
      ids.push(note.id);
    }
    ids.sort();
    const { db } = watched((sql, args) => sql.startsWith("INSERT INTO changes") && args[0] === ids[1]);

    const answer = await perform(db, ada, { type: "history.revertAuthor", author: claude.ref });

    expect(answer.reverted.map((r) => r.note.id)).toEqual([ids[0], ids[2]]);
    expect(answer.failed).toEqual([{ noteId: ids[1], title: expect.stringMatching(/^Note \d$/), message: "Common Ink couldn't change this note just now. Try again." }]);
    expect(await read(ada, ids[1]!)).toMatch(/Claude$/);
  });

  it("records a revert of more than 500 changes that can be put back, by name or by taking the revert out", async () => {
    const ada = await newMember("Ada Lovelace");
    const claude = await agentOf(ada);
    const note = await perform(env.DB, ada, { type: "note.create", text: "# Log" });
    let text = "# Log";
    for (let i = 1; i <= 501; i++) text = (await perform(env.DB, claude.actor, { type: "note.write", id: note.id, baseRevision: i, text: `${text}\n${i}` })).text;
    const all = Array.from({ length: 501 }, (_, i) => i + 2);

    expect((await revertAuthor(ada, claude.ref)).reverted.map((r) => r.revisions)).toEqual([all]);
    expect(await read(ada, note.id)).toBe("# Log");

    expect((await perform(env.DB, ada, { type: "note.reapplyChanges", id: note.id, revisions: all })).text).toBe(text);
    await revertAuthor(ada, claude.ref);
    expect(await read(ada, note.id)).toBe("# Log");
    expect((await perform(env.DB, ada, { type: "note.revertChanges", id: note.id, revisions: [505] })).text).toBe(text);
  }, 60_000);

  it("is the member's own to do for themselves too, and never reaches another workspace's notes", async () => {
    const { ada, claude, id } = await sharedNote();
    const mallory = await newMember("Mallory");
    const hers = await perform(env.DB, mallory, { type: "note.create", text: "# Hers" });

    expect(await revertAuthor(mallory, claude.ref, [id])).toEqual(NOTHING);
    expect(await revertAuthor(mallory, memberRef(ada))).toEqual(NOTHING);
    expect(await history(ada, id)).toHaveLength(4);

    expect((await revertAuthor(ada, memberRef(ada))).reverted.map((r) => r.revisions)).toEqual([[1, 2, 4]]);
    expect(await read(ada, id)).toBe("\n\nClaude's step");
    expect(await history(mallory, hers.id)).toHaveLength(1);
  });

  it("is reached through the MCP tool and the ink command, where the new change is the calling agent's", async () => {
    const { ada, claude, id } = await sharedNote();
    const fixer = await agentOf(ada, "Fixer");

    const answer = (await tool(fixer.token, "revert_author", { author: claude.ref })).json();

    expect(answer.reverted.map((r: { revisions: number[] }) => r.revisions)).toEqual([[3]]);
    expect((await history(ada, id)).at(-1)!.author).toMatchObject({ kind: "agent", name: "Fixer" });

    const seen: unknown[] = [];
    const pages = [{ reverted: [], emptied: [], failed: [], next: "bbbbbbbbbbbb" }, { reverted: [], emptied: [], failed: [], next: null }];
    const said: string[] = [];
    const io = {
      env: { INK_TOKEN: "cink_x", INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line: string) => said.push(line),
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).params);
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(pages[seen.length - 1]) }] } });
      }) as unknown as typeof fetch,
    };
    expect(await run(["revert-author", `agent:${claude.ref.id}`, "--note", id], io)).toBe(0);
    expect(await run(["revert-author"], io)).toBe(2);
    expect(seen).toEqual([
      { name: "revert_author", arguments: { author: claude.ref, noteIds: [id] } },
      { name: "revert_author", arguments: { author: claude.ref, noteIds: [id], after: "bbbbbbbbbbbb" } },
    ]);
    expect(said.slice(0, 2).map((line) => JSON.parse(line))).toEqual(pages);
  });
});

describe("who may move through history", () => {
  const writes = (id: string): OpInput[] => [
    { type: "note.label", id, revision: 1, name: "Start" },
    { type: "note.revert", id, revision: 1 },
    { type: "note.revertChanges", id, revisions: [2] },
    { type: "note.reapplyChanges", id, revisions: [2] },
    { type: "note.undo", id },
    { type: "note.redo", id },
  ];
  /** A change that names no note, so a stranger asking for it reaches only their own workspace. */
  const revertAuthor: OpInput = { type: "history.revertAuthor", author: { kind: "agent", id: "aaaaaaaaaaaa" } };
  const reads = (id: string): OpInput[] => [{ type: "history.list", noteIds: [id] }, { type: "history.authors" }, { type: "history.activity", timeZone: "UTC" }, { type: "note.history", id }];

  it("a viewer reads history and can't label, revert, apply, undo, or redo", async () => {
    const { ada, id } = await sharedNote();
    const viewer = await addMember(ada, "viewer");

    for (const op of reads(id)) await expect(perform(env.DB, viewer, op)).resolves.toBeTruthy();
    for (const op of [...writes(id), revertAuthor]) await expect(perform(env.DB, viewer, op)).rejects.toMatchObject({ code: "forbidden", message: `A viewer can't ${op.type}` });
    expect(await history(ada, id)).toHaveLength(4);
  });

  it("a read-only token reads history and is refused every change, even for an admin", async () => {
    const { ada, id } = await sharedNote();
    const reader = await agentOf(ada, "Reader", { readOnly: true });

    for (const op of reads(id)) await expect(perform(env.DB, reader.actor, op)).resolves.toBeTruthy();
    for (const op of [...writes(id), revertAuthor]) await expect(perform(env.DB, reader.actor, op)).rejects.toMatchObject({ code: "forbidden", message: `A read-only token can't ${op.type}` });
    expect(await tool(reader.token, "revert_note", { id, revision: 1 })).toMatchObject({ isError: true, text: "forbidden: A read-only token can't note.revert" });
    expect((await tool(reader.token, "history", { noteIds: [id] })).json().changes).toHaveLength(4);
    expect(await history(ada, id)).toHaveLength(4);
    expect((await history(ada, id)).map((c) => c.label)).toEqual([null, null, null, null]);
  });

  it("an agent's access is its member's: a viewer's agent is refused, and nobody reaches another workspace's note", async () => {
    const { ada, id } = await sharedNote();
    const viewersAgent = await agentOf(await addMember(ada, "viewer"), "Watcher");
    const stranger = await newMember("Mallory");

    for (const op of [...writes(id), revertAuthor]) await expect(perform(env.DB, viewersAgent.actor, op)).rejects.toMatchObject({ code: "forbidden" });
    for (const op of writes(id)) await expect(perform(env.DB, stranger, op)).rejects.toMatchObject({ code: "not_found" });
    expect(await history(ada, id)).toHaveLength(4);
  });
});

describe("history for an agent", () => {
  it("is reached through the MCP tools, and what the agent does is recorded as the agent's", async () => {
    const { ada, claude, id } = await sharedNote();

    expect((await tool(claude.token, "history_authors")).json().map((a: { name: string }) => a.name)).toEqual(["Ada Lovelace", "Claude"]);
    expect((await tool(claude.token, "history", { authors: [claude.ref] })).json().changes.map((c: HistoryEntry) => c.revision)).toEqual([3]);
    expect((await tool(claude.token, "label_revision", { id, revision: 2, name: "Before me" })).json()).toEqual({ id, revision: 2, label: "Before me" });
    expect((await tool(claude.token, "revert_changes", { id, revisions: [3] })).json().text).toBe("# Plan\n\nAda's step\n\nAda's last word");
    expect((await tool(claude.token, "reapply_changes", { id, revisions: [3] })).json().revision).toBe(6);
    expect((await tool(claude.token, "undo", { id })).json().revision).toBe(7);
    expect((await tool(claude.token, "redo", { id })).json().revision).toBe(8);
    expect((await tool(claude.token, "revert_note", { id, revision: 2 })).json().text).toBe("# Plan\n\nAda's step");
    expect((await tool(claude.token, "activity", { timeZone: "UTC" })).json().days.reduce((n: number, d: { count: number }) => n + d.count, 0)).toBe(6);
    expect(await tool(claude.token, "revert_changes", { id, revisions: "3" })).toMatchObject({ isError: true });

    expect((await history(ada, id)).slice(4).map((c) => c.author.name)).toEqual(Array(5).fill("Claude"));
  });

  it("is reached through the ink command", async () => {
    const seen: Array<[string, unknown]> = [];
    const io = {
      env: { INK_TOKEN: "cink_x", INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: () => {},
      fetch: (async (_url: string, init: RequestInit) => {
        const { params } = JSON.parse(init.body as string);
        seen.push([params.name, params.arguments]);
        return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "OK" }] } });
      }) as unknown as typeof fetch,
    };
    const id = "aaaaaaaaaaaa";

    expect(await run(["changes", "--note", `${id},bbbbbbbbbbbb`, "--author", "agent:cccccccccccc", "--from", "2026-03-01T00:00:00Z", "--to", "2026-03-02T00:00:00Z"], io)).toBe(0);
    expect(await run(["authors"], io)).toBe(0);
    expect(await run(["activity", "--timezone", "America/Chicago"], io)).toBe(0);
    expect(await run(["label", id, "--revision", "2", "--name", "Draft"], io)).toBe(0);
    expect(await run(["label", id, "--revision", "2"], io)).toBe(0);
    expect(await run(["revert", id, "--revision", "2"], io)).toBe(0);
    expect(await run(["revert", id, "--changes", "3,4"], io)).toBe(0);
    expect(await run(["reapply", id, "--changes", "3"], io)).toBe(0);
    expect(await run(["undo", id], io)).toBe(0);
    expect(await run(["redo", id], io)).toBe(0);
    expect(await run(["revert", id], io)).toBe(2);
    expect(await run(["changes", "--from", "soon"], io)).toBe(2);

    expect(seen).toEqual([
      ["history", { noteIds: [id, "bbbbbbbbbbbb"], authors: [{ kind: "agent", id: "cccccccccccc" }], from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 2) }],
      ["history_authors", {}],
      ["activity", { timeZone: "America/Chicago" }],
      ["label_revision", { id, revision: 2, name: "Draft" }],
      ["label_revision", { id, revision: 2, name: null }],
      ["revert_note", { id, revision: 2 }],
      ["revert_changes", { id, revisions: [3, 4] }],
      ["reapply_changes", { id, revisions: [3] }],
      ["undo", { id }],
      ["redo", { id }],
    ]);
  });
});
