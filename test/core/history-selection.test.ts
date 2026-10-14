import type { ChangeSet } from "@codemirror/state";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { run } from "../../scripts/ink-cli.ts";
import { connectAgent } from "../../src/core/agents.ts";
import { revertedBy, revertible, reverting, runsOf, settledRevert, takeBackOut, type Recorded } from "../../src/core/history.ts";
import { MAX_ANSWER_LINES, perform, type Actor } from "../../src/core/operations.ts";
import { MAX_NOTES_AT_ONCE, OpError, type DiffRun, type Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";
import worker from "../../src/worker/index.ts";
import { addMember, newMember } from "./members.ts";

const T0 = Date.UTC(2026, 2, 1, 12);
const MINUTE = 60_000;

const text = async (actor: Actor, id: string) => (await perform(env.DB, actor, { type: "note.read", id })).text;
const revisionOf = async (actor: Actor, id: string) => (await perform(env.DB, actor, { type: "note.read", id })).revision;
const write = async (actor: Actor, id: string, to: string, now?: number) => perform(env.DB, actor, { type: "note.write", id, baseRevision: await revisionOf(actor, id), text: to }, now);

/** A note with one change for each text, a minute apart. */
async function noteOf(actor: Actor, ...texts: string[]) {
  const { id } = await perform(env.DB, actor, { type: "note.create", text: texts[0]! }, T0);
  for (const [i, to] of texts.slice(1).entries()) await write(actor, id, to, T0 + (i + 1) * MINUTE);
  return id;
}

async function agentOf(member: Actor, options: { readOnly?: boolean } = {}) {
  const { agent, token } = await connectAgent(env.DB, member.personId, "Claude", options);
  const actor: Actor = { kind: "agent", agentId: agent.id, personId: member.personId, workspaceId: member.workspaceId, scope: { readOnly: options.readOnly } };
  return { actor, token };
}

const lines = (run: DiffRun) => run.diff!.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "same").map((l) => `${l.kind === "add" ? "+" : "-"}${l.text}`));
const refusal = (op: Promise<unknown>) => op.then(() => null, (err: unknown) => (err instanceof OpError ? `${err.code}: ${err.message}` : String(err)));

describe("the runs a note's picked changes make", () => {
  it("are the changes that follow one another, each run counting the changes left out since the run before", () => {
    expect(runsOf([3])).toEqual([{ from: 3, to: 3, skipped: 0 }]);
    expect(runsOf([4, 2, 3])).toEqual([{ from: 2, to: 4, skipped: 0 }]);
    expect(runsOf([1, 2, 5, 9, 10, 10])).toEqual([
      { from: 1, to: 2, skipped: 0 },
      { from: 5, to: 5, skipped: 2 },
      { from: 9, to: 10, skipped: 3 },
    ]);
    expect(runsOf([])).toEqual([]);
  });
});

describe("the changes a revert of a selection takes out", () => {
  const edit = (revision: number) => ({ revision, reverts: null });
  const revert = (revision: number, revisions: number[]) => ({ revision, reverts: { how: "revert" as const, revisions } });

  it("are the picked ones that still stand", () => {
    expect(revertible([edit(1), edit(2), edit(3)], [3, 2])).toEqual({ revisions: [2, 3], already: [] });
  });

  it("leave out a change that a change not picked already took out", () => {
    expect(revertible([edit(1), edit(2), revert(3, [2])], [1, 2])).toEqual({ revisions: [1], already: [2] });
    expect(revertible([edit(1), edit(2), revert(3, [2])], [2])).toEqual({ revisions: [], already: [2] });
  });

  it("keep a change picked together with the revert that took it out, so both go and it stays out", () => {
    expect(revertible([edit(1), edit(2), revert(3, [2])], [2, 3])).toEqual({ revisions: [2, 3], already: [] });
  });

  it("take a change that was reverted and stands again, and leave out the revert that no longer stands", () => {
    const steps = [edit(1), edit(2), revert(3, [2]), revert(4, [3])];
    expect(revertible(steps, [2, 3])).toEqual({ revisions: [2], already: [3] });
    expect(revertible(steps, [3, 4])).toEqual({ revisions: [3, 4], already: [] });
  });
});

