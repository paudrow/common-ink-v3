import type { ChangeSet } from "@codemirror/state";
import type { Diff, DiffLine, Hunk } from "./protocol.ts";
import { changesBetween, toDoc } from "./text.ts";

const CONTEXT = 2;
export const MAX_DIFF_LINES = 200;

/** Changed lines, as half-open ranges of line indexes before (`a`) and after (`b`). */
interface Span {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

/** What `change` did to `before`, as a line diff. */
export function lineDiff(before: string, change: ChangeSet): Diff {
  const a = toDoc(before);
  const b = change.apply(a);
  const lineA = (i: number) => a.line(i + 1).text;
  const lineB = (i: number) => b.line(i + 1).text;

  const spans: Span[] = [];
  change.iterChangedRanges((fromA, toA, fromB, toB) => {
    const span = { aFrom: a.lineAt(fromA).number - 1, aTo: a.lineAt(toA).number, bFrom: b.lineAt(fromB).number - 1, bTo: b.lineAt(toB).number };
    const last = spans.at(-1);
    if (last && (span.aFrom < last.aTo || span.bFrom < last.bTo)) {
      last.aTo = span.aTo;
      last.bTo = span.bTo;
    } else spans.push(span);
  });
  // A change inside a line names the whole line, and one at a line's edge names its unchanged neighbour.
  for (const s of spans) {
    // An empty note has no lines to remove or add, though its text counts as one empty line.
    if (!before) s.aTo = s.aFrom;
    if (!b.length) s.bTo = s.bFrom;
    while (s.aFrom < s.aTo && s.bFrom < s.bTo && lineA(s.aFrom) === lineB(s.bFrom)) s.aFrom++, s.bFrom++;
    while (s.aFrom < s.aTo && s.bFrom < s.bTo && lineA(s.aTo - 1) === lineB(s.bTo - 1)) s.aTo--, s.bTo--;
  }
  const changed = spans.filter((s) => s.aFrom < s.aTo || s.bFrom < s.bTo);

  const diff: Diff = { hunks: [], added: 0, removed: 0, omitted: 0, lines: before ? a.lines : 0 };
  let hunk: Hunk | null = null;
  let shownTo = 0;
  let room = MAX_DIFF_LINES;
  const push = (kind: DiffLine["kind"], text: string) => {
    if (room-- > 0) hunk!.lines.push({ kind, text });
    else diff.omitted++;
  };
  changed.forEach((s, i) => {
    const from = Math.max(s.aFrom - CONTEXT, 0);
    if (!hunk || from > shownTo) {
      hunk = { oldStart: from + 1, newStart: from + s.bFrom - s.aFrom + 1, lines: [] };
      diff.hunks.push(hunk);
      shownTo = from;
    }
    for (let l = shownTo; l < s.aFrom; l++) push("same", lineA(l));
    for (let l = s.aFrom; l < s.aTo; l++) push("del", lineA(l));
    for (let l = s.bFrom; l < s.bTo; l++) push("add", lineB(l));
    diff.removed += s.aTo - s.aFrom;
    diff.added += s.bTo - s.bFrom;
    shownTo = Math.min(s.aTo + CONTEXT, before ? a.lines : 0, changed[i + 1]?.aFrom ?? Infinity);
    for (let l = s.aTo; l < shownTo; l++) push("same", lineA(l));
  });
  diff.hunks = diff.hunks.filter((h) => h.lines.length);
  return diff;
}

/** What turned `before` into `after`, as a line diff of the two: lines written and taken out again on the way are in neither. */
export const textDiff = (before: string, after: string): Diff => lineDiff(before, changesBetween(before, after));
