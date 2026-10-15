import { ChangeSet, Text } from "@codemirror/state";
import { anchored, lift, terminated } from "./text.ts";

/*
 * Who wrote each line of a note: the change that last wrote or edited it. An edit inside a line, one
 * that joins it to the next or splits it, and writing it in the first place are changes to that
 * line. Lines put in or taken out around it leave it as it was. Changes are read by lines first, as
 * moving through history reads them, so a line written after another is never taken for an edit of
 * the one before.
 */

/** Each line of the terminated text `a`, made each line of `b`, which `change` turns it into: a line it writes or edits is `by`. May change `lines`, and returns the lines after. */
function relined<T>(lines: T[], change: ChangeSet, a: Text, b: Text, by: T): T[] {
  /** Lines of `a` from one up to another, and the lines of `b` they became, counted from 0. Edits of one line are one stretch. */
  const stretches: [aFrom: number, aTo: number, bFrom: number, bTo: number][] = [];
  change.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const whole = a.lineAt(fromA).from === fromA && (fromA === toA || a.sliceString(toA - 1, toA) === "\n") && (!inserted.length || inserted.sliceString(inserted.length - 1) === "\n");
    // Whole lines end where the line their end is at starts, and an edit inside lines takes in the line it ends in.
    const end = whole ? 1 : 0;
    const stretch: (typeof stretches)[number] = [a.lineAt(fromA).number - 1, a.lineAt(toA).number - end, b.lineAt(fromB).number - 1, b.lineAt(toB).number - end];
    const last = stretches.at(-1);
    if (last && stretch[0] < last[1]) [last[1], last[3]] = [Math.max(last[1], stretch[1]), Math.max(last[3], stretch[3])];
    else stretches.push(stretch);
  });
  if (stretches.every(([aFrom, aTo, bFrom, bTo]) => aTo - aFrom === bTo - bFrom)) {
    for (const [aFrom, aTo] of stretches) lines.fill(by, aFrom, aTo);
    return lines;
  }
  const after: T[] = [];
  let kept = 0;
  for (const [aFrom, aTo, bFrom, bTo] of stretches) {
    for (; kept < aFrom; kept++) after.push(lines[kept]!);
    for (let n = bFrom; n < bTo; n++) after.push(by);
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
  const after = relined([...lines, by], lifted, a, b, by);
  after.length = b.length ? b.lines - 1 : 0;
  return after;
}

/** For each line of the note that `changes` leave, top to bottom, the revision that last wrote or edited it. Revisions count the changes from 1. */
export function blame(changes: readonly ChangeSet[]): number[] {
  let doc = Text.empty;
  let lines = [0];
  for (const [i, recorded] of changes.entries()) {
    const change = anchored(lift(recorded), doc);
    const next = change.apply(doc);
    lines = relined(lines, change, doc, next, i + 1);
    doc = next;
  }
  lines.length = doc.length ? doc.lines - 1 : 0;
  return lines;
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