describe("what a selection of changes did", () => {
  it("is one diff for a note's changes that follow one another: from the note before the first to the note after the last", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "# Plan", "# Plan\none", "# Plan\none\ntwo", "# Plan\none\ntwo\nthree");

    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [3, 2, 4] }] });

    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ noteId: id, noteTitle: "Plan", revision: 4, added: 3, removed: 0 });
    expect(notes[0]!.runs).toHaveLength(1);
    expect(notes[0]!.runs[0]).toMatchObject({ from: 2, to: 4, saves: 3, skipped: 0, firstAt: T0 + MINUTE, lastAt: T0 + 3 * MINUTE, added: 3, removed: 0 });
    expect(notes[0]!.runs[0]!.authors).toEqual([{ kind: "member", personId: ada.personId, name: "Ada Lovelace" }]);
    expect(lines(notes[0]!.runs[0]!)).toEqual(["+one", "+two", "+three"]);
  });

  it("starts a new run after a change left out, which that run counts, and counts none before the first run or after the last", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "a", "a\nb", "a\nb\nc", "a\nb\nc\nd", "a\nb\nc\nd\ne", "a\nb\nc\nd\ne\nf");

    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [2, 5] }] });

    expect(notes[0]!.runs.map((r) => [r.from, r.to, r.saves, r.skipped, lines(r)])).toEqual([
      [2, 2, 1, 0, ["+b"]],
      [5, 5, 1, 2, ["+e"]],
    ]);
    expect(notes[0]).toMatchObject({ added: 2, removed: 0 });
  });

  it("counts nothing for a line written and taken out again within a run, where each change's own count would", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "start", "start\ndraft", "start", "start\nkept");

    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [2, 3, 4] }] });

    expect(notes[0]).toMatchObject({ added: 1, removed: 0 });
    expect(lines(notes[0]!.runs[0]!)).toEqual(["+kept"]);
    const whole = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [2, 3] }] });
    expect(whole.notes[0]!.runs[0]).toMatchObject({ added: 0, removed: 0, diff: { hunks: [] } });
  });

  it("covers several notes at once, the note whose selected changes are the latest first, and a run by two authors names both", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const older = await noteOf(ada, "# Older", "# Older\nx");
    const newer = await noteOf(ada, "# Newer");
    await write(claude.actor, newer, "# Newer\nfrom the agent", T0 + 10 * MINUTE);
    await write(ada, newer, "# Newer\nfrom the agent\nfrom Ada", T0 + 11 * MINUTE);

    const { notes } = await perform(env.DB, claude.actor, {
      type: "history.diff",
      changes: [
        { noteId: older, revisions: [2] },
        { noteId: newer, revisions: [2, 3] },
      ],
    });

    expect(notes.map((n) => [n.noteTitle, n.added, n.removed])).toEqual([
      ["Newer", 2, 0],
      ["Older", 1, 0],
    ]);
    expect(notes[0]!.runs[0]!.authors.map((a) => a.name)).toEqual(["Claude", "Ada Lovelace"]);
  });

  it("carries the label on the revision a run ends at", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "a", "a\nb");
    await perform(env.DB, ada, { type: "note.label", id, revision: 2, name: "Good" });
    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [1, 2] }] });
    expect(notes[0]!.runs[0]!.label).toBe("Good");
  });

  it("leaves the diff out of the runs past the lines one answer holds and still counts them, and gives it when that note is asked for alone", async () => {
    const ada = await newMember();
    const long = (n: number) => Array.from({ length: 180 }, (_, i) => `note ${n} line ${i}`).join("\n");
    const count = Math.ceil(MAX_ANSWER_LINES / 180) + 1;
    const ids: string[] = [];
    for (let n = 0; n < count; n++) ids.push((await perform(env.DB, ada, { type: "note.create", text: long(n) }, T0 + n)).id);

    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: ids.map((noteId) => ({ noteId, revisions: [1] })) });

    expect(notes.every((n) => n.added === 180)).toBe(true);
    const without = notes.filter((n) => n.runs[0]!.diff === null);
    expect(without.length).toBe(1);
    expect(notes.at(-1)).toBe(without[0]);
    const alone = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: without[0]!.noteId, revisions: [1] }] });
    expect(alone.notes[0]!.runs[0]!.diff!.hunks[0]!.lines).toHaveLength(180);
  });

  it("gives every run of a note asked for alone its diff, however many lines they come to", async () => {
    const ada = await newMember();
    const block = (n: number) => Array.from({ length: 190 }, (_, i) => `block ${n} line ${i}`).join("\n");
    const texts = ["start"];
    for (let n = 0; n < 24; n++) texts.push(n % 2 ? `${texts.at(-1)}\nbetween ${n}` : `${texts.at(-1)}\n${block(n)}`);
    const id = await noteOf(ada, ...texts);
    const revisions = Array.from({ length: 12 }, (_, i) => 2 + i * 2);
    const { notes } = await perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions }] });
    expect(notes[0]!.runs).toHaveLength(12);
    expect(notes[0]!.runs.every((r) => r.diff !== null && r.added === 190)).toBe(true);
  });

  it("refuses a change a note doesn't have, a note in another workspace, a note named twice, and more notes than one request takes, each in words", async () => {
    const ada = await newMember();
    const grace = await newMember("Grace Hopper");
    const id = await noteOf(ada, "# Mine");
    const theirs = await noteOf(grace, "# Theirs");

    expect(await refusal(perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [2] }] }))).toBe("not_found: Mine has no change 2");
    expect(await refusal(perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: theirs, revisions: [1] }] }))).toBe("not_found: No such note");
    expect(await refusal(perform(env.DB, ada, { type: "history.diff", changes: [{ noteId: id, revisions: [1] }, { noteId: id, revisions: [1] }] }))).toContain("name each note once");
    const many = Array.from({ length: MAX_NOTES_AT_ONCE + 1 }, (_, i) => ({ noteId: `${String(i).padStart(4, "0")}aaaaaaaa`, revisions: [1] }));
    expect(await refusal(perform(env.DB, ada, { type: "history.diff", changes: many }))).toMatch(/invalid: .*40/s);
  });

  it("is read by a viewer and by an agent through its tool and the CLI", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer");
    const claude = await agentOf(ada);
    const id = await noteOf(ada, "a", "a\nb");

    expect((await perform(env.DB, viewer, { type: "history.diff", changes: [{ noteId: id, revisions: [2] }] })).notes[0]!.added).toBe(1);

    const out: string[] = [];
    const io = {
      fetch: ((url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env)) as unknown as typeof fetch,
      env: { INK_TOKEN: claude.token, INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line: string) => void out.push(line),
    };
    expect(await run(["diffs", `${id}:1,2`], io)).toBe(0);
    expect(JSON.parse(out[0]!).notes[0]).toMatchObject({ noteId: id, added: 2, runs: [{ from: 1, to: 2, saves: 2 }] });
    expect(await run(["diffs", "nonsense"], io)).toBe(2);
    expect(out[1]).toContain("write ID:N,N");
  });
});

