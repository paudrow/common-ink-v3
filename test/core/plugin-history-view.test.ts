import { describe, expect, it } from "vitest";
import { textDiff } from "../../src/core/diff.ts";
import type { Author, HistoryEntry, Reverts } from "../../src/core/protocol.ts";
import { MOST_OF_A_NOTE, NOTHING, asked, byDay, dayLabel, did, groupSaves, initials, kept, lists, notesOf, only, picked, pieces, sameSelection, sizeOf, who, within, withRows } from "../../src/web/plugins/lib/historyView.ts";

const ADA: Author = { kind: "member", personId: "ada000000000", name: "Ada Lovelace" };
const CLAUDE: Author = { kind: "agent", agentId: "claude000000", name: "Claude", onBehalfOf: "ada000000000" };
const MINUTE = 60_000;

const change = (revision: number, author: Author, at: number, more: Partial<HistoryEntry> = {}): HistoryEntry => ({
  noteId: "note00000000",
  noteTitle: "Plan",
  revision,
  baseRevision: revision - 1,
  author,
  createdAt: at * MINUTE,
  label: null,
  reverts: null,
  revertedBy: null,
  added: 1,
  removed: 0,
  restores: 0,
  diff: null,
  ...more,
});
const shape = (changes: HistoryEntry[]) => groupSaves(changes).map((row) => row.revisions);

describe("the rows of the list", () => {
  it("fold one author's saves to one note that follow one another less than ten minutes apart, each from the one before", () => {
    expect(shape([change(4, ADA, 27), change(3, ADA, 18), change(2, ADA, 9), change(1, ADA, 0)])).toEqual([[4, 3, 2, 1]]);
    expect(shape([change(3, ADA, 30), change(2, ADA, 20), change(1, ADA, 0)])).toEqual([[3], [2], [1]]);
    const [row] = groupSaves([change(2, ADA, 5, { added: 3, removed: 2, label: "Good" }), change(1, ADA, 0)]);
    expect(row).toMatchObject({ key: "note00000000/2", added: 4, removed: 2, firstAt: 0, lastAt: 5 * MINUTE, labels: ["Good"] });
  });

  it("keep apart another author's save, another note's, a save that is not the next revision, and a revert", () => {
    expect(shape([change(3, ADA, 2), change(2, CLAUDE, 1), change(1, ADA, 0)])).toEqual([[3], [2], [1]]);
    expect(shape([change(2, ADA, 1), change(1, ADA, 0, { noteId: "other0000000" })])).toEqual([[2], [1]]);
    expect(shape([change(3, ADA, 1), change(1, ADA, 0)])).toEqual([[3], [1]]);
    const reverts: Reverts = { how: "revert", revisions: [1] };
    expect(shape([change(3, ADA, 2), change(2, ADA, 1, { reverts }), change(1, ADA, 0)])).toEqual([[3], [2], [1]]);
  });

  it("keep a save that was reverted apart from one that stands, so a row is reverted or not as a whole", () => {
    const rows = groupSaves([change(3, ADA, 2), change(2, ADA, 1, { revertedBy: 4 }), change(1, ADA, 0, { revertedBy: 4 })]);
    expect(rows.map((r) => [r.revisions, r.reverted])).toEqual([
      [[3], false],
      [[2, 1], true],
    ]);
  });

  it("say what each did: wrote, edited, reverted, went back, undid a revert, and the same without the note's name", () => {
    const revert = (revisions: number[], more: Partial<Reverts> = {}): Reverts => ({ how: "revert", revisions, ...more });
    expect(did({ reverts: null, restores: 0, revisions: [2, 1] })).toBe("wrote");
    expect(did({ reverts: null, restores: 0, revisions: [3, 2] })).toBe("edited");
    expect(did({ reverts: revert([2, 3, 4]), restores: 0, revisions: [5] })).toBe("reverted 3 changes to");
    expect(did({ reverts: revert([5]), restores: 1, revisions: [6] })).toBe("undid a revert of");
    expect(did({ reverts: revert([5, 6]), restores: 2, revisions: [7] })).toBe("undid 2 reverts of");
    expect(did({ reverts: revert([4, 5]), restores: 1, revisions: [6] })).toBe("reverted 2 changes to");
    expect(did({ reverts: revert([3, 4], { to: 2 }), restores: 0, revisions: [5] })).toBe("went back 2 changes in");
    expect(did({ reverts: revert([4], { how: "undo" }), restores: 0, revisions: [5] })).toBe("undid a change to");
    expect(did({ reverts: revert([5], { how: "redo" }), restores: 1, revisions: [6] })).toBe("redid a change to");
    expect(did({ reverts: revert([2]), restores: 0, revisions: [3] }, false)).toBe("reverted 1 change");
    expect(did({ reverts: revert([3]), restores: 1, revisions: [4] }, false)).toBe("undid a revert");
  });

  it("name the member as You, anyone else by name, and draw initials", () => {
    expect([who(ADA, "ada000000000"), who(ADA, "grace0000000"), who(CLAUDE, "ada000000000")]).toEqual(["You", "Ada Lovelace", "Claude"]);
    expect([initials("Ada Lovelace"), initials("dev"), initials("Jean-Luc Picard Sr"), initials("")]).toEqual(["AL", "D", "JL", "?"]);
  });

  it("head each day: Today, Yesterday, then the date", () => {
    const now = new Date(2026, 9, 12, 15).getTime();
    expect(dayLabel(new Date(2026, 9, 12, 0, 5).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 11, 23, 55).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 5, 12).getTime(), now)).toMatch(/Oct/);
    expect(dayLabel(new Date(2025, 9, 5, 12).getTime(), now)).toMatch(/2025/);
  });
});

