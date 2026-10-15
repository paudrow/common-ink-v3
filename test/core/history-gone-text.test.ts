import type { ChangeSet } from "@codemirror/state";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectAgent } from "../../src/core/agents.ts";
import { revertedBy, reverting, settledRevert, takeBackOut, type Choice, type Recorded } from "../../src/core/history.ts";
import { perform, type Actor } from "../../src/core/operations.ts";
import type { Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";
import { newMember } from "./members.ts";

/** A note stepped through `texts`, and what reverting `revisions` of it finds. */
function reverted(texts: string[], ...revisions: number[]) {
  const history: Recorded[] = texts.map((text, i) => ({ revision: i + 1, reverts: null, changes: changesBetween(texts[i - 1] ?? "", text) }));
  const now = texts.at(-1)!;
  const found = reverting(history, { how: "revert", revisions }, now);
  const settle = (choice: Choice) => applyChanges(settledRevert(found, now, found.conflicts.map(() => choice)).changes, now);
  return { kept: settle("keep"), back: settle("back"), conflicts: found.conflicts, overlaps: found.overlaps, recorded: applyChanges(takeBackOut(history, { how: "revert", revisions }), now) };
}

const todo = (box: string, day: number) => `- [${box}] Feed the cat every:day due:2026-10-${day}`;
const chores = (...lines: string[]) => ["# Chores", ...lines, "last"].join("\n");

describe("reverting a change to words of a line that a later change put back by hand", () => {
  it("leaves the line as it is, where it wrote 2026-10-133 before", () => {
    const found = reverted([chores(todo(" ", 13)), chores(todo(" ", 14)), chores(todo(" ", 13))], 2);
    expect(found).toMatchObject({ kept: chores(todo(" ", 13)), recorded: chores(todo(" ", 13)), back: chores(todo(" ", 13)), conflicts: [], overlaps: [3] });
  });

  it("leaves a word or a line that was taken out and written again by hand there once", () => {
    expect(reverted(["a milk b", "a b", "a milk b"], 2)).toMatchObject({ kept: "a milk b", back: "a milk b" });
    expect(reverted(["one  two", "one two", "one  two"], 2)).toMatchObject({ kept: "one  two", back: "one  two" });
    expect(reverted(["a\nL\nz", "a\nz", "a\nL\nz"], 2)).toMatchObject({ kept: "a\nL\nz", back: "a\nL\nz" });
    expect(reverted(["a\nL\nz", "a\nz", "a\nN\nz"], 2).kept).toBe("a\nL\nN\nz");
  });

  it("leaves it as it is with two changes to the line reverted together, and with one of the two", () => {
    const texts = [chores(todo(" ", 13)), chores(todo(" ", 14)), chores(todo("x", 14)), chores(todo(" ", 13))];
    expect(reverted(texts, 2, 3)).toMatchObject({ kept: texts[3], back: texts[3], conflicts: [] });
    expect(reverted(texts, 2)).toMatchObject({ kept: texts[3], back: texts[3] });
    expect(reverted(texts, 3)).toMatchObject({ kept: texts[3], back: chores(todo(" ", 14)) });
  });

  it("leaves the line as it is where the later change wrote the word again or part of it, and going back returns the line as it was", () => {
    expect(reverted(["buy milk now", "buy bread now", "buy eggs now"], 2)).toMatchObject({ kept: "buy eggs now", back: "buy milk now" });
    expect(reverted(["due:2026-10-13", "due:2026-10-14", "due:2026-10-24"], 2)).toMatchObject({ kept: "due:2026-10-24", back: "due:2026-10-13" });
    expect(reverted(["buy milk", "buy oat milk", "buy oats milk"], 2)).toMatchObject({ kept: "buy oats milk", back: "buy milk" });
    expect(reverted(["- [ ] call due:2026-10-13", "- [x] call due:2026-10-14", "- [x] call due:2026-10-20"], 2)).toMatchObject({ kept: "- [x] call due:2026-10-20", back: "- [ ] call due:2026-10-13" });
  });

  it("still returns the words it changed on a line whose other words a later change edited", () => {
    expect(reverted(["one\ntwo words here\nthree", "one\ntwo WORDS here\nthree", "one\ntwo WORDS here, and more\nthree"], 2).kept).toBe("one\ntwo words here, and more\nthree");
    expect(reverted(["buy oat milk", "buy milk", "buy bread"], 2).kept).toBe("buy oat bread");
    expect(reverted(["buy milk", "buy oat milk", "buy oat soy milk"], 2).kept).toBe("buy soy milk");
  });
});

describe("reverting a change to words of a line that a later change removed or rewrote", () => {
  it("leaves the line out, where it wrote a 3 on a line of its own before, and going back returns the line", () => {
    const texts = [chores(todo(" ", 13)), chores(todo(" ", 14)), chores()];
    const found = reverted(texts, 2);
    expect(found).toMatchObject({ kept: chores(), recorded: chores(), back: texts[0], overlaps: [3] });
    expect(found.conflicts).toEqual([{ line: 2, before: [todo(" ", 13)], now: [], kept: [], later: [3] }]);
  });

  it("leaves it out when it was the note's last line, and when two changes to it are reverted together", () => {
    expect(reverted(["a\n- [ ] x due:2026-10-13", "a\n- [ ] x due:2026-10-14", "a"], 2)).toMatchObject({ kept: "a", back: "a\n- [ ] x due:2026-10-13" });
    expect(reverted([chores(todo(" ", 13)), chores(todo(" ", 14)), chores(todo("x", 14)), chores()], 2, 3)).toMatchObject({ kept: chores(), back: chores(todo(" ", 13)) });
    expect(reverted(["a\nb\nc", "a\nB\nc", "a\nc"], 2)).toMatchObject({ kept: "a\nc", back: "a\nb\nc" });
  });

  it("leaves a line rewritten since, or replaced by other lines, as it is", () => {
    expect(reverted(["a\nbuy milk now\nz", "a\nbuy bread now\nz", "a\ncompletely different words here\nz"], 2)).toMatchObject({ kept: "a\ncompletely different words here\nz", back: "a\nbuy milk now\nz" });
    expect(reverted(["a\nbuy milk now\nz", "a\nbuy bread now\nz", "a\nfoo\nbar\nz"], 2)).toMatchObject({ kept: "a\nfoo\nbar\nz", back: "a\nbuy milk now\nz" });
    expect(reverted(["a\nbuy oat milk\nz", "a\nbuy milk\nz", "a\nz"], 2)).toMatchObject({ kept: "a\nz", back: "a\nbuy oat milk\nz" });
  });
});

describe("reverting a change that added lines a later change edited", () => {
  it("leaves the edited line whole and takes out the others, where it left the later words on a line of their own before", () => {
    expect(reverted(["a\nc", "a\nx\nc", "a\nx!\nc"], 2)).toMatchObject({ kept: "a\nx!\nc", back: "a\nc" });
    expect(reverted(["a\nz", "a\nbuy milk\nz", "a\n- buy milk\nz"], 2)).toMatchObject({ kept: "a\n- buy milk\nz", back: "a\nz" });
    expect(reverted(["a\nz", "a\np\nq\nr\nz", "a\np\nq, edited\nr\nz"], 2)).toMatchObject({ kept: "a\nq, edited\nz", back: "a\nz" });
    expect(reverted(["a\nz", "a\np\nq\nr\nz", "a\np\nnew\nq\nr\nz"], 2)).toMatchObject({ kept: "a\nnew\nz", conflicts: [] });
  });

  it("returns a line it removed between lines that were removed or edited since", () => {
    expect(reverted(["a\nX\nL\nY\nz", "a\nX\nY\nz", "a\nz"], 2).kept).toBe("a\nL\nz");
    expect(reverted(["a\nX\nL\nY\nz", "a\nX\nY\nz", "a\nX more\nY\nz"], 2).kept).toBe("a\nX more\nL\nY\nz");
  });
});

describe("reverting a change next to what a later change wrote", () => {
  const kept = (texts: string[], ...revisions: number[]) => reverted(texts, ...revisions).kept;

  it("leaves the line as it is where the two would run words together or leave one in two", () => {
    expect(kept(["todo: milk.", "todo: .", "todo: eggs."], 2)).toBe("todo: eggs.");
    expect(kept(["due 13", "due: 13", "due:2026 13"], 2)).toBe("due:2026 13");
    expect(kept(["10 20", "10, 20", "10,5 20"], 2)).toBe("10,5 20");
    expect(kept(["ab", "a-b", "a-xb"], 2)).toBe("a-xb");
    expect(kept(["red apple pie", "red banana pie", "redbanana pie"], 2)).toBe("redbanana pie");
    expect(kept(["1. id0", " id0", "## id0"], 2)).toBe("## id0");
    expect(kept(["n0, one 13 n1", "n0s,- one 13 n1 n2", "n0s,s-s one 13 n1 n2"], 2)).toBe("n0s,s-s one 13 n1 n2");
    expect(kept(["n0 y n1", "n0  -n1", "n0 -n2"], 2)).toBe("n0 -n2");
    expect(kept(["14.one", "14.sone", "14.sone\n14.sone", "14.sonen0 "], 2)).toBe("14.sonen0 ");
    expect(kept(["x-x 13", "x-ssx 13\nx-ssx 13", "x-ssx 13\nx-ssx13", "x-ssx13\nn0 x-ssx 13"], 2)).toBe("x-ssx13\nn0 x-ssx 13");
    expect(kept(["\n14", "- n0\n14", "- n0n1  14"], 2)).toBe("- n0n1  14");
  });

  it("reads a word by its letters with their marks, and by whole characters", () => {
    expect(kept(["pa\u0301te", "pe\u0301te", "pe\u0301re"], 2)).toBe("pe\u0301re");
    expect(kept(["\u{1D400}\u{1D401}\u{1D402} x", "\u{1D400}\u{1D403}\u{1D402} x", "\u{1D400}\u{1D403}\u{1D404} x"], 2)).toBe("\u{1D400}\u{1D403}\u{1D404} x");
  });

  it("puts words back on the line they were on when a later change added a line above it", () => {
    expect(kept(["a\n- Y", "a\nY", "a\nN\nY"], 2)).toBe("a\nN\n- Y");
    expect(kept(["# Title\nbody", "Title\nbody", "intro\nTitle\nbody"], 2)).toBe("intro\n# Title\nbody");
    expect(kept(["wait, what now", "wait now", "waits now"], 2)).toBe("waits now");
  });

  it("returns whole lines where the change replaced lines by another number of them, and leaves whole the ones a later change edited", () => {
    expect(reverted(["title", "\ntitle!", "intro\ntitle!"], 2)).toMatchObject({ kept: "title\nintro", back: "title" });
    expect(reverted(["one\ntwo", "one\n\nTWO", "one\nmid\nTWO"], 2)).toMatchObject({ kept: "one\ntwo\nmid", back: "one\ntwo" });
    expect(reverted(["a b c\nz", "a c", "a c!"], 2)).toMatchObject({ kept: "a b c\nz\na c!", back: "a b c\nz" });
    expect(reverted(["a\nb", "a\nB\nc", "a\nB\nc!"], 2)).toMatchObject({ kept: "a\nb\nc!", back: "a\nb" });
    expect(kept(["old a b", "a b\nadded", "a b\nmid\nadded"], 2)).toBe("old a b\nmid");
    expect(kept(["one two", "one\ntwo", "one\nmid\ntwo"], 2)).toBe("one two\nmid");
    expect(kept(["a\nb", "a\nB", "a\nB!\nc"], 2)).toBe("a\nb!\nc");
  });
});

describe("an agent's change to a todo's date, reverted after its line was put back or deleted", () => {
  const before = chores(todo(" ", 13));
  async function completed(then: string) {
    const ada = await newMember();
    const { agent } = await connectAgent(env.DB, ada.personId, "Claude", {});
    const claude: Actor = { kind: "agent", agentId: agent.id, personId: ada.personId, workspaceId: ada.workspaceId, scope: {} };
    const { id } = await perform(env.DB, ada, { type: "note.create", text: before });
    await perform(env.DB, claude, { type: "note.write", id, baseRevision: 1, text: chores(todo(" ", 14)) });
    await perform(env.DB, ada, { type: "note.write", id, baseRevision: 2, text: then });
    return { ada, id };
  }
  const read = async (actor: Actor, id: string) => (await perform(env.DB, actor, { type: "note.read", id })).text;
  const added = (diff: { hunks: Array<{ lines: Array<{ kind: string; text: string }> }> }) => diff.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));

  it("previews no line added and writes none: through history.revert and through note.revertChanges", async () => {
    for (const then of [before, chores()]) {
      for (const how of ["history.revert", "note.revertChanges"] as const) {
        const { ada, id } = await completed(then);
        const [preview] = await perform(env.DB, ada, { type: "history.previewRevert", changes: [{ noteId: id, revisions: [2] }] });
        expect(added(preview!.diff)).toEqual([]);
        expect(added((await perform(env.DB, ada, { type: "note.previewRevert", id, revisions: [2] })).diff)).toEqual([]);
        if (how === "history.revert") await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [2], at: 3 }] });
        else await perform(env.DB, ada, { type: "note.revertChanges", id, revisions: [2] });
        expect(await read(ada, id)).toBe(then);
      }
    }
  });

  it("returns the deleted line as it was before the agent's change when the revert goes back", async () => {
    const { ada, id } = await completed(chores());
    await perform(env.DB, ada, { type: "history.revert", changes: [{ noteId: id, revisions: [2], at: 3, choices: "back" }] });
    expect(await read(ada, id)).toBe(before);
  });
});