describe("reverting changes of several notes at once", () => {
  async function three(ada: Actor) {
    const plan = await noteOf(ada, "# Plan", "# Plan\nstep one", "# Plan\nstep one\nstep two");
    const list = await noteOf(ada, "# List", "# List\nmilk");
    const log = await noteOf(ada, "# Log", "# Log\nmonday", "# Log\nmonday\ntuesday");
    return { plan, list, log };
  }

  it("previews every note in one answer and writes nothing: each note's revision, the changes it would revert, and its diff", async () => {
    const ada = await newMember();
    const { plan, list } = await three(ada);

    const previews = await perform(env.DB, ada, {
      type: "history.previewRevert",
      changes: [
        { noteId: plan, revisions: [2, 3] },
        { noteId: list, revisions: [2] },
      ],
    });

    expect(previews.map((p) => [p.noteTitle, p.revision, p.revisions, p.already, p.diff.added, p.diff.removed, p.conflicts.length])).toEqual([
      ["Plan", 3, [2, 3], [], 0, 2, 0],
      ["List", 2, [2], [], 0, 1, 0],
    ]);
    expect(await text(ada, plan)).toBe("# Plan\nstep one\nstep two");
    expect(await revisionOf(ada, list)).toBe(2);
  });

  it("makes one new change in each note, and says which notes it reverted, at which revision, and which changes", async () => {
    const ada = await newMember();
    const { plan, list, log } = await three(ada);

    const done = await perform(env.DB, ada, {
      type: "history.revert",
      changes: [
        { noteId: plan, revisions: [2, 3], at: 3 },
        { noteId: list, revisions: [2], at: 2 },
        { noteId: log, revisions: [3], at: 3 },
      ],
    });

    expect(done).toEqual({
      reverted: [
        { noteId: plan, noteTitle: "Plan", revision: 4, reverted: [2, 3] },
        { noteId: list, noteTitle: "List", revision: 3, reverted: [2] },
        { noteId: log, noteTitle: "Log", revision: 4, reverted: [3] },
      ],
      skipped: [],
    });
    expect([await text(ada, plan), await text(ada, list), await text(ada, log)]).toEqual(["# Plan", "# List", "# Log\nmonday"]);
    const history = await perform(env.DB, ada, { type: "note.history", id: plan });
    expect(history.at(-1)).toMatchObject({ revision: 4, reverts: { how: "revert", revisions: [2, 3] }, restores: 0 });
    expect(history.slice(1, 3).map((c) => c.revertedBy)).toEqual([4, 4]);
  });

  it("skips a note that changed since it was previewed and names it, reverts the others, and reverts the skipped one from a fresh preview", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const { plan, list, log } = await three(ada);
    const changes = [
      { noteId: plan, revisions: [3] },
      { noteId: list, revisions: [2] },
      { noteId: log, revisions: [3] },
    ];
    const previews = await perform(env.DB, ada, { type: "history.previewRevert", changes });
    await write(claude.actor, list, "# List\nmilk\neggs");

    const done = await perform(env.DB, ada, { type: "history.revert", changes: changes.map((c, i) => ({ ...c, at: previews[i]!.revision })) });

    expect(done.reverted.map((r) => r.noteTitle)).toEqual(["Plan", "Log"]);
    expect(done.skipped).toEqual([{ noteId: list, noteTitle: "List", why: "changed", message: "List has changed since this revert was previewed, so it was left as it is. Preview its revert again" }]);
    expect(await text(ada, list)).toBe("# List\nmilk\neggs");
    expect(await revisionOf(ada, list)).toBe(3);

    const [again] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [changes[1]!] });
    expect(again).toMatchObject({ revision: 3, revisions: [2], diff: { added: 0, removed: 1 } });
    const retried = await perform(env.DB, ada, { type: "history.revert", changes: [{ ...changes[1]!, at: again!.revision }] });
    expect(retried.reverted).toEqual([{ noteId: list, noteTitle: "List", revision: 4, reverted: [2] }]);
    expect(await text(ada, list)).toBe("# List\neggs");
  });

  it("is undone by reverting the changes it made, each where the note is still at that change, and a note edited since is skipped and named", async () => {
    const ada = await newMember();
    const { plan, list, log } = await three(ada);
    const { reverted } = await perform(env.DB, ada, {
      type: "history.revert",
      changes: [
        { noteId: plan, revisions: [2, 3] },
        { noteId: list, revisions: [2] },
        { noteId: log, revisions: [2] },
      ],
    });
    await write(ada, log, "# Log\ntuesday\nwednesday");

    const undone = await perform(env.DB, ada, { type: "history.revert", changes: reverted.map((r) => ({ noteId: r.noteId, revisions: [r.revision], at: r.revision })) });

    expect(undone.reverted.map((r) => [r.noteTitle, r.revision, r.reverted])).toEqual([
      ["Plan", 5, [4]],
      ["List", 4, [3]],
    ]);
    expect(undone.skipped.map((s) => [s.noteTitle, s.why])).toEqual([["Log", "changed"]]);
    expect([await text(ada, plan), await text(ada, list), await text(ada, log)]).toEqual(["# Plan\nstep one\nstep two", "# List\nmilk", "# Log\ntuesday\nwednesday"]);
    const history = await perform(env.DB, ada, { type: "note.history", id: plan });
    expect(history.at(-1)).toMatchObject({ reverts: { revisions: [4] }, restores: 1 });
    expect(history.map((c) => c.revertedBy)).toEqual([null, null, null, 5, null]);
  });

  it("leaves be the changes already reverted and says which, reverting the rest of the selection", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "a", "a\nb", "a\nb\nc");
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [2] });

    const [preview] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, revisions: [2, 3] }] });
    expect(preview).toMatchObject({ revisions: [3], already: [2], diff: { added: 0, removed: 1 } });

    const done = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [2, 3], at: 4 }] });
    expect(done.reverted).toEqual([{ noteId: id, noteTitle: "a", revision: 5, reverted: [3] }]);
    expect(await text(ada, id)).toBe("a");
  });

  it("changes nothing and records nothing for a selection that is all reverted already, or a revert together with the one change it reverted", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "# N", "# N\nb", "# N\nb\nc");
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [2] });

    const previews = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, revisions: [2] }] });
    expect(previews[0]).toMatchObject({ revisions: [], already: [2], diff: { hunks: [], added: 0, removed: 0 } });
    const both = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, revisions: [2, 4] }] });
    expect(both[0]).toMatchObject({ revisions: [2, 4], already: [], diff: { hunks: [] } });

    for (const revisions of [[2], [2, 4]]) {
      const done = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions, at: 4 }] });
      expect(done).toEqual({ reverted: [], skipped: [{ noteId: id, noteTitle: "N", why: "nothing", message: "Nothing in N would change" }] });
    }
    expect(await revisionOf(ada, id)).toBe(4);
    expect(await text(ada, id)).toBe("# N\nc");
  });

  it("reverts everything selected after a revision to exactly the note at that revision, reverts among them and all", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "one", "one\ntwo", "one\ntwo\nthree");
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [2] });
    await write(ada, id, "one\nthree\nfour");
    await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [4] });
    expect(await text(ada, id)).toBe("one\ntwo\nthree\nfour");

    const done = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [2, 3, 4, 5, 6] }] });

    expect(done.reverted[0]!.reverted).toEqual([2, 3, 4, 5, 6]);
    expect(await text(ada, id)).toBe("one");
  });

  it("returns a note to a revision, as reverting one note to it does", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "a", "a\nb", "a\nb\nc");
    const [preview] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, to: 1 }] });
    expect(preview).toMatchObject({ revisions: [2, 3], already: [], diff: { removed: 2 } });
    await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, to: 1, at: 3 }] });
    expect(await text(ada, id)).toBe("a");
    expect((await perform(env.DB, ada, { type: "note.history", id })).at(-1)!.reverts).toEqual({ how: "revert", revisions: [2, 3], to: 1 });
  });

  it("settles one note's conflicts as chosen while the other notes revert plainly", async () => {
    const ada = await newMember();
    const conflicted = await noteOf(ada, "# C\nline", "# C\nLINE", "# C\nLINE, edited later");
    const plain = await noteOf(ada, "# P", "# P\nx");
    const changes = [
      { noteId: conflicted, revisions: [2] },
      { noteId: plain, revisions: [2] },
    ];
    const previews = await perform(env.DB, ada, { type: "history.previewRevert", changes });
    expect(previews[0]!.conflicts).toMatchObject([{ line: 2, before: ["line"], now: ["LINE, edited later"], kept: ["line, edited later"] }]);
    // Where the conflict is on the diff of the change asked for: its second line, as that change left the note.
    expect(previews[0]!.conflicts[0]!.runs).toEqual([{ revision: 2, line: 2, lines: 1 }]);
    expect(previews[1]!.conflicts).toEqual([]);

    const back = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ ...changes[0]!, at: 3, choices: "back" }] });
    expect(back[0]!.diff.hunks[0]!.lines.filter((l) => l.kind === "add")).toEqual([{ kind: "add", text: "line" }]);

    await perform(env.DB, ada, { type: "history.revert", changes: [{ ...changes[0]!, at: 3, choices: ["back"] }, { ...changes[1]!, at: 2 }] });
    expect([await text(ada, conflicted), await text(ada, plain)]).toEqual(["# C\nline", "# P"]);
  });

  it("refuses the one note whose choices don't match its conflicts, in words, and reverts the others", async () => {
    const ada = await newMember();
    const conflicted = await noteOf(ada, "# C\nline", "# C\nLINE", "# C\nLINE, edited later");
    const plain = await noteOf(ada, "# P", "# P\nx");
    const done = await perform(env.DB, ada, {
      type: "history.revert",
      changes: [
        { noteId: conflicted, revisions: [2], at: 3, choices: ["back", "keep"] },
        { noteId: plain, revisions: [2] },
      ],
    });
    expect(done.reverted.map((r) => r.noteTitle)).toEqual(["P"]);
    expect(done.skipped).toMatchObject([{ noteTitle: "C", why: "refused", message: expect.stringContaining("1 conflict to settle, and 2 choices were given") }]);
    expect(await text(ada, conflicted)).toBe("# C\nLINE, edited later");
  });

  it("previews the notes that can be reverted when one of them can't, which says why and comes with nothing else", async () => {
    const ada = await newMember();
    const good = await noteOf(ada, "# Good", "# Good\nmore");
    const bad = await noteOf(ada, "# Bad");
    const previews = await perform(env.DB, ada, {
      type: "history.previewRevert",
      changes: [
        { noteId: bad, revisions: [9] },
        { noteId: good, revisions: [2] },
        { noteId: "nosuchnote00", revisions: [1] },
      ],
    });
    expect(previews.map((p) => [p.noteTitle, p.refused, p.revisions, p.diff.removed])).toEqual([
      ["Bad", "The note has no change 9", [], 0],
      ["Good", undefined, [2], 1],
      ["", "No such note", [], 0],
    ]);
  });

  it("names a reverted note by the title it had, when the revert leaves it with none", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "# Alpha", "# Alpha\nmore");
    const done = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [1, 2] }] });
    expect(done.reverted).toEqual([{ noteId: id, noteTitle: "Alpha", revision: 3, reverted: [1, 2] }]);
    expect(await text(ada, id)).toBe("");
  });

  it("is for those who can change notes: a viewer and a read-only agent preview and are refused the revert, and another workspace's note is no note", async () => {
    const ada = await newMember();
    const viewer = await addMember(ada, "viewer");
    const reader = await agentOf(ada, { readOnly: true });
    const grace = await newMember("Grace Hopper");
    const id = await noteOf(ada, "a", "a\nb");
    const changes = [{ noteId: id, revisions: [2] }];

    expect(await perform(env.DB, viewer, { type: "history.previewRevert", changes })).toHaveLength(1);
    expect(await refusal(perform(env.DB, viewer, { type: "history.revert", changes }))).toBe("forbidden: A viewer can't history.revert");
    expect(await refusal(perform(env.DB, reader.actor, { type: "history.revert", changes }))).toBe("forbidden: A read-only token can't history.revert");
    expect(await perform(env.DB, grace, { type: "history.previewRevert", changes })).toMatchObject([{ noteId: id, noteTitle: "", refused: "No such note", revisions: [] }]);
    expect(await perform(env.DB, grace, { type: "history.revert", changes })).toEqual({ reverted: [], skipped: [{ noteId: id, noteTitle: "", why: "refused", message: "No such note" }] });
    expect(await text(ada, id)).toBe("a\nb");
  });

  it("takes as many notes as one request does and says so past that, and a change a note doesn't have is that note's refusal alone", async () => {
    const ada = await newMember();
    const id = await noteOf(ada, "a", "a\nb");
    const many = Array.from({ length: MAX_NOTES_AT_ONCE + 1 }, (_, i) => ({ noteId: `${String(i).padStart(4, "0")}aaaaaaaa`, revisions: [1] }));
    expect(await refusal(perform(env.DB, ada, { type: "history.revert", changes: many }))).toMatch(/invalid: .*40/s);
    expect(await refusal(perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [1], choices: "back" }] }))).toContain("pass at");
    expect(await refusal(perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id }] }))).toContain("pass either revisions");

    const other = await noteOf(ada, "x", "x\ny");
    const done = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [7] }, { noteId: other, revisions: [2] }] });
    expect(done.reverted.map((r) => r.noteId)).toEqual([other]);
    expect(done.skipped).toMatchObject([{ noteId: id, why: "refused", message: "The note has no change 7" }]);
  });

  it("reverts forty notes in one request", async () => {
    const ada = await newMember();
    const ids: string[] = [];
    for (let n = 0; n < MAX_NOTES_AT_ONCE; n++) ids.push(await noteOf(ada, `# Note ${n}`, `# Note ${n}\nmore`));
    const done = await perform(env.DB, ada, { type: "history.revert", changes: ids.map((noteId) => ({ noteId, revisions: [2], at: 2 })) });
    expect(done.reverted).toHaveLength(MAX_NOTES_AT_ONCE);
    expect(done.skipped).toEqual([]);
    expect(await text(ada, ids[17]!)).toBe("# Note 17");
  });

  it("is an agent's through preview_reverts and revert_many, and the CLI's revert-many with @AT", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const { plan, list } = await three(ada);
    const out: string[] = [];
    const io = {
      fetch: ((url: string, init: RequestInit) => worker.fetch(new Request(url, init) as never, env)) as unknown as typeof fetch,
      env: { INK_TOKEN: claude.token, INK_URL: "https://ink.test" },
      stdin: async () => "",
      out: (line: string) => void out.push(line),
    };

    expect(await run(["revert-many", `${plan}:2,3`, `${list}:2`, "--preview"], io)).toBe(0);
    expect(JSON.parse(out[0]!).map((p: { revision: number; revisions: number[] }) => [p.revision, p.revisions])).toEqual([
      [3, [2, 3]],
      [2, [2]],
    ]);
    await write(ada, list, "# List\nmilk\neggs");
    expect(await run(["revert-many", `${plan}:2,3@3`, `${list}:2@2`], io)).toBe(0);
    const done = JSON.parse(out[1]!);
    expect(done.reverted.map((r: { noteTitle: string }) => r.noteTitle)).toEqual(["Plan"]);
    expect(done.skipped.map((s: { noteTitle: string; why: string }) => [s.noteTitle, s.why])).toEqual([["List", "changed"]]);
    const history = await perform(env.DB, ada, { type: "note.history", id: plan });
    expect(history.at(-1)!.author).toMatchObject({ kind: "agent", name: "Claude" });
  });

  it("reverts an author's changes in each note named with `author`: what stands of theirs when the revert is made, whatever they wrote since the preview", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const author = { kind: "agent" as const, id: (claude.actor as Extract<Actor, { kind: "agent" }>).agentId };
    const plan = await noteOf(ada, "# Plan");
    await write(claude.actor, plan, "# Plan\nclaude one");
    await write(ada, plan, "# Plan\nclaude one\nada");
    await write(claude.actor, plan, "# Plan\nclaude one\nada\nclaude two");
    const list = await noteOf(ada, "# List");
    await write(claude.actor, list, "# List\nmilk");
    const untouched = await noteOf(ada, "# Log", "# Log\nmonday");
    const asked = [plan, list, untouched].map((noteId) => ({ noteId, author }));

    const previews = await perform(env.DB, ada, { type: "history.previewRevert", changes: asked });
    expect(previews.map((p) => [p.noteTitle, p.revision, p.revisions, p.already, p.diff.hunks.length > 0])).toEqual([
      ["Plan", 4, [2, 4], [], true],
      ["List", 2, [2], [], true],
      ["Log", 2, [], [], false],
    ]);
    expect(previews[0]).toEqual((await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: plan, revisions: [2, 4] }] }))[0]);

    // Claude writes on after the preview. Held to the preview's revision the note is skipped, and asked for again it is reverted with the new change in.
    await write(claude.actor, list, "# List\nmilk\neggs");
    const held = await perform(env.DB, ada, { type: "history.revert", changes: asked.map((item, i) => ({ ...item, at: previews[i]!.revision })) });
    expect(held.reverted.map((r) => [r.noteTitle, r.reverted])).toEqual([["Plan", [2, 4]]]);
    expect(held.skipped.map((s) => [s.noteTitle, s.why])).toEqual([["List", "changed"], ["Log", "nothing"]]);
    const again = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: list, author }] });
    expect(again.reverted.map((r) => [r.noteTitle, r.reverted])).toEqual([["List", [2, 3]]]);
    expect([await text(ada, plan), await text(ada, list), await text(ada, untouched)]).toEqual(["# Plan\nada", "# List", "# Log\nmonday"]);

    // Asked twice, nothing more is recorded. Undone, Claude's changes stand and are reverted again as the same ones.
    expect((await perform(env.DB, ada, { type: "history.revert", changes: asked })).skipped.map((s) => s.why)).toEqual(["nothing", "nothing", "nothing"]);
    await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: plan, revisions: [5] }] });
    expect((await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: plan, author }] }))[0]!.revisions).toEqual([2, 4]);

    expect(await refusal(perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: plan, author, revisions: [2] }] }))).toContain("pass either revisions");
    expect(await refusal(perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: plan, author, to: 1 }] }))).toContain("pass either revisions");
  });

  it("picks for `author` what reverting the author picks, through random histories of edits, undos and reverts by two authors", async () => {
    for (let run = 0; run < 6; run++) {
      const ada = await newMember();
      const claude = await agentOf(ada);
      const author = { kind: "agent" as const, id: (claude.actor as Extract<Actor, { kind: "agent" }>).agentId };
      let seed = 7919 * (run + 1);
      const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
      const id = await noteOf(ada, "# Note\none\ntwo\nthree");
      for (let step = 0; step < 9; step++) {
        const actor = random(2) ? ada : claude.actor;
        const revision = await revisionOf(ada, id);
        const how = random(4);
        if (how === 0) await perform(env.DB, actor, { type: "note.undo", id }).catch(() => {});
        else if (how === 1) await perform(env.DB, actor, { type: "note.revertChanges", id, revisions: [1 + random(revision)] }).catch(() => {});
        else await write(actor, id, `${await text(ada, id)}\nline ${run}.${step}`);
      }
      const [picked] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, author }] });
      const single = await perform(env.DB, ada, { type: "note.previewRevert", id, author });
      expect([picked!.revisions, picked!.diff], `run ${run}`).toEqual([single.revisions, single.diff]);
      const twin = await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, author }] });
      const after = await text(ada, id);
      if (twin.reverted.length) {
        // Undone, then reverted by the operation agents use: the same text.
        await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [twin.reverted[0]!.revision] }] });
        await perform(env.DB, ada, { type: "history.revertAuthor", author, noteIds: [id] });
        expect(await text(ada, id), `run ${run}`).toBe(after);
      } else expect(single.revisions.length === 0 || single.diff.hunks.length === 0, `run ${run}`).toBe(true);
    }
  });
});

