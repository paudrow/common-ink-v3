import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { dayIn, overlapping, rebased, redoTarget, revertedBy, takeBackOut, takeOut, undoTarget, type Recorded, type Step } from "../../src/core/history.ts";
import type { Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";

/** The changes that step a note through `texts`, starting from an empty note. */
function through(...texts: string[]): ChangeSet[] {
  return texts.map((text, i) => changesBetween(texts[i - 1] ?? "", text));
}
const without = (texts: string[], ...revisions: number[]) => applyChanges(takeOut(through(...texts), new Set(revisions)), texts.at(-1)!);

/** A note as the operations keep it: its text, and its changes with what each took back out. */
function note() {
  const history: (Recorded & { author: string })[] = [];
  let text = "";
  const record = (author: string, changes: ChangeSet, reverts: Reverts | null) => {
    history.push({ revision: history.length + 1, changes, reverts, author });
    text = applyChanges(changes, text);
    return history.length;
  };
  return {
    history,
    text: () => text,
    edit: (to: string, author = "ada") => record(author, changesBetween(text, to), null),
    take: (revisions: number[], how: Reverts["how"] = "revert", author = "ada", to?: number) =>
      record(author, takeBackOut(history, { how, revisions }), { how, revisions, ...(to === undefined ? {} : { to }) }),
  };
}

describe("taking changes back out", () => {
  const texts = ["alpha", "alpha\nbeta", "ALPHA\nbeta", "ALPHA\nbeta\ngamma"];

  it("takes out one change from the middle and keeps the ones after it", () => {
    expect(without(texts, 2)).toBe("ALPHA\ngamma");
    expect(without(texts, 3)).toBe("alpha\nbeta\ngamma");
  });

  it("takes out several changes at once", () => {
    expect(without(texts, 2, 4)).toBe("ALPHA");
    expect(without(texts, 1, 3)).toBe("beta\ngamma");
  });

  it("gives exactly the text at a revision when everything after it is taken out", () => {
    expect(without(texts, 4)).toBe(texts[2]);
    expect(without(texts, 3, 4)).toBe(texts[1]);
    expect(without(texts, 2, 3, 4)).toBe(texts[0]);
    expect(without(texts, 1, 2, 3, 4)).toBe("");
  });

  it("holds for edits of every kind: 200 random notes each come back to every one of their revisions", () => {
    let seed = 42;
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
    const words = ["alpha", "beta", "gamma", "delta", "\n", "\n\n", "- [ ] todo", "# Title", " "];
    for (let note = 0; note < 200; note++) {
      const texts = [words[random(words.length)]!];
      for (let edit = 0; edit < 6; edit++) {
        const text = texts.at(-1)!;
        const at = random(text.length + 1);
        texts.push(text.slice(0, at) + (random(3) ? words[random(words.length)]! : "") + text.slice(Math.min(text.length, at + random(4))));
      }
      for (let revision = 0; revision < texts.length; revision++) {
        const after = Array.from({ length: texts.length - revision }, (_, i) => revision + 1 + i);
        expect(without(texts, ...after)).toBe(texts[revision - 1] ?? "");
      }
    }
  });

  it("changes nothing when nothing is chosen", () => {
    expect(without(texts)).toBe(texts[3]);
  });

  it("keeps text a later change typed inside what the taken-out change added", () => {
    expect(without(["one", "one two three", "one two and a half three"], 2)).toBe("oneand a half ");
  });
});

describe("taking changes back out of a note that has been through reverts already", () => {
  it("takes a change out again after it was taken out and put back", () => {
    const plan = note();
    plan.edit("# Plan\n\nAda's step");
    plan.edit("# Plan\n\nAda's step\n\nClaude's step");
    plan.edit("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");
    plan.take([2]);
    plan.take([4]);
    expect(plan.text()).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");

    plan.take([2]);
    expect(plan.text()).toBe("# Plan\n\nAda's step\n\nAda's last word");
    plan.take([6]);
    expect(plan.text()).toBe("# Plan\n\nAda's step\n\nClaude's step\n\nAda's last word");
  });

  it("takes an edit out after it was undone and redone, and one change out after a revert to a revision was put back", () => {
    const words = note();
    words.edit("one");
    words.edit("one two");
    words.take([2], "undo");
    words.take([3], "redo");
    words.take([2]);
    expect(words.text()).toBe("one");

    const letters = note();
    letters.edit("a");
    letters.edit("a b");
    letters.edit("a b c");
    letters.take([2, 3], "revert", "ada", 1);
    letters.take([4]);
    letters.take([3]);
    expect(letters.text()).toBe("a b");
  });

  it("keeps an edit made inside text that was taken out and put back, when something else is taken out later", () => {
    const n = note();
    n.edit("start");
    n.edit("start\nthe agent's line");
    n.edit("start\nthe agent's line\nend");
    n.take([2]);
    n.take([4]);
    n.edit("start\nthe agent's very long line\nend");
    n.take([3]);
    expect(n.text()).toBe("start\nthe agent's very long line");
  });

  it("keeps the text true to the record through 300 random runs of edits, reverts, put-backs, undos, and redos by two authors", () => {
    let seed = 7;
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
    const SLOTS = 8;
    const blank = Array.from({ length: SLOTS }, (_, slot) => `line ${slot}`);
    for (let run = 0; run < 300; run++) {
      const n = note();
      n.edit(blank.join("\n"), "setup");
      /** The change that edited each line. A line reads as edited exactly while that change stands. */
      const editOf = new Map<number, number>();
      const texts = ["", n.text()];
      const expected = () => {
        const reverted = revertedBy(n.history);
        return blank.map((line, slot) => (editOf.has(slot) && !reverted.has(editOf.get(slot)!) ? `${line}, edited` : line)).join("\n");
      };
      for (let op = 0; op < 14; op++) {
        const reverted = revertedBy(n.history);
        const standing = n.history.filter((c) => c.revision > 1 && !reverted.has(c.revision)).map((c) => c.revision);
        const author = random(2) ? "ada" : "claude";
        const mine = n.history.filter((c) => c.author === author);
        const kind = random(6);
        if (kind === 0 && editOf.size < SLOTS) {
          const slot = blank.findIndex((_, i) => !editOf.has(i));
          editOf.set(slot, n.edit(n.text().split("\n").map((line, i) => (i === slot ? `${line}, edited` : line)).join("\n"), author));
        } else if (kind === 1 && standing.length) {
          n.take([...new Set([standing[random(standing.length)]!, standing[random(standing.length)]!])].sort((a, b) => a - b), "revert", author);
        } else if (kind === 2) {
          const reverts = standing.filter((r) => n.history[r - 1]!.reverts);
          if (reverts.length) n.take([reverts[random(reverts.length)]!], "revert", author);
        } else if (kind === 3) {
          const target = undoTarget(mine, reverted);
          if (target !== null) n.take([target], "undo", author);
        } else if (kind === 4) {
          const target = redoTarget(mine, reverted);
          if (target !== null) n.take([target], "redo", author);
        } else if (kind === 5 && n.history.length > 2) {
          const to = 1 + random(n.history.length - 1);
          n.take(n.history.slice(to).map((c) => c.revision), "revert", author, to);
          expect(n.text()).toBe(texts[to]);
        }
        texts[n.history.length] = n.text();
        expect(n.text(), `run ${run}, after ${JSON.stringify(n.history.map((c) => c.reverts?.revisions ?? "edit"))}`).toBe(expected());
      }
    }
  });
});

describe("taking a change out of a note another author changed next to it", () => {
  it("leaves the other author's todo whole when it was added above the one taken out", () => {
    const n = note();
    n.edit("- [ ] buy milk", "ada");
    n.edit("- [ ] call bank\n- [ ] buy milk", "claude");
    n.take([1], "undo", "ada");
    expect(n.text()).toBe("- [ ] call bank");
  });

  it("leaves a member's lines whole when the agent's line between them is taken out", () => {
    const n = note();
    n.edit("# Shopping\n- [ ] buy milk", "ada");
    n.edit("# Shopping\n- [ ] buy milk\n- [ ] buy bread", "claude");
    n.edit("# Shopping\n- [ ] buy milk\n- [ ] buy butter\n- [ ] buy bread\n- [ ] buy beans", "ada");
    n.take([2], "revert", "ada");
    expect(n.text()).toBe("# Shopping\n- [ ] buy milk\n- [ ] buy butter\n- [ ] buy beans");
  });

  it("takes out a line added at the end and keeps one added after it, and the other way round", () => {
    const below = note();
    below.edit("# Plan", "ada");
    below.edit("# Plan\n- [ ] one", "ada");
    below.edit("# Plan\n- [ ] one\n- [ ] two", "claude");
    below.take([2], "undo", "ada");
    expect(below.text()).toBe("# Plan\n- [ ] two");

    const above = note();
    above.edit("# Plan", "ada");
    above.edit("# Plan\n- [ ] one", "ada");
    above.edit("# Plan\n- [ ] two\n- [ ] one", "claude");
    above.take([2], "undo", "ada");
    expect(above.text()).toBe("# Plan\n- [ ] two");
  });

  it("keeps a todo's completion with its own todo when the todo above is taken out", () => {
    const n = note();
    n.edit("- [ ] water plants every week", "ada");
    n.edit("- [ ] wash car every week\n- [ ] water plants every week", "claude");
    n.edit("- [ ] wash car every week\n- [x] water plants every week", "ada");
    n.take([2], "revert", "ada");
    expect(n.text()).toBe("- [x] water plants every week");
  });

  it("reads a change recorded as a diff of characters by its lines", () => {
    const milk = "- [ ] buy milk";
    const recorded = [ChangeSet.of({ from: 0, insert: milk }, 0), ChangeSet.of({ from: 6, insert: "call bank\n- [ ] " }, milk.length)];
    expect(applyChanges(recorded[1]!, milk)).toBe("- [ ] call bank\n- [ ] buy milk");
    expect(applyChanges(takeOut(recorded, new Set([1])), "- [ ] call bank\n- [ ] buy milk")).toBe("- [ ] call bank");
    expect(applyChanges(takeOut(recorded, new Set([2])), "- [ ] call bank\n- [ ] buy milk")).toBe(milk);
  });

  /** Raise to run more: 20,000 runs were checked once by hand. */
  const RUNS = 400;

  it(`leaves every other line as it was through ${RUNS} random runs of two authors adding, editing and removing their own lines, then one change taken out`, () => {
    let seed = 11;
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
    const things = ["buy milk", "buy eggs", "call bank", "call mum", "book flights", "water plants"];
    const authors = ["ada", "claude"];
    let checked = 0;
    for (let run = 0; run < RUNS; run++) {
      const n = note();
      let made = 0;
      const line = (owner: string) => ({ owner, text: `- [ ] ${things[random(things.length)]} ${made++}` });
      let lines = [line("ada"), line("claude"), line("ada")];
      const say = (list: typeof lines) => list.map((l) => l.text).join("\n");
      n.edit(say(lines), "setup");
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
        did.push({ revision: n.edit(say(lines), author), before, after });
      }
      const taken = did[random(did.length)]!;
      // Only a change nothing later built on has one answer: its line goes back to what it was.
      const builtOn = did.some((d) => d.revision > taken.revision && d.before !== null && d.before === taken.after);
      if (builtOn) continue;
      checked++;
      n.take([taken.revision], "revert", "ada");

      const others = lines.map((l) => l.text).filter((text) => text !== taken.after);
      const result = n.text() === "" ? [] : n.text().split("\n");
      const where = `run ${run}, taking out ${JSON.stringify(taken)} from ${JSON.stringify(say(lines))}`;
      expect(result.filter((text) => text !== taken.before), where).toEqual(others);
      expect(result.filter((text) => text === taken.before), where).toHaveLength(taken.before === null ? 0 : 1);
    }
    expect(checked).toBeGreaterThan(RUNS / 2);
  });
});

