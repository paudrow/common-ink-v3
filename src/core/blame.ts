import { ChangeSet, Text } from "@codemirror/state";
import type { Reverts } from "./protocol.ts";
import { anchored, lift, terminated } from "./text.ts";
import { parseTodo } from "./todos.ts";

/*
 * Who wrote each line of a note: the change that last wrote or edited it. An edit inside a line, one
 * that joins it to the next or splits it, and writing it in the first place are changes to that
 * line. Lines put in or taken out around it leave it as it was. Changes are read by lines first, as
 * moving through history reads them, so a line written after another is never taken for an edit of
 * the one before.
 */

/** Lines of `a` from one up to another, and the lines of `b` they became, counted from 0. */
type Stretch = [aFrom: number, aTo: number, bFrom: number, bTo: number];

/** The lines of the terminated text `a` that `change` writes or edits, and the lines of `b`, which it turns `a` into, that they become. Edits of one line are one stretch. */
function stretchesOf(change: ChangeSet, a: Text, b: Text): Stretch[] {
  const stretches: Stretch[] = [];
  change.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const whole = a.lineAt(fromA).from === fromA && (fromA === toA || a.sliceString(toA - 1, toA) === "\n") && (!inserted.length || inserted.sliceString(inserted.length - 1) === "\n");
    // Whole lines end where the line their end is at starts, and an edit inside lines takes in the line it ends in.
    const end = whole ? 1 : 0;
    const stretch: Stretch = [a.lineAt(fromA).number - 1, a.lineAt(toA).number - end, b.lineAt(fromB).number - 1, b.lineAt(toB).number - end];
    const last = stretches.at(-1);
    if (last && stretch[0] < last[1]) [last[1], last[3]] = [Math.max(last[1], stretch[1]), Math.max(last[3], stretch[3])];
    else stretches.push(stretch);
  });
  return stretches;
}

/** Each line of a text, made each line of the text `stretches` turn it into: each line of that text they write is `by` it, counted from 0, and the stretch it is in. May change `lines`, and returns the lines after. */
function relined<T>(lines: T[], stretches: readonly Stretch[], by: (line: number, stretch: Stretch) => T): T[] {
  if (stretches.every(([aFrom, aTo, bFrom, bTo]) => aTo - aFrom === bTo - bFrom)) {
    for (const stretch of stretches) for (let n = stretch[0]; n < stretch[1]; n++) lines[n] = by(n, stretch);
    return lines;
  }
  const after: T[] = [];
  let kept = 0;
  for (const stretch of stretches) {
    const [aFrom, aTo, bFrom, bTo] = stretch;
    for (; kept < aFrom; kept++) after.push(lines[kept]!);
    for (let n = bFrom; n < bTo; n++) after.push(by(n, stretch));
    kept = aTo;
  }
  for (; kept < lines.length; kept++) after.push(lines[kept]!);
  return after;
}

/**
 * `lines`, one for each line of the note `before` and none for a note with no text, made one for
 * each line of the note after `change`: each line `change` writes or edits is `by`, and every other
 * line keeps what it had. May change `lines`, and returns the lines after.
 */
export function reline<T>(lines: T[], change: ChangeSet, before: Text, by: T): T[] {
  const a = terminated(before);
  const lifted = anchored(lift(change), a);
  const b = lifted.apply(a);
  // The terminated text has a line more, after the last line end, which no change writes.
  const after = relined([...lines, by], stretchesOf(lifted, a, b), () => by);
  after.length = b.length ? b.lines - 1 : 0;
  return after;
}

/** A note's recorded change, as much of it as who wrote each line needs. */
export interface Written {
  changes: ChangeSet;
  reverts: Reverts | null;
}

/** A line as it was before a change wrote over it or took it out, and the revision that had written it. */
interface Replaced {
  text: string;
  revision: number;
}

/**
 * For each line of the note that `history` leaves, top to bottom, the revision that last wrote or
 * edited it. Revisions count the changes from 1. A line a revert, undo or redo puts back as one of
 * the changes it takes out had found it is the revision that had written it then: the revert is
 * named for what it writes anew, such as a conflict settled by hand.
 */