describe("the changes listed by who made them", () => {
  it("are people's alone or agents' alone when asked, in the list and in the summary's counts", async () => {
    const ada = await newMember();
    const claude = await agentOf(ada);
    const id = await noteOf(ada, "# Shared", "# Shared\nfrom Ada");
    await write(claude.actor, id, "# Shared\nfrom Ada\nfrom Claude");

    const agents = await perform(env.DB, ada, { type: "history.list", by: "agents", diffs: false });
    expect(agents.changes.map((c) => [c.revision, c.author.name])).toEqual([[3, "Claude"]]);
    const people = await perform(env.DB, ada, { type: "history.list", by: "people", diffs: false });
    expect(people.changes.map((c) => c.revision)).toEqual([2, 1]);
    expect((await perform(env.DB, ada, { type: "history.summary", by: "agents" })).notes).toMatchObject([{ noteId: id, changes: 1, added: 1 }]);
    expect((await perform(env.DB, ada, { type: "history.summary", by: "people" })).notes).toMatchObject([{ noteId: id, changes: 2, added: 2 }]);
  });
});

/** Raise to run more: 30,000 runs were checked once by hand. */
const FUZZ = 1500;

describe(`a selection reverted through ${FUZZ} random histories of edits and reverts`, () => {
  it("leaves the note true to its record whatever is picked, is exactly the note at a revision when everything after it is picked, changes nothing when nothing picked still stands, and is undone by reverting it", () => {
    let seed = 9;
    const random = (below: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 12) % below;
    const words = ["x", "y", "z", "a", "new", "e", "f", "c"];
    const failures: string[] = [];
    let [suffixes, withReverted, undone] = [0, 0, 0];
    for (let fuzz = 0; fuzz < FUZZ; fuzz++) {
      const history: Recorded[] = [];
      let note = "";
      const texts = [""];
      const log: string[] = [];
      const record = (changes: ChangeSet, reverts: Reverts | null, resolution: Recorded["resolution"] = null) => {
        history.push({ revision: history.length + 1, changes, reverts, resolution });
        note = applyChanges(changes, note);
        texts.push(note);
        log.push(reverts ? `R${JSON.stringify(reverts.revisions)}` : JSON.stringify(note));
      };
      const revert = (reverts: Reverts) => {
        const found = reverting(history, reverts, note);
        const { changes, resolution } = settledRevert(found, note, found.conflicts.map(() => "keep"));
        record(changes, reverts, resolution);
      };
      let n = 0;
      const line = () => `${words[random(words.length)]} ${words[random(words.length)]}${n++}`;
      for (let op = 0; op < 4 + random(7); op++) {
        const gone = revertedBy(history);
        const standing = history.filter((c) => !gone.has(c.revision)).map((c) => c.revision);
        if (random(4) < 3 || !standing.length) {
          const lines = note ? note.split("\n") : [];
          const how = random(4);
          if (how === 0 || !lines.length) lines.splice(random(lines.length + 1), 0, line());
          else if (how === 1) lines.splice(random(lines.length), 1);
          else if (how === 2) lines[random(lines.length)] += ` ${words[random(words.length)]}`;
          else lines.splice(random(lines.length + 1), 0, line(), line());
          const to = lines.join("\n");
          if (to !== note) record(changesBetween(note, to), null);
        } else revert({ how: "revert", revisions: [...new Set([standing[random(standing.length)]!, standing[random(standing.length)]!])].sort((a, b) => a - b) });
      }
      if (!history.length) continue;

      const suffix = random(3) === 0;
      const from = random(history.length);
      const picked = suffix ? history.slice(from).map((c) => c.revision) : history.filter(() => random(2)).map((c) => c.revision);
      const { revisions, already } = revertible(history, picked);
      const gone = revertedBy(history);
      const say = (what: string) => failures.length < 3 && failures.push(`${what}: ${log.join(" | ")} picked ${JSON.stringify(picked)}`);
      if (already.some((r) => !gone.has(r)) || revisions.length + already.length !== picked.length) say("the picked changes are not split in two");
      if (already.length) withReverted++;
      if (!revisions.length) continue;

      const before = note;
      revert({ how: "revert", revisions });
      if (applyChanges(takeBackOut(history, { how: "revert", revisions: [] }), note) !== note) say("not true to the record");
      if (suffix) {
        suffixes++;
        if (already.length) say("a change after the revision was left be");
        if (note !== texts[from]) say(`not the note at revision ${from}`);
      }
      if (history.at(-1)!.resolution === null) {
        undone++;
        revert({ how: "revert", revisions: [history.length] });
        if (note !== before) say("reverting the revert is not the note before it");
      }
    }
    expect(failures).toEqual([]);
    expect([suffixes > FUZZ / 6, withReverted > FUZZ / 20, undone > FUZZ / 3]).toEqual([true, true, true]);
  }, 120_000);
});