describe("the selection", () => {
  const rows = groupSaves([change(4, ADA, 40), change(3, CLAUDE, 30), change(2, ADA, 5), change(1, ADA, 0)]);

  it("takes rows in and out by their changes, and a note with none picked is not in it", () => {
    const one = only([rows[2]!]);
    expect(asked(one)).toEqual([{ noteId: "note00000000", revisions: [1, 2] }]);
    expect([sizeOf(one), picked(one, rows), picked(one, [rows[2]!]), picked(NOTHING, rows)]).toEqual([2, "some", "all", "none"]);
    const two = withRows(one, [rows[0]!], true);
    expect(asked(two)).toEqual([{ noteId: "note00000000", revisions: [1, 2, 4] }]);
    expect(asked(one)).toEqual([{ noteId: "note00000000", revisions: [1, 2] }]);
    expect(withRows(two, rows, false).size).toBe(0);
    expect([sameSelection(two, withRows(only([rows[0]!]), [rows[2]!], true)), sameSelection(one, two)]).toEqual([true, false]);
  });
});

describe("a selection too large for one note", () => {
  it("is cut to the note's latest changes, and says it was", () => {
    const many = only([{ noteId: "note00000000", revisions: Array.from({ length: MOST_OF_A_NOTE + 40 }, (_, i) => i + 1) }]);
    const made = within(withRows(many, [{ noteId: "other0000000", revisions: [1, 2] }], true));
    expect(made.cut).toBe(true);
    expect(asked(made.selection).map((c) => [c.revisions[0], c.revisions.length])).toEqual([[41, MOST_OF_A_NOTE], [1, 2]]);
    expect(within(only([{ noteId: "note00000000", revisions: [1, 2] }])).cut).toBe(false);
  });
});

describe("a diff as it is drawn", () => {
  const kinds = (before: string, after: string) => pieces(textDiff(before, after)).map((p) => (p.kind === "fold" ? `fold ${p.from}-${p.to}` : p.kind === "more" ? `more ${p.lines.length} ${p.of}` : p.kind === "mod" ? `mod ${p.words.map((w) => `${w.kind[0]}:${w.text}`).join("|")}` : `${p.kind} ${p.text}`));
  const lines = (n: number, of = "line") => Array.from({ length: n }, (_, i) => `${of} ${i}`);

  it("folds the unchanged lines before, between and after its changes, beyond two lines around each", () => {
    const before = lines(20);
    const after = before.map((l, i) => (i === 5 || i === 14 ? `${l}!` : l));
    expect(kinds(before.join("\n"), after.join("\n"))).toEqual([
      "fold 0-3",
      "same line 3",
      "same line 4",
      "mod s:line 5|a:!",
      "same line 6",
      "same line 7",
      "fold 8-12",
      "same line 12",
      "same line 13",
      "mod s:line 14|a:!",
      "same line 15",
      "same line 16",
      "fold 17-20",
    ]);
  });

  it("shows a short rewrite once with its changed words marked, and lines with no word in common as lines out and in", () => {
    expect(kinds("- [ ] buy milk", "- [x] buy oat milk")).toEqual(["mod s:- [|d: |a:x|s:] buy|a: oat|s: milk"]);
    expect(kinds("alpha", "omega")).toEqual(["del alpha", "add omega"]);
    // Two lines joined into one are a line out and a line in, not words changed within a line.
    expect(kinds("alpha beta\ngamma delta", "alpha beta gamma delta")).toEqual(["del alpha beta", "del gamma delta", "add alpha beta gamma delta"]);
    expect(kinds("a\nb", "a\nb\nc")).toEqual(["same a", "same b", "add c"]);
  });

  it("cuts a long run of added or removed lines to its start, and keeps the rest to show when asked", () => {
    expect(kinds("", lines(61).join("\n")).slice(-2)).toEqual(["add line 29", "more 31 add"]);
    expect(kinds(lines(60).join("\n"), "")).toHaveLength(60);
  });

  it("folds nothing after the last change of a diff that leaves lines out, since where it ends is not known", () => {
    const diff = textDiff("", lines(260).join("\n"));
    expect(diff.omitted).toBe(60);
    expect(pieces(diff).some((p) => p.kind === "fold")).toBe(false);
  });
});

