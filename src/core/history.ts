import { ChangeSet, Text } from "@codemirror/state";
import type { Reverts } from "./protocol.ts";
import { anchored, between, lift, lower, terminated, toDoc } from "./text.ts";

/** A recorded change, as much of it as moving through history needs. */
export interface Step {
  revision: number;
  reverts: Reverts | null;
}

/** One recorded change as moving through history reads it: by lines, over the terminated text before it. */
interface Made {
  revision: number;
  change: ChangeSet;
  doc: Text;
  next: Text;
}

/** A note's recorded changes in order, the first of them made to the terminated text `doc`. */
function* replayed(changes: readonly ChangeSet[], doc = Text.empty): Generator<Made> {
  for (const [i, recorded] of changes.entries()) {
    const change = anchored(lift(recorded), doc);
    const next = change.apply(doc);
    yield { revision: i + 1, change, doc, next };
    doc = next;
  }
}

/** The change that leaves some of a note's changes out of its text, as far as the note has been replayed. */
interface Left {
  drop: ChangeSet;
  /** Whether changes were left out since `drop` was last read as one edit. */
  loose: boolean;
}

const ALL_KEPT: Left = { drop: ChangeSet.empty(0), loose: false };

/**
 * What is left out, read as one edit of the text `doc`. A change left out together with the one that
 * undid it then leaves no trace, where their inverses composed rewrite that text in place and would
 * misplace a later change made inside it.
 */
const settled = (left: Left, doc: Text) => (left.loose ? anchored(left.drop, doc) : left.drop);

interface Edit {
  from: number;
  to: number;
  insert: Text;
}

function editsOf(change: ChangeSet): Edit[] {
  const edits: Edit[] = [];
  change.iterChanges((from, to, _fromB, _toB, insert) => edits.push({ from, to, insert }));
  return edits;
}

const endsLine = (text: Text) => text.sliceString(text.length - 1) === "\n";

/** `change` with a line end after whatever it writes inside lines that `other` removes whole. Both are changes to the terminated text `doc`. */
function ownLines(change: ChangeSet, other: ChangeSet, doc: Text): ChangeSet {
  const removed = editsOf(other).filter((e) => e.from < e.to);
  if (!removed.length) return change;
  let found = false;
  const edits = editsOf(change).map((e) => {
    if (!e.insert.length || endsLine(e.insert)) return e;
    const [from, to] = [doc.lineAt(e.from).from, Math.min(doc.lineAt(e.to).to + 1, doc.length)];
    if (!removed.some((r) => r.from <= from && to <= r.to)) return e;
    found = true;
    return { ...e, insert: e.insert.append(Text.of(["", ""])) };
  });
  return found ? ChangeSet.of(edits, doc.length) : change;
}

/**
 * `mine` moved over `theirs`, both changes to the terminated text `doc`, so that it applies after
 * it. Where both write at one place, mine goes first. What either wrote inside a line the other
 * removed whole stays, as a line of its own where that line was: never joined to the line after.
 */
function over(mine: ChangeSet, theirs: ChangeSet, doc: Text): ChangeSet {
  const [kept, made] = [ownLines(mine, theirs, doc), ownLines(theirs, mine, doc)];
  if (made === theirs) return kept.map(theirs, true);
  return anchored(theirs.invert(doc).compose(kept).compose(made.map(kept)), theirs.apply(doc));
}

/** `left` is for the text before `made`. This is it for the text after, with `made` left out too or kept. */
function leaving(left: Left, { change, doc }: Made, out: boolean): Left {
  if (out) return { drop: change.invert(doc).compose(left.drop), loose: true };
  return { drop: over(settled(left, doc), change, doc), loose: false };
}

/**
 * The change that takes `revisions` back out of a note and keeps every other change. `changes` are
 * the note's changes from revision 1 on. Taking out everything after a revision gives exactly the
 * text at that revision.
 */
export function takeOut(changes: readonly ChangeSet[], revisions: ReadonlySet<number>): ChangeSet {
  let doc = Text.empty;
  let left = ALL_KEPT;
  for (const made of replayed(changes)) {
    left = leaving(left, made, revisions.has(made.revision));
    doc = made.next;
  }
  return lower(settled(left, doc), doc);
}

/**
 * The edit that turns `base` into `text`, moved over the changes made to `base` since. Where it and
 * one of them insert at the same place, its insertion goes first: it stays next to the text it was
 * typed after.
 */