describe("a write moved over the changes made since the text it was based on", () => {
  it("keeps every line whole for every pair of edits to a short list: to different lines, and to different parts of one", () => {
    /** An edit to one line of a list, or a line put in before the line at `at`. */
    type Edit = { at: number; line?: (text: string) => string | null };
    const editsOf = (lines: string[]): Edit[] => [
      ...Array.from({ length: lines.length + 1 }, (_, at) => ({ at })),
      ...lines.flatMap((_, at): Edit[] => [
        { at, line: () => null },
        { at, line: (text) => text.replace("[ ]", "[x]") },
        { at, line: (text) => `${text} now` },
        { at, line: (text) => `* ${text.slice(2)}.` },
      ]),
    ];
    const say = (lines: Array<string | null>) => lines.filter((l) => l !== null).join("\n");
    const after = (lines: Array<string | null>, ...edits: Edit[]) => lines.map((text, i) => edits.reduce<string | null>((t, e) => (e.line && e.at === i && t !== null ? e.line(t) : t), text));
    const alone = (lines: string[], edit: Edit) => say(edit.line ? after(lines, edit) : [...lines.slice(0, edit.at), "- [ ] x", ...lines.slice(edit.at)]);
    let pairs = 0;
    for (const base of [["- [ ] buy milk"], ["- [ ] a", "- [ ] buy milk"], ["- [ ] buy milk", "- [ ] call bank"], ["- [ ] a", "- [ ] buy milk", "- [ ] call bank"]]) {
      for (const first of editsOf(base)) {
        for (const second of editsOf(base)) {
          // Two edits to one line are tried where they are to different parts of it.
          const sameLine = first.line && second.line && first.at === second.at;
          if (sameLine && (first.line!("- [ ] a") === null || second.line!("- [ ] a") === null || first.line!("- [ ] a") === second.line!("- [ ] a") || !/\[x\]/.test(`${first.line!("- [ ] a")}${second.line!("- [ ] a")}`))) continue;
          pairs++;
          const merged = applyChanges(rebased(say(base), alone(base, second), [changesBetween(say(base), alone(base, first))]), alone(base, first));
          const lines = merged === "" ? [] : merged.split("\n");
          const kept = after(base, first, second).filter((l) => l !== null);
          const where = `${JSON.stringify(say(base))} to ${JSON.stringify(alone(base, first))} and to ${JSON.stringify(alone(base, second))}`;
          expect(lines.filter((text) => text !== "- [ ] x"), where).toEqual(kept);
          expect(lines.filter((text) => text === "- [ ] x"), where).toHaveLength([first, second].filter((e) => !e.line).length);
        }
      }
    }
    expect(pairs).toBeGreaterThan(250);
  });

  it("keeps both of two edits to one line when one of them is to two places in it", () => {
    const base = "alpha beta gamma delta epsilon";
    const ends = "ALPHA beta gamma delta EPSILON";
    const middle = "alpha beta GAMMA delta epsilon";
    expect(applyChanges(rebased(base, middle, [changesBetween(base, ends)]), ends)).toBe("ALPHA beta GAMMA delta EPSILON");
    expect(applyChanges(rebased(base, ends, [changesBetween(base, middle)]), middle)).toBe("ALPHA beta GAMMA delta EPSILON");
    expect(without([base, ends, "ALPHA beta GAMMA delta EPSILON"], 2)).toBe(middle);
    expect(without(["one", "one, edited with a rather long line", "one, edited (again) with a rather long line"], 2)).toBe("one(again) ");
    expect(applyChanges(rebased("- [ ] call \u{1F600} bank", "- [x] call \u{1F600} bank", [changesBetween("- [ ] call \u{1F600} bank", "- [ ] call \u{1F601} bank today")]), "- [ ] call \u{1F601} bank today")).toBe("- [x] call \u{1F601} bank today");
  });

  it("keeps what is left of a line the other change removed as a line of its own, not joined to the next", () => {
    expect(without(["a\nc", "a\nx\nc", "a\nx!\nc"], 2)).toBe("a\n!\nc");
    expect(without(["a\nb\nc", "a\nB\nc", "a\nc"], 2)).toBe("a\nb\nc");
    expect(applyChanges(rebased("a\nb\nc", "a\nb!\nc", [changesBetween("a\nb\nc", "a\nc")]), "a\nc")).toBe("a\n!\nc");
    expect(applyChanges(rebased("a\nb\nc", "a\nc", [changesBetween("a\nb\nc", "a\nb!\nc")]), "a\nb!\nc")).toBe("a\n!\nc");
    expect(applyChanges(rebased("a\nb", "a\nb!", [changesBetween("a\nb", "a")]), "a")).toBe("a\n!");
  });
});

