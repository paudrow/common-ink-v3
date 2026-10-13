import type { ChangeSet } from "@codemirror/state";

const WORDS = /[\p{L}\p{N}_]+/gu;
/** What a todo's line says of its state and its dates, which two todos share without being alike. */
const MARKS = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]|(?<=\s)(?:every|due|done):\S+/g;
/** Past this many lines on either side the lines of a stretch are not paired, and past this many words a line's rest is not read: the cost is their product. */
const MAX_LINES = 100;
const MAX_WORDS = 64;
/** Two lines are one line edited when more than this part of their words, counted together, are shared. */
const ALIKE = 0.5;

/** A line as it is compared: its words, without the marks of a todo. */
const wordsOf = (line: string) => (line.replace(MARKS, "").match(WORDS) ?? []).slice(0, MAX_WORDS);

/** How alike two lines are, from 0 to 1: the words they share, of the words of both. */
function alike(a: string, wordsA: readonly string[], b: string, wordsB: readonly string[]): number {
  // Two lines with no words that read the same are the same line, and no reason to pass over a line with words in it.
  if (!wordsA.length || !wordsB.length) return a === b ? ALIKE + 0.01 : 0;
  const left = new Map<string, number>();
  for (const word of wordsA) left.set(word, (left.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of wordsB) {
    const has = left.get(word);
    if (has) left.set(word, has - 1), shared++;
  }
  return (2 * shared) / (wordsA.length + wordsB.length);
}

/**
 * Which line of `b` each line of `a` became, by index: pairs in order, each more than half alike,
 * chosen so that together they are as alike as can be. A line with no pair is not in the answer.
 * Null when there are too many lines to pair.
 */
export function pairedLines(a: readonly string[], b: readonly string[]): Map<number, number> | null {
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const [n, m] = [a.length, b.length];
  const [wordsA, wordsB] = [a.map(wordsOf), b.map(wordsOf)];
  const scores = a.map((line, i) => Float64Array.from(b, (other, j) => alike(line, wordsA[i]!, other, wordsB[j]!)));
  const score = (i: number, j: number) => (scores[i]![j]! > ALIKE ? scores[i]![j]! : 0);
  // best[i][j] is the most the lines from i of `a` and from j of `b` can be alike in all.
  const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, s ? s + best[i + 1]![j + 1]! : 0);
    }
  }
  const pairs = new Map<number, number>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    const s = score(i, j);
    if (s && best[i]![j] === s + best[i + 1]![j + 1]!) pairs.set(i++, j++);
    else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
  return pairs;
}

/** A stretch of whole lines that changed: `was` from `a0` to `a1` became `now` from `b0` to `b1`. */
interface Stretch {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  paired?: Map<number, number> | null;
}

const lineStart = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (text: string, pos: number) => (text.indexOf("\n", pos) === -1 ? text.length : text.indexOf("\n", pos));

/**
 * Says where a line of `was` starts in `now`, which is `was` with `changes` made: `at` is where the
 * line starts in `was`, and the answer is null when the line is gone.
 *
 * A change to other lines, or inside the one line, leaves no doubt. Where lines next to one another
 * changed together, the changes don't say which line became which: lines put in, taken out and
 * reworded in one stretch are one edit. There a line is the one it is paired with by `pairedLines`.
 * A line with no pair is at the place it had when the stretch has as many lines as before and that
 * place is no other line's, and gone otherwise. A stretch too long to pair is read by place alone.
 */
export function following(was: string, changes: ChangeSet, now: string): (at: number) => number | null {
  const stretches: Stretch[] = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const next: Stretch = { a0: lineStart(was, fromA), a1: lineEnd(was, toA), b0: lineStart(now, fromB), b1: lineEnd(now, toB) };
    const last = stretches.at(-1);
    // Changes on one line, or on lines with nothing between them, are one stretch.
    if (last && next.a0 <= last.a1 + 1) [last.a1, last.b1] = [Math.max(last.a1, next.a1), Math.max(last.b1, next.b1)];
    else stretches.push(next);
  });
  return (at) => {
    const stretch = stretches.find((s) => s.a0 <= at && at <= s.a1);
    if (!stretch) return changes.mapPos(at, 1);
    const linesA = was.slice(stretch.a0, stretch.a1).split("\n");
    const linesB = now.slice(stretch.b0, stretch.b1).split("\n");
    if (linesA.length === 1 && linesB.length === 1) return stretch.b0;
    if (stretch.paired === undefined) stretch.paired = pairedLines(linesA, linesB);
    if (stretch.paired === null) return changes.mapPos(at, 1);
    const index = was.slice(stretch.a0, at).split("\n").length - 1;
    const startOf = (line: number) => stretch.b0 + linesB.slice(0, line).reduce((length, text) => length + text.length + 1, 0);
    const pair = stretch.paired.get(index);
    if (pair !== undefined) return startOf(pair);
    return linesA.length === linesB.length && ![...stretch.paired.values()].includes(index) ? startOf(index) : null;
  };
}

/** `following` for one line. */
export const lineAfter = (was: string, changes: ChangeSet, now: string, at: number) => following(was, changes, now)(at);