/** Raise to run more: 40,000 histories for each way of settling were checked by hand. */
const HISTORIES = 1500;

/** A todo as the random histories write it: its words are its box, its name, its date and a note. `place` is the line it is, whatever it is renamed to. */
interface Todo {
  place: number;
  name: number;
  box: " " | "x";
  day: number;
  note: string | null;
}
type Word = "name" | "box" | "day" | "note";
const WORDS: Word[] = ["name", "box", "day", "note"];
const LINE = /^- \[([ x])\] task(\d+) due:2026-10-(\d\d)((?: note\d+)*)$/;
const NOTES = ["note1", "note2", "note3"];
const say = (t: Todo) => `- [${t.box}] task${t.name} due:2026-10-${t.day}${t.note ? ` ${t.note}` : ""}`;

describe(`through ${HISTORIES} random histories of todos edited by the word, put back by hand, renamed and deleted, with earlier changes reverted`, () => {
  for (const mode of ["keep", "back"] as const)
    it(`every line a revert leaves is a todo whole, with no word that was never written, and reverting changes whose words were written again or whose lines are gone changes nothing: with every conflict settled by ${mode === "back" ? "going back" : "keeping the later edits"}`, () => {
      let seed = mode === "keep" ? 17 : 23;
      const random = (below: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 12) % below;
      const failures: string[] = [];
      let [reverts, displaced, exact, twice] = [0, 0, 0, 0];
      for (let run = 0; run < HISTORIES; run++) {
        const history: Recorded[] = [];
        let text = "";
        const texts = [""];
        const log: string[] = [];
        const placeOf = new Map<number, number>();
        /** For each change that edited words of one line: the line, and the words it wrote. */
        const worded = new Map<number, { place: number; words: Word[] }>();
        /** The revisions of the edits that wrote a word of a line again, or took the line out. */
        const wrote = new Map<string, number[]>();
        const fail = (what: string) => failures.length < 5 && failures.push(`run ${run} (${mode}): ${what}\n  ${log.join(" | ")}`);
        const read = (line: string) => {
          const m = LINE.exec(line);
          return m && { box: m[1] as Todo["box"], name: Number(m[2]), day: Number(m[3]), notes: m[4]!.trim() ? m[4]!.trim().split(" ") : [] };
        };
        const record = (changes: ChangeSet, reverted: Reverts | null, resolution: Recorded["resolution"] = null) => {
          history.push({ revision: history.length + 1, changes, reverts: reverted, resolution });
          text = applyChanges(changes, text);
          texts.push(text);
          log.push(reverted ? `R${JSON.stringify(reverted.revisions)} ${JSON.stringify(text)}` : JSON.stringify(text));
        };
        const todosOf = (of: string): Todo[] => (of ? of.split("\n") : []).map((line) => {
          const t = read(line)!;
          return { place: placeOf.get(t.name)!, name: t.name, box: t.box, day: t.day, note: t.notes.join(" ") || null };
        });
        const edit = (todos: Todo[]) => {
          for (const t of todos) placeOf.set(t.name, t.place);
          record(changesBetween(text, todos.map(say).join("\n")), null);
        };
        /** Says what is wrong with a text a revert left, or nothing. */
        const junk = (after: string): string | null => {
          for (const line of after ? after.split("\n") : []) {
            const t = read(line);
            if (!t) return `the line ${JSON.stringify(line)} is no todo`;
            if (!placeOf.has(t.name) || !t.notes.every((n) => NOTES.includes(n))) return `the line ${JSON.stringify(line)} has a word no todo had`;
          }
          return null;
        };

        let made = 0;
        const fresh = (place = made): Todo => ({ place, name: made++, box: " ", day: 10 + random(19), note: null });
        edit(Array.from({ length: 2 + random(3) }, () => fresh()));
        let sinceRevert = 1;
        for (let op = 0; op < 4 + random(8); op++) {
          const todos = todosOf(text);
          // Going back can return a line that a revert before it returned already; the todos are then not told apart by name.
          if (new Set(todos.map((t) => t.name)).size < todos.length) {
            twice++;
            break;
          }
          const gone = revertedBy(history);
          const standing = history.filter((c) => !c.reverts && !gone.has(c.revision) && c.revision > 1).map((c) => c.revision);
          if (random(10) < 7 || !standing.length) {
            const how = todos.length ? [0, 1, 1, 2, 2, 2, 3, 4, 4, 5, 6, 7, 8, 9][random(14)]! : 0;
            const at = random(Math.max(todos.length, 1));
            const target = todos[at]!;
            const revision = history.length + 1;
            const writes = (to: Todo | null) => {
              if (to) todos[at] = to;
              else todos.splice(at, 1);
              const words = to ? WORDS.filter((w) => to[w] !== target[w]) : [];
              for (const key of to ? words.map((w) => `${target.place}:${w}`) : [`${target.place}:gone`]) wrote.set(key, [...(wrote.get(key) ?? []), revision]);
              if (to) worded.set(revision, { place: target.place, words });
            };
            if (how === 0) todos.splice(random(todos.length + 1), 0, fresh());
            else if (how === 1) writes(null);
            else if (how === 2) {
              // Put back by hand as it was at an earlier revision, or renamed when it was the same then.
              const was = todosOf(texts[1 + random(history.length)]!).find((t) => t.place === target.place);
              writes(was && WORDS.some((w) => was[w] !== target[w]) ? was : fresh(target.place));
            } else if (how === 3) writes({ ...target, box: target.box === "x" ? " " : "x", day: 10 + ((target.day - 9) % 19) });
            else if (how < 6) writes({ ...target, day: 10 + ((target.day - 10 + 1 + random(18)) % 19) });
            else if (how < 8) writes({ ...target, box: target.box === "x" ? " " : "x" });
            else writes({ ...target, note: target.note && random(3) === 0 ? null : NOTES.filter((n) => n !== target.note)[random(2)]! });
            edit(todos);
            continue;
          }
          // A word the change wrote was written again by a later change that stands, or its line was taken out by one.
          const since = (place: number, word: string, after: number, picked: number[]) => (wrote.get(`${place}:${word}`) ?? []).some((r) => r > after && !picked.includes(r) && !gone.has(r));
          const isGone = (r: number, picked: number[]) => {
            const did = worded.get(r);
            if (!did) return false;
            const was = todosOf(texts[r]!).find((t) => t.place === did.place)!;
            // A note taken out wrote nothing that could be written again.
            return since(did.place, "gone", r, picked) || did.words.some((w) => (w !== "note" || was.note !== null) && since(did.place, w, r, picked));
          };
          const among = random(2) ? standing.filter((r) => isGone(r, [r])) : [];
          const from = among.length ? among : standing;
          const picked = [...new Set([from[random(from.length)]!, ...(random(3) === 0 ? [from[random(from.length)]!] : [])])].sort((a, b) => a - b);
          const reverted: Reverts = { how: "revert", revisions: picked };
          const found = reverting(history, reverted, text);
          const kept = applyChanges(found.changes, text);
          reverts++;
          if (kept !== applyChanges(takeBackOut(history, reverted), text)) fail(`reverting ${picked} is not what is recorded for it`);
          const wrong = junk(kept) ?? junk(applyChanges(settledRevert(found, text, found.conflicts.map(() => "back")).changes, text));
          if (wrong) fail(`reverting ${picked} in ${JSON.stringify(text)}: ${wrong}`);

          if (picked.every((r) => isGone(r, picked))) {
            displaced++;
            // With no revert since the first of them, the record is the edits alone and the answer is exact. Two changes to one line count as what the two did together, which may be nothing to a word both wrote.
            if (picked[0]! >= sinceRevert && new Set(picked.map((r) => worded.get(r)!.place)).size === picked.length) {
              exact++;
              if (kept !== text) fail(`reverting ${picked} in ${JSON.stringify(text)} changed it to ${JSON.stringify(kept)}`);
            }
          }

          const before = text;
          const { changes, resolution } = settledRevert(found, text, found.conflicts.map(() => mode));
          record(changes, reverted, resolution);
          sinceRevert = history.length + 1;
          if (applyChanges(takeBackOut(history, { how: "revert", revisions: [] }), text) !== text) fail("the record replayed is not the note's text");
          const to = random(history.length);
          if (applyChanges(takeBackOut(history, { how: "revert", revisions: history.slice(to).map((c) => c.revision), to }), text) !== texts[to]) fail(`going back to ${to} gives another text`);
          if (applyChanges(takeBackOut(history, { how: "revert", revisions: [history.length] }), text) !== before) fail("the revert reverted is not the note as it was");
        }
      }
      expect(failures.join("\n")).toBe("");
      expect(reverts).toBeGreaterThan(HISTORIES);
      expect(displaced).toBeGreaterThan(HISTORIES / 6);
      expect(exact).toBeGreaterThan(HISTORIES / 10);
      console.log(`${mode}: ${HISTORIES} histories, ${reverts} reverts, ${displaced} of changes whose words were written again or whose line was taken out since, ${exact} of those with no revert in between; ${twice} histories ended at a todo there twice`);
    }, 900_000);
});