export function blame(history: readonly Written[]): number[] {
  const takenOut = new Set(history.flatMap((h) => h.reverts?.revisions ?? []));
  const replaced = new Map<number, Replaced[]>();
  let doc = Text.empty;
  let lines = [0];
  for (const [i, { changes, reverts }] of history.entries()) {
    const change = anchored(lift(changes), doc);
    const next = change.apply(doc);
    const stretches = stretchesOf(change, doc, next);
    if (takenOut.has(i + 1)) replaced.set(i + 1, linesIn(stretches, doc, lines));
    const back = reverts && putBack([...reverts.revisions].sort((a, b) => a - b).flatMap((r) => replaced.get(r) ?? []));
    lines = relined(lines, stretches, (n) => (back && n < next.lines - 1 && back(next.line(n + 1).text)) || i + 1);
    doc = next;
  }
  lines.length = doc.length ? doc.lines - 1 : 0;
  return lines;
}

/**
 * For each line of the note that `history` leaves, top to bottom, the revision that ticked it: the
 * change that made it a done todo when it wasn't one. A change that edits a done todo and leaves it
 * done keeps the revision it had, and so does one that moves it, taking it out and writing it as it
 * was somewhere else. Every line that isn't a done todo is 0.
 */
export function tickedLines(history: readonly ChangeSet[]): number[] {
  let doc = Text.empty;
  let lines = [0];
  for (const [i, changes] of history.entries()) {
    const change = anchored(lift(changes), doc);
    const next = change.apply(doc);
    const stretches = stretchesOf(change, doc, next);
    const moved = putBack(linesIn(stretches, doc, lines).filter((line) => line.revision));
    const was = lines;
    const done = (n: number) => n < next.lines - 1 && !!parseTodo(next.line(n + 1).text)?.done;
    const kept = new Map<Stretch, (n: number) => number>();
    /** The tick an edited line keeps from the line it was. Where the change wrote as many lines as it took out, that is the line in its place. Otherwise the ticked lines it took out go to the done lines it wrote, in order, when there are as many of each, and to none when there aren't. */
    const keptBy = ([aFrom, aTo, bFrom, bTo]: Stretch) => {
      if (aTo - aFrom === bTo - bFrom) return (n: number) => was[aFrom + n - bFrom] ?? 0;
      const ticks = was.slice(aFrom, aTo).filter(Boolean);
      const written = Array.from({ length: bTo - bFrom }, (_, k) => bFrom + k).filter(done);
      return (n: number) => (ticks.length === written.length ? (ticks[written.indexOf(n)] ?? 0) : 0);
    };
    lines = relined(lines, stretches, (n, stretch) => {
      if (!done(n)) return 0;
      if (!kept.has(stretch)) kept.set(stretch, keptBy(stretch));
      return kept.get(stretch)!(n) || moved(next.line(n + 1).text) || i + 1;
    });
    doc = next;
  }
  lines.length = doc.length ? doc.lines - 1 : 0;
  return lines;
}

/** The lines of the terminated text `doc` that `stretches` write over or take out, as they are, each with the revision `lines` has for it. */
function linesIn(stretches: readonly Stretch[], doc: Text, lines: readonly number[]): Replaced[] {
  // The terminated text's line after its last line end is no line of the note.
  return stretches.flatMap(([aFrom, aTo]) => lines.slice(aFrom, Math.min(aTo, doc.lines - 1)).map((revision, n) => ({ text: doc.line(aFrom + n + 1).text, revision })));
}

/** The revision that had written a line a revert puts back, from the lines the changes it takes out replaced, each of them once and the earliest first: none for a line none of them had. */
function putBack(replaced: readonly Replaced[]): (text: string) => number | undefined {
  const byText = Map.groupBy(replaced, (line) => line.text);
  return (text) => byText.get(text)?.shift()?.revision;
}

/** Lines that one change last wrote, from one line to another, counted from 1. */
export interface LineRun {
  from: number;
  to: number;
  revision: number;
}

/** Lines next to each other that one revision wrote, as one run each. */
export function runsOfLines(lines: readonly number[]): LineRun[] {
  const runs: LineRun[] = [];
  for (const [i, revision] of lines.entries()) {
    const last = runs.at(-1);
    if (last?.revision === revision) last.to = i + 1;
    else runs.push({ from: i + 1, to: i + 1, revision });
  }
  return runs;
}
