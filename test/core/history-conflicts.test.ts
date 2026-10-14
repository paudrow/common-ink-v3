import type { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { linesAsOf, resolved, revertedBy, reverting, settledRevert, takeBackOut, type Choice, type Recorded } from "../../src/core/history.ts";
import type { Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";

/** A note as the operations keep it: its text, and its changes with what each took back out. */
function note() {
  const history: Recorded[] = [];
  let text = "";
  const record = (changes: ChangeSet, reverts: Reverts | null, resolution: Recorded["resolution"] = null) => {
    history.push({ revision: history.length + 1, changes, reverts, resolution });
    text = applyChanges(changes, text);
    return history.length;
  };
  const reverts = (revisions: number[]): Reverts => ({ how: "revert", revisions });
  return {
    history,
    text: () => text,
    edit: (to: string) => record(changesBetween(text, to), null),
    preview: (revisions: number[]) => reverting(history, reverts(revisions), text),
    /** Reverts with each conflict settled as chosen, or every later edit kept. */
    revert(revisions: number[], choices?: Choice[] | "keep" | "back") {
      const found = reverting(history, reverts(revisions), text);
      const each = Array.isArray(choices) ? choices : found.conflicts.map(() => choices ?? "keep");
      const { changes, resolution } = settledRevert(found, text, each);
      return record(changes, reverts(revisions), resolution);
    },
    backTo: (to: number) => applyChanges(takeBackOut(history, { how: "revert", revisions: history.slice(to).map((c) => c.revision), to }), text),
  };
}

function made(...texts: string[]) {
  const n = note();
  for (const text of texts) n.edit(text);
  return n;
}

describe("the conflicts of a revert", () => {
  it("are none when no later change edited the lines it changes", () => {
    const n = made("a\nb\nc", "a\nB\nc", "a\nB\nc\nd");
    expect(n.preview([2])).toMatchObject({ overlaps: [], conflicts: [] });
  });

  it("are each place a later change edited a line the revert changes, with the line as it was before, as it is now, and as keeping the later edit leaves it", () => {
    const n = made("one\ntwo words here\nthree", "one\ntwo WORDS here\nthree", "one\ntwo WORDS here, and more\nthree");
    expect(n.preview([2])).toMatchObject({
      overlaps: [3],
      conflicts: [{ line: 2, before: ["two words here"], now: ["two WORDS here, and more"], kept: ["two words here, and more"], later: [3] }],
    });
  });

  it("leave out what a later change did to other lines, which stays whichever way its conflict is settled", () => {
    const n = made("a\nb\nc\nd", "a\nB\nc\nd", "a\nB!\nc\nD");
    const { conflicts } = n.preview([2]);
    expect(conflicts).toEqual([{ line: 2, before: ["b"], now: ["B!"], kept: ["b!"], later: [3] }]);
    n.revert([2], "back");
    expect(n.text()).toBe("a\nb\nc\nD");
  });

  it("show a line the later change added right under the line it edited as part of the conflict, since the two are one edit: nothing is dropped unseen", () => {
    const n = made("a\nb", "a\nB", "a\nB!\nc");
    expect(n.preview([2]).conflicts).toEqual([{ line: 2, before: ["b"], now: ["B!", "c"], kept: ["b!", "c"], later: [3] }]);

    const apart = made("a\nb\nz", "a\nB\nz", "a\nB!\nz\nc");
    expect(apart.preview([2]).conflicts).toEqual([{ line: 2, before: ["b"], now: ["B!"], kept: ["b!"], later: [3] }]);
    apart.revert([2], "back");
    expect(apart.text()).toBe("a\nb\nz\nc");
  });

  it("name for each place the later changes that edited it", () => {
    const n = made("a\nb\nc\nd", "a\nB\nc\nD", "a\nB!\nc\nD", "a\nB!\nc\nD?");
    expect(n.preview([2]).conflicts.map((c) => [c.line, c.later])).toEqual([
      [2, [3]],
      [4, [4]],
    ]);
  });

  it("are found at the start and at the end of a note, and where the later change removed the line", () => {
    const n = made("first\nmiddle\nlast", "FIRST\nmiddle\nLAST", "FIRST one\nmiddle\nLAST one");
    expect(n.preview([2]).conflicts.map((c) => [c.line, c.before, c.now])).toEqual([
      [1, ["first"], ["FIRST one"]],
      [3, ["last"], ["LAST one"]],
    ]);

    const gone = made("a\nb c d\ne", "a\nb C d\ne", "a\ne");
    const [conflict] = gone.preview([2]).conflicts;
    expect(conflict).toMatchObject({ before: ["b c d"], now: [], later: [3] });
    gone.revert([2], "back");
    expect(gone.text()).toBe("a\nb c d\ne");
  });

  it("are found where the reverted change added the lines a later change edited: going back takes the lines out", () => {
    const n = made("a\nz", "a\nnew line\nz", "a\nnew line, edited\nz");
    const [conflict] = n.preview([2]).conflicts;
    expect(conflict).toMatchObject({ before: [], now: ["new line, edited"], later: [3] });
    n.revert([2], "back");
    expect(n.text()).toBe("a\nz");
  });
});

describe("a revert with its conflicts settled", () => {
  const start = ["one\ntwo words here\nthree\nfour is here", "one\ntwo WORDS here\nthree\nfour IS here", "one\ntwo WORDS here, and more\nthree\nfour IS here too"];

  it("is today's revert when every later edit is kept", () => {
    const [n, plain] = [made(...start), made(...start)];
    n.revert([2], "keep");
    plain.history.push({ revision: 4, changes: takeBackOut(plain.history, { how: "revert", revisions: [2] }), reverts: { how: "revert", revisions: [2] } });
    expect(n.text()).toBe("one\ntwo words here, and more\nthree\nfour is here too");
    expect(n.history[3]).toEqual({ ...plain.history[3], resolution: null });
  });

  it("returns each line to how it was before, the later edits to it dropped, where that is chosen", () => {
    const n = made(...start);
    n.revert([2], "back");
    expect(n.text()).toBe("one\ntwo words here\nthree\nfour is here");
  });

  it("takes a choice for each conflict, and lines typed by hand: none, one, or several, each line end typed being one", () => {
    const n = made(...start);
    n.revert([2], ["back", { text: "four, by hand\nand a fifth" }]);
    expect(n.text()).toBe("one\ntwo words here\nthree\nfour, by hand\nand a fifth");

    const none = made(...start);
    none.revert([2], [{ text: "" }, "keep"]);
    expect(none.text()).toBe("one\nthree\nfour is here too");

    const blank = made(...start);
    blank.revert([2], [{ text: "\n" }, { text: "four\n" }]);
    expect(blank.text()).toBe("one\n\n\nthree\nfour\n");
  });

  it("settles the conflicts of several changes reverted at once", () => {
    const n = made("a\nb\nc", "a\nB\nc", "a\nB\nC", "a\nB!\nC!");
    expect(n.preview([2, 3]).conflicts.map((c) => [c.line, c.before, c.now])).toEqual([[2, ["b", "c"], ["B!", "C!"]]]);
    n.revert([2, 3], "back");
    expect(n.text()).toBe("a\nb\nc");
  });

  it("keeps what was chosen through the reverts, undos and returns that come after", () => {
    const n = made(...start);
    const texts = ["", ...start];
    texts.push((n.revert([2], ["back", { text: "four, by hand" }]), n.text()));
    expect(n.text()).toBe("one\ntwo words here\nthree\nfour, by hand");

    // A later edit elsewhere, then taken out: the hand-typed line is still there.
    texts.push((n.edit(`zero\n${n.text()}`), n.text()));
    n.revert([5]);
    expect(n.text()).toBe(texts[4]);
    texts.push(n.text());
    for (const to of [6, 5, 4, 3, 2, 1, 0]) expect(n.backTo(to), `back to ${to}`).toBe(texts[to]);

    // The revert itself reverted: the change it took out stands again, and what was chosen with it is gone.
    n.revert([4]);
    expect(n.text()).toBe(start[2]);
  });

  it("is the text asked for whatever the choices leave of the note: nothing, or a note that ends in a line end", () => {
    const n = made("a", "A", "A!");
    n.revert([2], [{ text: "" }]);
    expect(n.text()).toBe("");

    const ended = made("a\n", "A\n", "A!\n");
    ended.revert([2], "back");
    expect(ended.text()).toBe("a\n");
  });

  it("puts the lines chosen where the conflict is", () => {
    const kept = "a\nb!\nc";
    const conflicts = [{ line: 2, before: ["b"], now: ["B!"], kept: ["b!"], later: [3] }];
    expect(resolved(kept, conflicts, ["keep"])).toBe(kept);
    expect(resolved(kept, conflicts, ["back"])).toBe("a\nb\nc");
    expect(resolved(kept, conflicts, [{ text: "x\ny" }])).toBe("a\nx\ny\nc");
  });
});

/** Raise to run more: 30,000 runs were checked once by hand. */
const RUNS = 600;

describe(`through ${RUNS} random runs of two authors adding, editing and removing their own lines, then one change reverted`, () => {
  it("keeping the later edits is the revert as it was, and going back leaves the line as it was before with every later edit to it out, and every other line alone", () => {
    let seed = 11;
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
    const things = ["buy milk", "buy eggs", "call bank", "call mum", "book flights", "water plants"];
    const authors = ["ada", "claude"];
    let conflicted = 0;
    for (let run = 0; run < RUNS; run++) {
      const n = note();
      let count = 0;
      const line = (owner: string) => ({ owner, text: `- [ ] ${things[random(things.length)]} ${count++}` });
      let lines = [line("ada"), line("claude"), line("ada")];
      const say = (list: typeof lines) => list.map((l) => l.text).join("\n");
      n.edit(say(lines));
      /** For each change, the line it touched and that line's text before and after; null where there was none. */
      const did: Array<{ revision: number; before: string | null; after: string | null }> = [];
      for (let op = 0; op < 3 + random(8); op++) {
        const author = authors[random(2)]!;
        const mine = lines.filter((l) => l.owner === author);
        const kind = mine.length ? random(3) : 0;
        const next = [...lines];
        let before: string | null = null;
        let after: string | null = null;
        if (kind === 0) {
          const added = line(author);
          next.splice(random(lines.length + 1), 0, added);
          after = added.text;
        } else {
          const target = mine[random(mine.length)]!;
          before = target.text;
          if (kind === 1) next.splice(next.indexOf(target), 1);
          else next[next.indexOf(target)] = { owner: author, text: (after = random(2) ? target.text.replace("[ ]", "[x]").replace(/ \d+$/, (m) => `${m} !`) : `${target.text} soon`) };
        }
        lines = next;
        did.push({ revision: n.edit(say(lines)), before, after });
      }
      const taken = did[random(did.length)]!;
      const where = `run ${run}, reverting ${JSON.stringify(taken)} in ${JSON.stringify(say(lines))}`;

      /** What the line the reverted change made became since. */
      const became = new Set<string>();
      for (let text = taken.after, d; text !== null && (became.add(text), (d = did.find((d) => d.revision > taken.revision && d.before === text))); text = d.after);
      const builtOn = became.size > 1 || (taken.after !== null && !lines.some((l) => l.text === taken.after));

      const plain = applyChanges(takeBackOut(n.history, { how: "revert", revisions: [taken.revision] }), n.text());
      const found = n.preview([taken.revision]);
      expect(applyChanges(found.changes, n.text()), where).toBe(plain);
      expect(resolved(plain, found.conflicts, found.conflicts.map(() => "keep")), where).toBe(plain);
      for (const c of found.conflicts) expect(found.overlaps, where).toEqual(expect.arrayContaining(c.later));
      if (!builtOn) expect(found.conflicts, where).toEqual([]);
      else conflicted++;

      const texts = ["", ...n.history.map((_, i) => n.backTo(i + 1))];
      const revert = n.revert([taken.revision], "back");
      const result = n.text() === "" ? [] : n.text().split("\n");
      expect(result.filter((text) => text !== taken.before), where).toEqual(lines.map((l) => l.text).filter((text) => !became.has(text)));
      expect(result.filter((text) => text === taken.before), where).toHaveLength(taken.before === null ? 0 : 1);

      // What was chosen stands like an edit: a change made after it and taken out again leaves it.
      const settled = n.text();
      n.edit(`${settled}\nlater`);
      n.revert([n.history.length]);
      expect(n.text(), `${where}, an edit after it reverted`).toBe(settled);
      texts.push(settled, `${settled}\nlater`);

      // The record still gives every earlier text, and the revert reverted gives the note as it was.
      const to = random(n.history.length);
      expect(n.backTo(to), `${where}, back to ${to}`).toBe(texts[to]);
      n.revert([revert]);
      expect(n.text(), `${where}, the revert reverted`).toBe(say(lines));
    }
    expect(conflicted).toBeGreaterThan(RUNS / 10);
  }, 60_000);
});

/** Raise to run more: 30,000 runs of each were checked once by hand. */
const FUZZ = 2000;

describe(`the record through ${FUZZ} random runs of lines added, removed, rewritten and edited by the word, and changes reverted one, two and back to a revision at a time: replayed it is the note's text, and it gives the text of every earlier revision`, () => {
  for (const mode of ["keep", "back", "hand"] as const)
    it(`holds with every conflict settled by ${mode === "hand" ? "lines typed by hand" : mode === "back" ? "going back" : "keeping the later edits"}`, () => {
      let seed = 5;
      const random = (below: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 12) % below;
      const words = ["x", "y", "z", "a", "new", "e", "f", "c"];
      let bad = 0;
      const firsts: string[] = [];
      for (let run = 0; run < FUZZ; run++) {
        const history: Recorded[] = [];
        let text = "";
        const log: string[] = [];
        const texts = [""];
        const record = (changes: ChangeSet, reverts: Reverts | null, resolution: Recorded["resolution"] = null) => {
          history.push({ revision: history.length + 1, changes, reverts, resolution });
          text = applyChanges(changes, text);
          log.push(reverts ? `R${JSON.stringify(reverts.revisions)}` : JSON.stringify(text));
        };
        let n = 0;
        const line = () => Array.from({ length: 1 + random(3) }, () => words[random(words.length)]).join(" ") + n++;
        let ok = true;
        for (let op = 0; op < 10 && ok; op++) {
          const kind = random(4);
          if (kind < 3 || history.length < 2) {
            const lines = text ? text.split("\n") : [];
            const how = random(6);
            if (how === 4) lines.splice(0, lines.length, line());
            else if (how === 5) lines.splice(0, lines.length);
            else
            if (how === 0 || (!lines.length && how < 4)) lines.splice(random(lines.length + 1), 0, line());
            else if (how === 1) lines.splice(random(lines.length), 1);
            else if (how === 2) { const i = random(lines.length); lines[i] = lines[i]!.toUpperCase() === lines[i] ? `${lines[i]}!` : lines[i]!.toUpperCase(); }
            else { const i = random(lines.length); lines[i] = `${lines[i]} ${words[random(words.length)]}`; }
            record(changesBetween(text, lines.join("\n")), null);
          } else {
            const gone = revertedBy(history);
            const standing = history.filter((c) => !gone.has(c.revision)).map((c) => c.revision);
            if (!standing.length) continue;
            const to = random(history.length);
            const reverts: Reverts = random(5) === 0 ? { how: "revert", revisions: history.slice(to).map((c) => c.revision), to } : { how: "revert", revisions: [...new Set([standing[random(standing.length)]!, standing[random(standing.length)]!])].sort((a, b) => a - b) };
            const found = reverting(history, reverts, text);
            const choices: Choice[] = found.conflicts.map(() => (mode === "hand" ? { text: `hand ${n++}` } : mode));
            const { changes, resolution } = settledRevert(found, text, choices);
            expect(found.conflicts.every((c) => c.later.length > 0 && c.later.every((r) => found.overlaps.includes(r)))).toBe(true);
            record(changes, reverts, resolution);
          }
          texts.push(text);
          if (applyChanges(takeBackOut(history, { how: "revert", revisions: [] }), text) !== text) ok = false;
          const to = random(history.length);
          if (applyChanges(takeBackOut(history, { how: "revert", revisions: history.slice(to).map((c) => c.revision), to }), text) !== texts[to]) ok = false;
        }
        if (!ok) { bad++; if (firsts.length < 3) firsts.push(`${log.join(" | ")} => ${JSON.stringify(applyChanges(takeBackOut(history, { how: "revert", revisions: [] }), text))}`); }
      }
      expect(`${bad}\n${firsts.join("\n")}`).toBe("0\n");
    }, 120_000);
});

describe("a note's record replayed", () => {
  it("leaves nothing of a note every line of which was rewritten and then replaced, once going back empties it", () => {
    const n = made("x y z8", "X Y Z8", "a6");
    expect(n.preview([1]).conflicts).toEqual([{ line: 1, before: [], now: ["a6"], kept: ["a6"], later: [3] }]);
    n.revert([1], "back");
    expect(n.text()).toBe("");
    n.edit("hello");
    n.revert([5]);
    expect(n.text()).toBe("");
    expect(n.backTo(4)).toBe("");
  });

  it("finds a change built on an edit that overlaps, so that going back leaves no piece of either", () => {
    const n = made("c25", "c25\nx y z1", "c25\nX Y Z1!\nnew45", "c25\nX Y Z1!!\nnew5\nnew45");
    expect(n.preview([2])).toMatchObject({ overlaps: [3, 4], conflicts: [{ line: 2, before: [], now: ["X Y Z1!!", "new5", "new45"], later: [3, 4] }] });
    n.revert([2], "back");
    expect(n.text()).toBe("c25");
  });

  it("writes a line after a revert that emptied the note as the note's first line, and one after a revert that removed its last line on a line of its own", () => {
    const n = made("x y z10", "e f8", "");
    n.revert([1]);
    n.edit("a48");
    expect(n.backTo(5)).toBe("a48");

    const joined = made("z0", "e z a1\nz0", "x a y2");
    joined.revert([1]);
    const after = joined.text();
    joined.edit(`${after}\ny e c3`);
    expect(joined.backTo(5)).toBe(`${after}\ny e c3`);
  });
});

describe("where a conflict is on the diff of the changes reverted", () => {
  /** A conflict's place in the note as revision `at` left it. */
  const placed = (n: ReturnType<typeof made>, revisions: number[], at: number) => {
    const found = n.preview(revisions);
    return found.conflicts.map((c) => linesAsOf(n.history, found, at, c.line, c.kept.length));
  };

  it("is the line the reverted change wrote, however the lines around it have moved since", () => {
    const n = made("one\ntwo\nthree", "one\nTWO\nthree", "zero\none\nTWO, and more\nthree\nfour");
    expect(n.preview([2]).conflicts).toMatchObject([{ line: 3, now: ["TWO, and more"] }]);
    expect(placed(n, [2], 2)).toEqual([{ line: 2, lines: 1 }]);
  });

  it("is every line of a stretch the reverted change wrote, when a later change rewrote part of it", () => {
    const n = made("a\nz", "a\nb\nc\nd\nz", "top\na\nb\nC!\nd\nz");
    expect(n.preview([2]).conflicts).toMatchObject([{ now: ["b", "C!", "d"], kept: ["C!"], later: [3] }]);
    expect(placed(n, [2], 2)).toEqual([{ line: 2, lines: 3 }]);
  });

  it("is the last line, when the reverted change wrote it at the note's end and a later one added to it", () => {
    const n = made("a\nb", "a\nb\nc", "a\nb\nc!");
    expect(n.preview([2]).conflicts).toMatchObject([{ now: ["c!"], kept: ["c!"] }]);
    expect(placed(n, [2], 2)).toEqual([{ line: 3, lines: 1 }]);
  });

  it("is told apart for two runs of changes: each conflict on the run that wrote its lines", () => {
    const n = made("a\nb\nc\nd\ne", "A\nb\nc\nd\ne", "A\nb\nc\nd\ne\nf", "A\nb\nc\nD\ne\nf", "A!\nb\nc\nD?\ne\nf");
    expect(n.preview([2, 4]).conflicts).toMatchObject([{ now: ["A!"] }, { now: ["D?"] }]);
    expect(placed(n, [2, 4], 2)).toEqual([{ line: 1, lines: 1 }, { line: 4, lines: 1 }]);
    expect(placed(n, [2, 4], 4)).toEqual([{ line: 1, lines: 1 }, { line: 4, lines: 1 }]);
  });
});
