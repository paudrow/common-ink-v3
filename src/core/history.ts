import { ChangeSet, Text } from "@codemirror/state";
import type { Reverts } from "./protocol.ts";
import { changesBetween } from "./text.ts";

/** A recorded change, as much of it as moving through history needs. */
export interface Step {
  revision: number;
  reverts: Reverts | null;
}

/**
 * The change that takes `revisions` back out of a note and keeps every other change. `changes` are
 * the note's changes from revision 1 on. Taking out everything after a revision gives exactly the
 * text at that revision.
 */
export function takeOut(changes: readonly ChangeSet[], revisions: ReadonlySet<number>): ChangeSet {
  let doc = Text.empty;
  /** The note with the chosen changes so far left out. */
  let kept = doc;
  let drop = ChangeSet.empty(0);
  changes.forEach((change, i) => {
    const next = change.apply(doc);
    if (!revisions.has(i + 1)) kept = kept === doc ? next : change.map(drop).apply(kept);
    doc = next;
    // Read again as the smallest edit between the two texts. A change left out together with the one
    // that undid it then leaves no trace, where composing their inverses would rewrite that text in
    // place and misplace a later change made inside it.
    drop = kept === doc ? ChangeSet.empty(doc.length) : changesBetween(doc.toString(), kept.toString());
  });
  return drop;
}

/** For each change that was taken back out, the later change that did it and still stands itself. */
export function revertedBy(steps: readonly Step[]): Map<number, number> {
  const by = new Map<number, number>();
  for (const step of [...steps].sort((a, b) => b.revision - a.revision)) {
    // A revert that was itself taken back out no longer takes anything out.
    if (!step.reverts || by.has(step.revision)) continue;
    for (const revision of step.reverts.revisions) if (!by.has(revision)) by.set(revision, step.revision);
  }
  return by;
}

/** A recorded change with its diff. */
export interface Recorded extends Step {
  changes: ChangeSet;
}

/**
 * The change that `reverts` records: it leaves the note holding the edits that still stand once it is
 * recorded, and nothing else. Every change that took others out is left out with the edits that are
 * gone, so the text follows the record however often a change has been taken out and put back.
 */
export function takeBackOut(history: readonly Recorded[], reverts: Reverts): ChangeSet {
  const gone = revertedBy([...history, { revision: history.length + 1, reverts }]);
  return takeOut(history.map((c) => c.changes), new Set(history.filter((c) => c.reverts || gone.has(c.revision)).map((c) => c.revision)));
}

/** The author's latest change that still stands and isn't itself an undo: what undo takes back. */
export function undoTarget(mine: readonly Step[], reverted: ReadonlyMap<number, number>): number | null {
  return mine.findLast((s) => !reverted.has(s.revision) && s.reverts?.how !== "undo")?.revision ?? null;
}

/** The author's latest undo that still stands, unless they have edited since: what redo takes back. */
export function redoTarget(mine: readonly Step[], reverted: ReadonlyMap<number, number>): number | null {
  const undo = mine.findLast((s) => !reverted.has(s.revision) && s.reverts?.how === "undo");
  if (!undo) return null;
  const editedSince = mine.some((s) => s.revision > undo.revision && s.reverts?.how !== "undo" && s.reverts?.how !== "redo");
  return editedSince ? null : undo.revision;
}

/** The calendar day a time falls on in a zone, as YYYY-MM-DD. Throws a RangeError for a zone that doesn't exist. */
export function dayIn(timeZone: string): (time: number) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (time) => {
    const parts = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}