describe("the list by day", () => {
  const DAY = 24 * 60;
  const noon = new Date(2026, 9, 12, 12).getTime() / MINUTE;
  const trip = { noteId: "trip00000000", noteTitle: "Trip" };
  const rows = groupSaves([change(5, ADA, noon + 30), change(2, CLAUDE, noon + 20, trip), change(4, CLAUDE, noon + 10), change(1, ADA, noon, trip), change(3, ADA, noon - DAY), change(2, ADA, noon - DAY - 1), change(1, ADA, noon - 3 * DAY)]);

  it("puts each row under the day it was last saved on, newest day first, with no day that has none", () => {
    const days = byDay(rows);
    expect(days.map((d) => d.rows.map((r) => r.key))).toEqual([["note00000000/5", "trip00000000/2", "note00000000/4", "trip00000000/1"], ["note00000000/3"], ["note00000000/1"]]);
    expect(days.map((d) => new Date(d.at).getDate())).toEqual([12, 11, 9]);
    expect(byDay([])).toEqual([]);
  });

  it("lists a day's notes, the one changed latest first, each with that day's rows, lines, saves and authors", () => {
    const [today, yesterday] = byDay(rows);
    expect(notesOf(today!.rows).map((n) => [n.noteTitle, n.rows.map((r) => r.revisions), n.added, n.removed, n.saves, n.authors.map((a) => a.name)])).toEqual([
      ["Plan", [[5], [4]], 2, 0, 2, ["Ada Lovelace", "Claude"]],
      ["Trip", [[2], [1]], 2, 0, 2, ["Claude", "Ada Lovelace"]],
    ]);
    expect(notesOf(yesterday!.rows).map((n) => [n.noteTitle, n.saves])).toEqual([["Plan", 2]]);
  });
});

describe("what stays picked when the list is narrowed", () => {
  const trip = { noteId: "trip00000000", noteTitle: "Trip" };
  const changes = [change(3, ADA, 3), change(2, CLAUDE, 2), change(1, ADA, 1), change(1, CLAUDE, 0, trip)];
  const known = (narrowing: Parameters<typeof lists>[0]) => (noteId: string, revision: number) => {
    const found = changes.find((c) => c.noteId === noteId && c.revision === revision);
    return !!found && lists(narrowing, found);
  };
  const all = only(groupSaves(changes));

  it("is every picked change the narrowing still lists: by people or agents, by note, by author", () => {
    expect(asked(kept(all, known({ by: "agents" })))).toEqual([{ noteId: "note00000000", revisions: [2] }, { noteId: "trip00000000", revisions: [1] }]);
    expect(asked(kept(all, known({ by: "people" })))).toEqual([{ noteId: "note00000000", revisions: [1, 3] }]);
    expect(asked(kept(all, known({ noteIds: ["trip00000000"] })))).toEqual([{ noteId: "trip00000000", revisions: [1] }]);
    expect(asked(kept(all, known({ authors: [{ kind: "member", id: "ada000000000" }], noteIds: ["note00000000"] })))).toEqual([{ noteId: "note00000000", revisions: [1, 3] }]);
  });

  it("is the same selection when nothing is dropped, and drops a change nothing is known of", () => {
    expect(kept(all, known({}))).toBe(all);
    expect(asked(kept(only([{ noteId: "gone00000000", revisions: [7] }]), known({})))).toEqual([]);
  });
});

describe("the changed lines of a diff that a stretch of its text marks", () => {
  const diff = textDiff("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight", "one\nTWO two\nthree\nfour\nfive\nsix\nseven\nnine\nten");
  const marksOf = (...marks: { from: number; to: number }[]) => pieces(diff, marks).flatMap((p) => (p.kind === "fold" || p.kind === "same" ? [] : [[p.kind, p.mark]]));

  it("are none with no stretch, and the pieces are as they are without", () => {
    expect(marksOf()).toEqual([["mod", undefined], ["del", undefined], ["add", undefined], ["add", undefined]]);
    expect(pieces(diff, [])).toEqual(pieces(diff));
  });

  it("are the lines rewritten when the stretch is of them, and no other change of the diff", () => {
    expect(marksOf({ from: 1, to: 2 })).toEqual([["mod", 0], ["del", undefined], ["add", undefined], ["add", undefined]]);
  });

  it("are lines taken out and the lines put in their place together, each stretch its own mark", () => {
    expect(marksOf({ from: 1, to: 2 }, { from: 8, to: 9 })).toEqual([["mod", 0], ["del", 1], ["add", 1], ["add", 1]]);
  });

  it("are lines taken out, by the place they were at", () => {
    const cut = textDiff("a\nb\nc", "a\nc");
    expect(pieces(cut, [{ from: 1, to: 1 }]).filter((p) => p.kind === "del")).toEqual([{ kind: "del", text: "b", mark: 0 }]);
    expect(pieces(cut, [{ from: 0, to: 0 }]).filter((p) => p.kind === "del")).toEqual([{ kind: "del", text: "b" }]);
  });
});
