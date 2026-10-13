import { describe, expect, it } from "vitest";
import { textDiff } from "../../src/core/diff.ts";
import type { Author, HistoryEntry, Reverts } from "../../src/core/protocol.ts";
import { MOST_OF_A_NOTE, NOTHING, asked, dayLabel, did, groupSaves, initials, only, picked, pieces, sameSelection, sizeOf, who, within, withRows } from "../../src/web/plugins/lib/historyView.ts";

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