describe("selections across several notes, reverted and undone through the operations", () => {
  it("each note ends as its own record says through 12 random runs over three notes, a note changed under the preview is the only one skipped, and undo returns every note that has not moved on", async () => {
    let seed = 21;
    const random = (below: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 12) % below;
    for (let fuzz = 0; fuzz < 12; fuzz++) {
      const ada = await newMember();
      const ids = [await noteOf(ada, "a0"), await noteOf(ada, "b0"), await noteOf(ada, "c0")];
      let made = 0;
      for (let op = 0; op < 9; op++) {
        const id = ids[random(3)]!;
        const now = await perform(env.DB, ada, { type: "note.read", id });
        const history = await perform(env.DB, ada, { type: "note.history", id });
        const standing = history.filter((c) => c.revertedBy === null).map((c) => c.revision);
        if (random(4) === 0 && standing.length > 1) await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [standing[random(standing.length)]!] });
        else {
          const lines = now.text.split("\n");
          lines.splice(random(lines.length + 1), 0, `line ${made++}`);
          await perform(env.DB, ada, { type: "note.write", id, baseRevision: now.revision, text: lines.join("\n") });
        }
      }
      const changes = [];
      for (const noteId of ids) {
        const history = await perform(env.DB, ada, { type: "note.history", id: noteId });
        const revisions = history.filter((c) => c.revision > 1 && random(3) > 0).map((c) => c.revision);
        if (revisions.length) changes.push({ noteId, revisions });
      }
      if (!changes.length) continue;
      const previews = await perform(env.DB, ada, { type: "history.previewRevert", changes });
      const expected = new Map<string, string>();
      for (const preview of previews) {
        const now = await perform(env.DB, ada, { type: "note.read", id: preview.noteId });
        const lines = now.text.split("\n");
        // What the diff says, made to the text by hand: the preview and the revert must agree.
        for (const hunk of [...preview.diff.hunks].reverse()) {
          const put = hunk.lines.filter((l) => l.kind !== "del").map((l) => l.text);
          lines.splice(hunk.oldStart - 1, hunk.lines.filter((l) => l.kind !== "add").length, ...put);
        }
        expected.set(preview.noteId, preview.diff.hunks.length ? lines.join("\n") : now.text);
      }
      const moved = random(2) ? changes[random(changes.length)]!.noteId : null;
      if (moved) await write(ada, moved, `${await text(ada, moved)}\nunder the preview`);
      const before = new Map<string, string>();
      for (const id of ids) before.set(id, await text(ada, id));

      const done = await perform(env.DB, ada, { type: "history.revert", changes: changes.map((c, i) => ({ ...c, at: previews[i]!.revision })) });

      expect(done.skipped.filter((s) => s.why === "changed").map((s) => s.noteId)).toEqual(moved ? [moved] : []);
      for (const { noteId, revision } of done.reverted) {
        expect(await text(ada, noteId), `run ${fuzz}`).toBe(expected.get(noteId));
        expect(await revisionOf(ada, noteId)).toBe(revision);
      }
      for (const { noteId } of done.skipped) expect(await text(ada, noteId)).toBe(before.get(noteId));
      expect(done.reverted.length + done.skipped.length).toBe(changes.length);

      const edited = done.reverted.length > 1 ? done.reverted[0]!.noteId : null;
      if (edited) await write(ada, edited, `${await text(ada, edited)}\nafter the revert`);
      const undone = await perform(env.DB, ada, { type: "history.revert", changes: done.reverted.map((r) => ({ noteId: r.noteId, revisions: [r.revision], at: r.revision })) });
      expect(undone.skipped.map((s) => [s.noteId, s.why])).toEqual(edited ? [[edited, "changed"]] : []);
      for (const { noteId } of undone.reverted) expect(await text(ada, noteId), `run ${fuzz}, undo`).toBe(before.get(noteId));
    }
  }, 120_000);
});