export function rebased(base: string, text: string, since: readonly ChangeSet[]): ChangeSet {
  let doc = terminated(toDoc(base));
  let mine = between(doc, text);
  for (const made of replayed(since, doc)) {
    mine = over(mine, made.change, doc);
    doc = made.next;
  }
  return lower(mine, doc);
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

/** The changes a note's text leaves out, once `reverts` is recorded if it is given: every change that took others out, and the edits that are gone. */
function leftOut(history: readonly Step[], reverts?: Reverts): Set<number> {
  const gone = revertedBy(reverts ? [...history, { revision: history.length + 1, reverts }] : history);
  return new Set(history.filter((c) => c.reverts || gone.has(c.revision)).map((c) => c.revision));
}

/**
 * The change that `reverts` records: it leaves the note holding the edits that still stand once it is
 * recorded, and nothing else. Every change that took others out is left out with the edits that are
 * gone, so the text follows the record however often a change was reverted and that revert reverted.
 */
export function takeBackOut(history: readonly Recorded[], reverts: Reverts): ChangeSet {
  return takeOut(history.map((c) => c.changes), leftOut(history, reverts));
}

/**
 * The lines of `doc` an edit changes, first and last. Whole lines put in or taken out change no line
 * that stays, and an edit that takes out the end of a line changes the line after it too.
 */
function linesOf(edit: Edit, doc: Text): [number, number] | null {
  const first = doc.lineAt(edit.from);
  const whole = edit.from === first.from && (edit.from === edit.to || doc.sliceString(edit.to - 1, edit.to) === "\n") && (!edit.insert.length || endsLine(edit.insert));
  if (!whole) return [first.number, doc.lineAt(edit.to).number];
  return edit.from < edit.to ? [first.number, doc.lineAt(edit.to - 1).number] : null;
}

/**
 * The later changes that still stand and edited lines `reverts` would change: lines of a change it
 * takes out, or lines where a change it has stand again was made. Reverting leaves what those
 * changes did in place, on a line that otherwise returns to how it was.
 */
export function overlapping(history: readonly Recorded[], reverts: Reverts): number[] {
  const was = leftOut(history);
  const will = leftOut(history, reverts);
  const overlaps: number[] = [];
  let [standing, reverted] = [ALL_KEPT, ALL_KEPT];
  for (const made of replayed(history.map((c) => c.changes))) {
    const [outWas, outWill] = [was.has(made.revision), will.has(made.revision)];
    if (standing !== reverted && !outWas && !outWill) {
      // The text as it stands and as it would be differ where the two leave different things out of the text this change was made to.
      const [now, then] = [standing, reverted].map((left) => new Map(editsOf(settled(left, made.doc)).map((e) => [`${e.from}:${e.to}`, e])));
      const same = (e: Edit, others: Map<string, Edit>) => others.get(`${e.from}:${e.to}`)?.insert.eq(e.insert) ?? false;
      const moved = [...[...now!.values()].filter((e) => !same(e, then!)), ...[...then!.values()].filter((e) => !same(e, now!))].flatMap((e) => [linesOf(e, made.doc) ?? []]);
      const edited = editsOf(made.change).flatMap((e) => [linesOf(e, made.doc) ?? []]);
      if (edited.some(([from, to]) => moved.some(([first, last]) => from! <= last! && first! <= to!))) overlaps.push(made.revision);
    }
    const next = leaving(standing, made, outWas);
    reverted = standing === reverted && outWas === outWill ? next : leaving(reverted, made, outWill);
    standing = next;
  }
  return overlaps;
}

/**
 * What reverting an author records: every change of theirs but the ones somebody else took out and
 * left out. Their own undos and reverts are named too, so nothing they took out of their own comes
 * back and what they took out of others' does. Null when the note would hold the same edits after.
 */
export function revertOfAuthor<S extends Step>(steps: readonly S[], isTheirs: (step: S) => boolean): Reverts | null {
  const gone = new Set<number>();
  for (const step of [...steps].sort((a, b) => b.revision - a.revision)) {
    if (!step.reverts || gone.has(step.revision) || isTheirs(step)) continue;
    for (const revision of step.reverts.revisions) gone.add(revision);
  }
  const reverts: Reverts = { how: "revert", revisions: steps.filter((s) => isTheirs(s) && !gone.has(s.revision)).map((s) => s.revision).sort((a, b) => a - b) };
  const edits = (all: readonly Step[]) => {
    const out = revertedBy(all);
    return all.filter((s) => !s.reverts && !out.has(s.revision)).map((s) => s.revision).join();
  };
  return edits(steps) === edits([...steps, { revision: steps.length + 1, reverts }]) ? null : reverts;
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
