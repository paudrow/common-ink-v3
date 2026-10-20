import { ChangeSet, Text, type ChangeSpec } from "@codemirror/state";

export const toDoc = (text: string) => Text.of(text.split("\n"));

export const applyChanges = (changes: ChangeSet, text: string) => changes.apply(toDoc(text)).toString();

/*
 * Changes are moved over one another in terminated text: the note with a newline after its last
 * line, so that every line owns the newline that ends it, and a line added or removed is one whole
 * piece at a line's start. Without it a line added above another is as much the end of the line
 * before, and moving it over a change to either lands it inside a line. A note with no text has no
 * lines.
 */

const NEWLINE = /* @__PURE__ */ Text.of(["", ""]);

export const terminated = (doc: Text) => (doc.length ? doc.append(NEWLINE) : doc);

/** A change to a note, as the same change to its terminated text. Read it with `anchored` before moving it. */
export function lift(change: ChangeSet): ChangeSet {
  const length = change.length ? change.length + 1 : 0;
  const bare = ChangeSet.of(length ? { from: length - 1, to: length } : [], length);
  return bare.compose(change).compose(ChangeSet.of(change.newLength ? { from: change.newLength, insert: "\n" } : [], change.newLength));
}

/** A change to the terminated text `doc`, as the same change to the note. */
export const lower = (change: ChangeSet, doc: Text) => unterminated(change, change.newLength > 0 && change.apply(doc).sliceString(change.newLength - 1) === "\n");

function unterminated(change: ChangeSet, ended: boolean): ChangeSet {
  const length = Math.max(change.length - 1, 0);
  const whole = ChangeSet.of(change.length ? { from: length, insert: "\n" } : [], length).compose(change);
  return whole.compose(ChangeSet.of(ended ? { from: whole.newLength - 1, to: whole.newLength } : [], whole.newLength));
}