describe("the later changes a revert overlaps", () => {
  const overlaps = (texts: string[], ...revisions: number[]) => {
    const n = note();
    for (const text of texts) n.edit(text);
    return overlapping(n.history, { how: "revert", revisions });
  };

  it("are the ones that edited a line the revert changes, joined it to the line before or after, or removed it", () => {
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nB!\nc"], 2)).toEqual([3]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "aB\nc"], 2)).toEqual([3]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nBc"], 2)).toEqual([3]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nc"], 2)).toEqual([3]);
  });

  it("are not the ones that added or removed whole lines next to it, or edited its neighbours", () => {
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nx\nB\nc"], 2)).toEqual([]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nB\nx\nc"], 2)).toEqual([]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "B\nc"], 2)).toEqual([]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a\nB"], 2)).toEqual([]);
    expect(overlaps(["a\nb\nc", "a\nB\nc", "a!\nB\nc!"], 2)).toEqual([]);
  });
});

describe("the cost of taking a change out", () => {
  const words = "the of and to in is that for it as was with be by on not he this are or his from at which but have an had they you were their one all we can her has there been if more when will would who so no".split(" ");
  /** Prose that shares its words with every other draft and its lines with none. */
  const draft = (seed: number, size: number) => {
    const random = (below: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % below;
    const lines: string[] = [];
    for (let length = 0; length < size; length += lines.at(-1)!.length + 1) lines.push(Array.from({ length: 6 + random(14) }, () => words[random(words.length)]).join(" "));
    return lines.join("\n");
  };

  it("follows what changed, not the note's size times the changes after it: a 20 KB rewrite and 40 small edits", () => {
    const n = note();
    n.edit(draft(1, 20_000));
    n.edit(draft(2, 20_000), "claude");
    for (let i = 0; i < 40; i++) n.edit(`${n.text()}${i % 10}`);
    const start = performance.now();
    n.take([2]);
    expect(performance.now() - start).toBeLessThan(500);
    expect(n.text()).toBe(`${draft(1, 20_000)}${"0123456789".repeat(4)}`);
  });

  it("records a rewrite without seconds in the diff: 40 KB of many lines, of one, and of thousands, and 400 KB turned upside down", () => {
    for (const [from, to] of [
      [draft(1, 40_000), draft(2, 40_000)],
      [draft(1, 40_000).replaceAll("\n", " "), draft(2, 40_000).replaceAll("\n", " ")],
      [draft(1, 40_000).replaceAll(" ", "\n"), draft(2, 40_000).replaceAll(" ", "\n")],
      [draft(1, 400_000), draft(1, 400_000).split("\n").reverse().join("\n")],
    ] as const) {
      const start = performance.now();
      const changes = changesBetween(from, to);
      expect(performance.now() - start).toBeLessThan(500);
      expect(applyChanges(changes, from)).toBe(to);
    }
  });

  it("leaves no trace of a change taken out together with the change that undid it", () => {
    const n = note();
    n.edit("start\nend");
    n.edit("start\nthe agent's line\nend", "claude");
    n.take([2]);
    n.edit("start\nend\nmore");
    expect(takeOut(n.history.map((c) => c.changes), new Set([2, 3])).empty).toBe(true);

    const inside = note();
    inside.edit("one");
    inside.edit("one two three", "claude");
    inside.edit("one two and a half three");
    inside.take([2]);
    expect(inside.text()).toBe("oneand a half ");
    expect(takeOut(inside.history.map((c) => c.changes), new Set([2, 4])).empty).toBe(true);
  });
});

const step = (revision: number, how?: Reverts["how"], ...revisions: number[]): Step => ({ revision, reverts: how ? { how, revisions } : null });

describe("which changes still stand", () => {
  it("names the change that took each one out", () => {
    expect([...revertedBy([step(1), step(2), step(3, "revert", 1, 2)])]).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it("lets a change stand again once the change that took it out is itself taken out", () => {
    const reverted = revertedBy([step(1), step(2, "undo", 1), step(3, "redo", 2)]);
    expect([...reverted]).toEqual([[2, 3]]);
  });

  it("credits the latest change when two took the same one out", () => {
    expect(revertedBy([step(1), step(2, "revert", 1), step(3, "revert", 1, 2)]).get(1)).toBe(3);
  });
});

describe("undo and redo", () => {
  const targets = (...steps: Step[]) => {
    const reverted = revertedBy(steps);
    return { undo: undoTarget(steps, reverted), redo: redoTarget(steps, reverted) };
  };

  it("undo takes back the latest change, then the one before it", () => {
    expect(targets(step(1), step(2), step(3))).toEqual({ undo: 3, redo: null });
    expect(targets(step(1), step(2), step(3), step(4, "undo", 3))).toEqual({ undo: 2, redo: 4 });
    expect(targets(step(1), step(2), step(3), step(4, "undo", 3), step(5, "undo", 2))).toEqual({ undo: 1, redo: 5 });
  });

  it("redo puts back the latest undo, then the one before it, and undo can take a redo back", () => {
    const steps = [step(1), step(2), step(3), step(4, "undo", 3), step(5, "undo", 2), step(6, "redo", 5)];
    expect(targets(...steps)).toEqual({ undo: 6, redo: 4 });
    expect(targets(...steps, step(7, "redo", 4))).toEqual({ undo: 7, redo: null });
    expect(targets(...steps, step(7, "undo", 6))).toEqual({ undo: 1, redo: 7 });
  });

  it("has nothing to redo once the author has edited after undoing", () => {
    expect(targets(step(1), step(2, "undo", 1), step(3))).toEqual({ undo: 3, redo: null });
    expect(targets(step(1), step(2, "undo", 1), step(3), step(4, "undo", 3), step(5, "redo", 4))).toEqual({ undo: 5, redo: null });
  });

  it("has nothing to undo when every change was taken back", () => {
    expect(targets(step(1), step(2, "undo", 1))).toEqual({ undo: null, redo: 2 });
    expect(targets()).toEqual({ undo: null, redo: null });
  });
});

describe("the day a change was made", () => {
  it("is the calendar day in the zone asked for", () => {
    const time = Date.UTC(2026, 2, 1, 3, 30);
    expect(dayIn("UTC")(time)).toBe("2026-03-01");
    expect(dayIn("America/Los_Angeles")(time)).toBe("2026-02-28");
    expect(dayIn("Pacific/Auckland")(Date.UTC(2026, 2, 1, 12))).toBe("2026-03-02");
  });

  it("refuses a zone that doesn't exist", () => {
    expect(() => dayIn("Mars/Olympus")).toThrow(RangeError);
  });
});
