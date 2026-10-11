import { ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { dayIn, redoTarget, revertOfAuthor, revertedBy, takeBackOut, takeOut, undoTarget, type Recorded, type Step } from "../../src/core/history.ts";
import type { Reverts } from "../../src/core/protocol.ts";
import { applyChanges, changesBetween } from "../../src/core/text.ts";

/** The changes that step a note through `texts`, starting from an empty note. */
function through(...texts: string[]): ChangeSet[] {
  return texts.map((text, i) => changesBetween(texts[i - 1] ?? "", text));
}
const without = (texts: string[], ...revisions: number[]) => applyChanges(takeOut(through(...texts), new Set(revisions)), texts.at(-1)!);

describe("taking changes back out", () => {
  const texts = ["alpha", "alpha\nbeta", "ALPHA\nbeta", "ALPHA\nbeta\ngamma"];

  it("takes out one change from the middle and keeps the ones after it", () => {
    expect(without(texts, 2)).toBe("ALPHA\ngamma");
    expect(without(texts, 3)).toBe("alpha\nbeta\ngamma");
  });

  it("takes out several changes at once", () => {
    expect(without(texts, 2, 4)).toBe("ALPHA");
    expect(without(texts, 1, 3)).toBe("\nbeta\ngamma");
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
      /** Reverts everything `of` changed, as `author`. Null when there was nothing to take out. */
      revertAuthor: (of: string, author = "ada") => {
        const reverts = revertOfAuthor(history, (c) => c.author === of);
        return reverts && record(author, takeBackOut(history, reverts), reverts);
      },
    };
  }

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

  it("reverts an author again after their changes were put back and they edited more", () => {
    for (const by of ["ada", "claude"]) {
      const n = note();
      n.edit("# Plan", "ada");
      n.edit("# Plan\n\nClaude's step", "claude");
      expect(n.revertAuthor("claude", by)).toBe(3);
      expect(n.text()).toBe("# Plan");
      n.take([3]);
      expect(n.text()).toBe("# Plan\n\nClaude's step");
      n.edit("# Plan\n\nClaude's step\n\nClaude's second", "claude");

      expect(n.revertAuthor("claude", by)).toBe(6);
      expect(n.history[5]!.reverts!.revisions).toEqual([2, 5]);
      expect(n.text()).toBe("# Plan");
      expect(n.revertAuthor("claude", by)).toBeNull();
      expect(n.history).toHaveLength(6);
    }
  });

  it("keeps the text true to the record through 300 random runs of edits, reverts, put-backs, undos, redos, and reverts of an author by two authors", () => {
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
        const kind = random(7);
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
        } else if (kind === 6) {
          const of = random(2) ? "ada" : "claude";
          n.revertAuthor(of, author);
          const out = revertedBy(n.history);
          expect(n.history.filter((c) => c.author === of && !c.reverts && !out.has(c.revision))).toEqual([]);
          expect(n.revertAuthor(of, author)).toBeNull();
        }
        texts[n.history.length] = n.text();
        expect(n.text(), `run ${run}, after ${JSON.stringify(n.history.map((c) => c.reverts?.revisions ?? "edit"))}`).toBe(expected());
      }
    }
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

describe("what reverting an author takes out", () => {
  const agents = (...revisions: number[]) => (s: Step) => revisions.includes(s.revision);
  const taken = (steps: Step[], isTheirs: (s: Step) => boolean) => revertOfAuthor(steps, isTheirs)?.revisions ?? null;

  it("is every change of theirs, and nobody else's", () => {
    expect(taken([step(1), step(2), step(3), step(4)], agents(2, 4))).toEqual([2, 4]);
    expect(taken([step(1), step(2)], agents())).toBeNull();
  });

  it("leaves out a change somebody else already took out", () => {
    expect(taken([step(1), step(2), step(3, "revert", 2), step(4)], agents(2, 4))).toEqual([4]);
    expect(taken([step(1), step(2), step(3, "revert", 2)], agents(2))).toBeNull();
  });

  it("names their undo along with the change it undid, so the change doesn't come back", () => {
    expect(taken([step(1), step(2), step(3, "undo", 2), step(4)], agents(2, 3, 4))).toEqual([2, 3, 4]);
  });

  it("is nothing when all they have left is a change they undid themselves", () => {
    expect(taken([step(1), step(2), step(3, "undo", 2)], agents(2, 3))).toBeNull();
  });

  it("names their revert of someone else's change, so that change stands again", () => {
    expect(taken([step(1), step(2, "revert", 1)], agents(2))).toEqual([2]);
  });

  it("counts a change as still reverted when it was they who reverted the revert of it", () => {
    const steps = [step(1), step(2), step(3, "revert", 2), step(4, "revert", 3)];
    expect(taken(steps, agents(2, 4))).toEqual([4]);
  });

  it("names a change again when the member who reverted it later reverted that revert", () => {
    const steps = [step(1), step(2), step(3, "revert", 2), step(4, "revert", 3)];
    expect(taken(steps, agents(2))).toEqual([2]);
  });

  it("is nothing the second time, when the author reverted themselves too", () => {
    expect(taken([step(1), step(2), step(3, "revert", 2)], agents(2, 3))).toBeNull();
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