/** A stretch of text that changed, widened to whole lines. */
interface Span {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

function spans(change: ChangeSet, a: Text, b: Text): Span[] {
  const found: Span[] = [];
  const lineEnd = (doc: Text, pos: number) => Math.min(doc.lineAt(pos).to + 1, doc.length);
  change.iterChangedRanges((fromA, toA, fromB, toB) => {
    const span: Span = { aFrom: a.lineAt(fromA).from, aTo: lineEnd(a, toA), bFrom: b.lineAt(fromB).from, bTo: lineEnd(b, toB) };
    const last = found.at(-1);
    if (last && (span.aFrom <= last.aTo || span.bFrom <= last.bTo)) {
      last.aTo = span.aTo;
      last.bTo = span.bTo;
    } else found.push(span);
  });
  return found;
}

/**
 * `change` to the terminated text `a`, read again by lines: the same text comes of it, and no part
 * of it starts or ends inside a line it leaves as it was.
 */
export function anchored(change: ChangeSet, a: Text): ChangeSet {
  const b = change.apply(a);
  return ChangeSet.of(spans(change, a, b).flatMap((span) => edits(a.sliceString(span.aFrom, span.aTo), b.sliceString(span.bFrom, span.bTo), span.aFrom)), a.length);
}

/** The edit that turns the terminated text `a` into the note text `to`, terminated. */
export function between(a: Text, to: string): ChangeSet {
  return ChangeSet.of(edits(a.toString(), to && `${to}\n`, 0), a.length);
}

/** The edit that turns `from` into `to`, as a CodeMirror change set over `from`, anchored to lines. */
export function changesBetween(from: string, to: string): ChangeSet {
  return unterminated(ChangeSet.of(edits(from && `${from}\n`, to && `${to}\n`, 0), from ? from.length + 1 : 0), to !== "");
}

const LINES = /[^\n]*\n|[^\n]+/g;
/** A word, or one character that is not part of a word. */
const WORDS = /[\p{L}\p{N}_]+|[^]/gu;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Lines that differ by more than this many are read as one rewrite, and the words of a line likewise. */
const MAX_LINES_APART = 2_000;
const MAX_WORDS_APART = 400;

/** The edit from `a` to `b`, each a terminated text or whole lines of one, placed `at` in the text `a` is from. */
function edits(a: string, b: string, at: number): ChangeSpec[] {
  if (a === b) return [];
  const linesA = a.match(LINES) ?? [];
  const linesB = b.match(LINES) ?? [];
  const specs: ChangeSpec[] = [];
  let i = 0;
  let j = 0;
  for (const [kept, gone, came] of runs(linesA, linesB, MAX_LINES_APART)) {
    for (const end = i + kept; i < end; i++) at += linesA[i]!.length;
    j += kept;
    // As many lines as before are read as those lines edited; otherwise there is no telling which became which.
    if (gone === came) for (let k = 0; k < gone; k++) at = inLine(linesA[i + k]!, linesB[j + k]!, at, specs);
    else at = inside(linesA.slice(i, i + gone).join(""), linesB.slice(j, j + came).join(""), at, specs);
    i += gone;
    j += came;
  }
  return specs;
}

/** The edit that makes one line of another, word by word, so that edits to different parts of a line are apart. Returns where `a` ends. */
function inLine(a: string, b: string, at: number, specs: ChangeSpec[]): number {
  const wordsA = a.match(WORDS) ?? [];
  const wordsB = b.match(WORDS) ?? [];
  let i = 0;
  let j = 0;
  for (const [kept, gone, came] of runs(wordsA, wordsB, MAX_WORDS_APART)) {
    for (const end = i + kept; i < end; i++) at += wordsA[i]!.length;
    j += kept;
    at = inside(wordsA.slice(i, i + gone).join(""), wordsB.slice(j, j + came).join(""), at, specs);
    i += gone;
    j += came;
  }
  return at;
}

/** One edit of text that changed: what lies between the start and the end it shares with what it became. Returns where `a` ends. */
function inside(a: string, b: string, at: number, specs: ChangeSpec[]): number {
  if (a === b) return at + a.length;
  const most = Math.min(a.length, b.length);
  let head = 0;
  while (head < most && a.charCodeAt(head) === b.charCodeAt(head)) head++;
  if (head && isHigh(a.charCodeAt(head - 1))) head--;
  let tail = 0;
  while (tail < most - head && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
  if (tail && isLow(a.charCodeAt(a.length - tail))) tail--;
  specs.push({ from: at + head, to: at + a.length - tail, insert: b.slice(head, b.length - tail) });
  return at + a.length;
}

/** A stretch of lines that differs between two texts: lines `aFrom` up to `aTo` of one are lines `bFrom` up to `bTo` of the other. Counted from 0. */
export interface LineHunk {
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
}

/** Where two lists of lines differ. */
export function lineHunks(a: string[], b: string[]): LineHunk[] {
  const hunks: LineHunk[] = [];
  let [i, j] = [0, 0];
  for (const [kept, gone, came] of runs(a, b, MAX_LINES_APART)) {
    i += kept;
    j += kept;
    if (gone || came) hunks.push({ aFrom: i, aTo: i + gone, bFrom: j, bTo: j + came });
    i += gone;
    j += came;
  }
  return hunks;
}

const MAX_STEPS = 20_000_000;
const NONE = -1;
type Run = [kept: number, gone: number, came: number];

/**
 * Which pieces stayed, went and came between two lists of them, as runs: pieces kept, then pieces
 * gone and pieces come in their place. Pieces that differ by more than `maxApart` are one rewrite.
 */
function runs(a: string[], b: string[], maxApart: number): Run[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const found = start + end === a.length && start + end === b.length ? [] : myers(a.slice(start, a.length - end), b.slice(start, b.length - end), maxApart);
  if (found.length) found[0]![0] += start;
  else found.push([start, 0, 0]);
  return end ? [...found, [end, 0, 0]] : found;
}

/** Myers' diff, given up on past its bounds so that its cost follows how much changed. */
function myers(a: string[], b: string[], maxApart: number): Run[] {
  const [n, m] = [a.length, b.length];
  const rewrite: Run[] = [[0, n, m]];
  const unmatched = new Map<string, number>();
  for (const piece of a) unmatched.set(piece, (unmatched.get(piece) ?? 0) + 1);
  let shared = 0;
  for (const piece of b) {
    const left = unmatched.get(piece);
    if (left) unmatched.set(piece, left - 1), shared++;
  }
  if (n + m - 2 * shared > maxApart) return rewrite;
  /** How far along `a` the path on diagonal `k` got after `d` edits, from how far its neighbours got after one fewer. */
  const reach = (before: Int32Array, d: number, k: number): { x: number; from: number } => {
    if (d === 0) return { x: 0, from: 0 };
    const at = (diagonal: number) => (Math.abs(diagonal) < d ? before[diagonal + d - 1]! : NONE);
    const [down, right] = [at(k + 1), at(k - 1)];
    const came = down !== NONE && down - k <= m ? down : NONE;
    const gone = right !== NONE && right < n ? right + 1 : NONE;
    return gone > came ? { x: gone, from: k - 1 } : { x: came, from: k + 1 };
  };

  const rounds: Int32Array[] = [];
  let steps = 0;
  let before = new Int32Array(0);
  for (let d = 0; d <= maxApart && steps <= MAX_STEPS; d++) {
    const round = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let { x } = reach(before, d, k);
      if (x !== NONE) {
        const from = x;
        while (x < n && x - k < m && a[x] === b[x - k]) x++;
        steps += x - from;
      }
      round[k + d] = x;
      if (x === n && x - k === m) return walkBack([...rounds, round], n, m, reach);
    }
    steps += d + 1;
    rounds.push((before = round));
  }
  return rewrite;
}

/**
 * The lines of a note, counted from 0. A newline after the last line ends that line, so it is not
 * an empty line of its own. An empty note has no lines. `ended` is whether the note ends with a newline.
 */
export function noteLines(text: string): { lines: string[]; ended: boolean } {
  if (text === "") return { lines: [], ended: false };
  const ended = text.endsWith("\n");
  const lines = text.split("\n");
  if (ended) lines.pop();
  return { lines, ended };
}

/** A replacement of whole lines. `from` is included and `to` is not, both counted from 0. `from` equal to `to` inserts, and an empty `text` deletes. */
export interface LineSplice {
  from: number;
  to: number;
  text: string;
}

/**
 * The note with `edits` applied. Every range is counted in `note` as given, so one edit does not
 * shift another. Whether the note ends with a newline stays as it was. A newline after a
 * replacement's own last line is not kept, because the replacement is lines and the note keeps its ending.
 */
export function spliceLines(note: string, edits: readonly LineSplice[]): string {
  const { lines, ended } = noteLines(note);
  const ordered = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const [i, edit] of ordered.entries()) {
    if (!Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.from > edit.to || edit.to > lines.length) throw new Error(outside(lines.length, edit));
    const next = ordered[i + 1];
    if (next && next.from < edit.to) throw new Error(`Line ranges ${edit.from} to ${edit.to} and ${next.from} to ${next.to} overlap. Every range is counted in the note as you read it, so one range is not shifted by another.`);
  }
  // Copy line by line. Passing the replacement to splice as arguments overflows the stack past about 100,000 lines.
  const next: string[] = [];
  let at = 0;
  for (const edit of ordered) {
    for (; at < edit.from; at++) next.push(lines[at]!);
    for (const line of noteLines(edit.text).lines) next.push(line);
    at = edit.to;
  }
  for (; at < lines.length; at++) next.push(lines[at]!);
  if (next.length === 0) return "";
  const body = next.join("\n");
  return ended ? `${body}\n` : body;
}

function outside(lines: number, edit: LineSplice): string {
  if (edit.from > edit.to) return `A line range stops at to, after from. ${edit.from} to ${edit.to} stops first.`;
  const count = lines === 1 ? "1 line" : `${lines} lines`;
  return `This note has ${count} at that revision, counted from 0. A range includes from and stops before to, and to may be ${lines} to add after the last line. ${edit.from} to ${edit.to} is outside that.`;
}

function walkBack(rounds: Int32Array[], n: number, m: number, reach: (before: Int32Array, d: number, k: number) => { x: number; from: number }): Run[] {
  const runs: Run[] = [];
  let [x, y] = [n, m];
  let [gone, came] = [0, 0];
  for (let d = rounds.length - 1; d >= 0; d--) {
    const k = x - y;
    const start = reach(d ? rounds[d - 1]! : rounds[0]!, d, k);
    if (x > start.x) {
      runs.push([x - start.x, gone, came]);
      [gone, came] = [0, 0];
    }
    if (d === 0) break;
    if (start.from === k - 1) gone++;
    else came++;
    x = start.from === k - 1 ? start.x - 1 : start.x;
    y = x - start.from;
  }
  if (gone || came) runs.push([0, gone, came]);
  return runs.reverse();
}
