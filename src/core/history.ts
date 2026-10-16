import { ChangeSet, Text } from "@codemirror/state";
import type { Reverts } from "./protocol.ts";
import { anchored, applyChanges, between, changesBetween, lift, lineHunks, lower, terminated, toDoc } from "./text.ts";

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

const NO_TEXT_ENDED = Text.of(["", ""]);
const ALL_KEPT: Left = { drop: ChangeSet.empty(0), loose: false };

/**
 * What is left out, read as one edit of the text `doc`. A change left out together with the one that
 * undid it then leaves no trace, where their inverses composed rewrite that text in place and would
 * misplace a later change made inside it.
 */
function settled(left: Left, doc: Text): ChangeSet {
  const drop = whole(left.drop, doc);
  if (!left.loose && drop === left.drop) return drop;
  // Text taken out and written again the same is no change, and read as one it would be moved over later changes as an edit of those lines.
  return drop.apply(doc).eq(doc) ? ChangeSet.empty(doc.length) : anchored(drop, doc);
}

/**
 * `drop` leaving terminated text: every line with its line end, and a note with no text with no
 * lines. Left otherwise, a line written after it later would be joined to its last line, or follow
 * an empty one.
 */
function whole(drop: ChangeSet, doc: Text): ChangeSet {
  let atEnd = false;
  drop.iterChangedRanges((_from, to) => void (atEnd ||= to === doc.length));
  if (!atEnd) return drop;
  const left = drop.apply(doc);
  if (left.eq(NO_TEXT_ENDED)) return ChangeSet.of(doc.length ? { from: 0, to: doc.length } : [], doc.length);
  return !left.length || endsLine(left) ? drop : drop.compose(ChangeSet.of({ from: left.length, insert: "\n" }, left.length));
}

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

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const WORD_RUNS = /[\p{L}\p{N}\p{M}_]+/gu;
const STARTS_WORD = /^[\p{L}\p{N}\p{M}_]/u;
const ENDS_WORD = /[\p{L}\p{N}\p{M}_]$/u;

/** Whether the character at `pos` of `doc` is part of a word. */
function wordAt(doc: Text, pos: number): boolean {
  if (pos < 0 || pos >= doc.length) return false;
  const code = doc.sliceString(pos, pos + 1).charCodeAt(0);
  const low = code >= 0xdc00 && code <= 0xdfff;
  const high = code >= 0xd800 && code <= 0xdbff;
  return WORD_CHAR.test(doc.sliceString(low ? pos - 1 : pos, high ? pos + 2 : pos + 1));
}

/** Whether an edit puts in or takes out whole lines of `doc`, and changes no line that stays. */
function wholeLines(edit: Edit, doc: Text): boolean {
  if (edit.from !== doc.lineAt(edit.from).from) return false;
  return (edit.from === edit.to || doc.sliceString(edit.to - 1, edit.to) === "\n") && (!edit.insert.length || endsLine(edit.insert));
}

/**
 * What an edit is an edit of. `lines`: whole lines put in or taken out. `words`: text inside one
 * line, with the rest of each word it changes. `block`: text that starts or ends inside a line and
 * reaches or writes past a line end, where the edit doesn't say which line became which.
 */
interface Reach {
  kind: "lines" | "words" | "block";
  from: number;
  to: number;
  /** `from` and `to` with the words that touch them. */
  near: [from: number, to: number];
  /** The edit itself. */
  edit: Edit;
}

function reachOf(edit: Edit, doc: Text): Reach {
  let { from, to } = edit;
  if (wholeLines(edit, doc)) return { kind: "lines", from, to, near: [from, to], edit };
  const near: Reach["near"] = [from, to];
  while (wordAt(doc, near[0] - 1)) near[0]--;
  while (wordAt(doc, near[1])) near[1]++;
  if (wordAt(doc, from - 1) && (wordAt(doc, from) || STARTS_WORD.test(edit.insert.sliceString(0, 2)))) from = near[0];
  if (wordAt(doc, to) && (wordAt(doc, to - 1) || ENDS_WORD.test(edit.insert.sliceString(Math.max(edit.insert.length - 2, 0))))) to = near[1];
  if (doc.lineAt(edit.from).number !== doc.lineAt(edit.to).number || edit.insert.lines > 1) return { kind: "block", from, to, near, edit };
  return { kind: "words", from, to, near, edit };
}

/** Whether `left` and `right`, where what `left` is an edit of ends at the place `right` starts, leave one word across that place. */
function joined(left: Reach, right: Reach, doc: Text): boolean {
  if (left.to !== right.from) return false;
  const [l, r] = [left.edit, right.edit];
  // A word either of them leaves there, or took out from there, is a word the other one's text was part of.
  const ends = wordAt(doc, left.to - 1) || (l.to === left.to && (l.insert.length ? ENDS_WORD.test(l.insert.sliceString(Math.max(l.insert.length - 2, 0))) : wordAt(doc, l.from - 1)));
  return ends && (wordAt(doc, left.to) || (r.from === left.to && (r.insert.length ? STARTS_WORD.test(r.insert.sliceString(0, 2)) : wordAt(doc, r.to))));
}

/** Whether `a`, an edit of mine, and `b`, an edit of theirs to the same text, are edits of the same lines or words of it, so that mine can't be made to what theirs leaves. */
function collide(a: Reach, b: Reach, doc: Text): boolean {
  // Lines theirs wrote where mine would write the same lines are those lines, back already.
  if (a.kind === "lines" && b.kind === "lines") return a.from < a.to && b.from < b.to ? a.from < b.to && b.from < a.to : a.from === b.from && a.to === b.to && a.edit.insert.eq(b.edit.insert);
  if (a.kind === "lines" || b.kind === "lines") {
    const [lines, part] = a.kind === "lines" ? [a, b] : [b, a];
    // Lines put in are lines only while the line end before them stays.
    if (lines.from === lines.to) return part.edit.from < lines.from && lines.from <= part.edit.to;
    return part.from < lines.to && lines.from <= part.to;
  }
  // Text next to a block of mine may be of any line of it, and so may a place next to a block of theirs.
  if (a.kind === "block") return a.from <= b.to && b.from <= a.to;
  if (b.kind === "block") {
    if (a.from === a.to) return b.from <= a.from && a.from <= b.to;
    if (a.from < b.to && b.from < a.to) return true;
    return joined(a, b, doc) || joined(b, a, doc);
  }
  if (a.from === a.to || b.from === b.to) {
    const [point, other] = a.from === a.to ? [a, b] : [b, a];
    if (other.from < point.from && point.from < other.to) return true;
    // Where theirs wrote at the place mine would write, what mine gives back may be what they wrote, and which goes first is not known.
    if (a.edit.to === b.edit.from && a.edit.from === b.edit.to) return true;
  } else if (a.from < b.to && b.from < a.to) return true;
  return false;
}

/** Whether making both mine and theirs, edits to the words of one line of `doc`, leaves a word that neither mine alone nor theirs alone leaves: two words run together, or a word in two. */
function runTogether(mine: Edit[], theirs: Edit[], line: { from: number; to: number }, doc: Text): boolean {
  const text = Text.of([doc.sliceString(line.from, line.to)]);
  const [a, b] = [mine, theirs].map((edits) => ChangeSet.of(edits.map((e) => ({ from: e.from - line.from, to: e.to - line.from, insert: e.insert })), text.length));
  const after = b!.apply(text);
  const words = (of: Text) => of.toString().match(WORD_RUNS) ?? [];
  const known = new Set([...words(a!.apply(text)), ...words(after)]);
  return words(a!.map(b!).apply(after)).some((word) => !known.has(word));
}

/**
 * `drop` without its edits of text that `change` edited too, both changes to the terminated text
 * `doc`. Taking a change out gives back what it replaced only where what it wrote still stands as
 * written: a word or a line that `change` edited or removed is no longer that text, and a piece of
 * the old text put there would be part of neither. A line with such a word is left whole as it is.
 * Of whole lines taken out, the ones `change` edited stay and the rest go, and a block is read as
 * its lines taken out and the lines it replaced put in whole.
 */
function untouched(drop: ChangeSet, change: ChangeSet, doc: Text): ChangeSet {
  const theirs = editsOf(change).map((e) => reachOf(e, doc));
  if (!theirs.length || drop.empty) return drop;
  // Blocks and words are not in the order of where they reach to, so what bounds the search is kept beside them.
  const ends = theirs.map((r) => r.near[1]);
  for (let i = 1; i < ends.length; i++) ends[i] = Math.max(ends[i]!, ends[i - 1]!);
  const starts = theirs.map((r) => r.near[0]);
  for (let i = starts.length - 2; i >= 0; i--) starts[i] = Math.min(starts[i]!, starts[i + 1]!);
  const hit = (edit: Edit) => {
    const mine = reachOf(edit, doc);
    let [lo, hi] = [0, theirs.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid]! < mine.near[0]) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < theirs.length && starts[i]! <= mine.near[1]; i++) if (collide(mine, theirs[i]!, doc)) return mine;
    return null;
  };
  const lineEnd = (pos: number) => Math.min(doc.lineAt(pos).to + 1, doc.length);
  /** Whole lines taken out, each as an edit of its own. */
  const lines = (from: number, to: number) => {
    const each: Edit[] = [];
    for (; from < to; from = each.at(-1)!.to) each.push({ from, to: lineEnd(from), insert: Text.empty });
    return each;
  };
  /** The lines with an edit to their words that is not made. */
  const asIs = new Set<number>();
  /** Theirs to the words of each line, and mine that are made so far. */
  const words = new Map<number, { theirs: Edit[]; mine: Edit[] }>();
  for (const { kind, edit } of theirs) {
    if (kind !== "words") continue;
    const line = doc.lineAt(edit.from).number;
    words.set(line, { theirs: [...(words.get(line)?.theirs ?? []), edit], mine: [] });
  }
  let found = false;
  const kept = editsOf(drop).flatMap((edit): Edit[] => {
    const mine = hit(edit);
    if (!mine) {
      if (words.size && !wholeLines(edit, doc) && doc.lineAt(edit.from).number === doc.lineAt(edit.to).number && edit.insert.lines === 1) words.get(doc.lineAt(edit.from).number)?.mine.push(edit);
      return [edit];
    }
    found = true;
    if (mine.kind === "words") asIs.add(doc.lineAt(edit.from).number);
    else if (mine.kind === "block") {
      const [from, to] = [doc.lineAt(edit.from).from, lineEnd(edit.to)];
      const put: Edit = { from, to: from, insert: doc.slice(from, edit.from).append(edit.insert).append(doc.slice(edit.to, to)) };
      return [put, ...lines(from, to)].filter((piece) => !hit(piece));
    } else if (!edit.insert.length) return lines(edit.from, edit.to).filter((line) => !hit(line));
    return [];
  });
  for (const [line, both] of words) {
    if (!both.mine.length || asIs.has(line) || !runTogether(both.mine, both.theirs, doc.line(line), doc)) continue;
    asIs.add(line);
    found = true;
  }
  if (!found) return drop;
  const stays = (edit: Edit) => asIs.size > 0 && !wholeLines(edit, doc) && asIs.has(doc.lineAt(edit.from).number);
  return ChangeSet.of(kept.filter((edit) => !stays(edit)), doc.length);
}

/** `drop`, a change to the terminated text `doc` that edits nothing `change` edited, moved over `change`: a line it puts in where `change` wrote goes before, and words go after, with the line they are words of. */
function moved(drop: ChangeSet, change: ChangeSet, doc: Text): ChangeSet {
  const edits = editsOf(drop);
  const whole = edits.map((e) => wholeLines(e, doc));
  if (whole.every((w) => w) || !whole.some((w) => w)) return drop.map(change, whole[0] ?? true);
  const [lines, words] = [true, false].map((which) => ChangeSet.of(edits.filter((_, i) => whole[i] === which), doc.length).map(change, which));
  return lines!.compose(words!.map(lines!));
}

/** `left` is for the text before `made`. This is it for the text after, with `made` left out too or kept. */
function leaving(left: Left, { change, doc }: Made, out: boolean): Left {
  if (out) return { drop: change.invert(doc).compose(left.drop), loose: true };
  return { drop: moved(untouched(settled(left, doc), change, doc), change, doc), loose: false };
}

/**
 * The change that takes `revisions` back out of a note and keeps every other change. `changes` are
 * the note's changes from revision 1 on. Taking out everything after a revision gives exactly the
 * text at that revision.
 */
export function takeOut(changes: readonly ChangeSet[], revisions: ReadonlySet<number>): ChangeSet {
  return takeOutWith(changes, revisions, new Map());
}

/** For a change, which of its edits as `replayed` reads them, counted from 0. */
type EditsOf = ReadonlyMap<number, ReadonlySet<number>>;

/** `left` for the text after `made`, with the edits of it named in `some` left out and the rest of it kept: the change as two, the edits that stay and then the ones taken out. */
function leavingSome(left: Left, made: Made, some: ReadonlySet<number>): Left {
  const edits = editsOf(made.change);
  const rest = ChangeSet.of(edits.filter((_, i) => !some.has(i)), made.doc.length);
  const between = rest.apply(made.doc);
  const taken = ChangeSet.of(edits.filter((_, i) => some.has(i)), made.doc.length).map(rest);
  return leaving(leaving(left, { ...made, change: rest, next: between }, false), { ...made, change: taken, doc: between }, true);
}

/** `takeOut`, with the edits named in `also` taken out of changes that are otherwise kept: those edits alone, and the rest of each change stays. */
function takeOutWith(changes: readonly ChangeSet[], revisions: ReadonlySet<number>, also: EditsOf): ChangeSet {
  let doc = Text.empty;
  let left = ALL_KEPT;
  for (const made of replayed(changes)) {
    const out = revisions.has(made.revision);
    const some = out ? undefined : also.get(made.revision);
    left = some ? leavingSome(left, made, some) : leaving(left, made, out);
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

/**
 * Of the changes picked for one revert, the ones it takes out, and the ones left be because a change
 * that is not picked already took them out. A change picked together with the change that took it
 * out stays out, and that change goes too: the note is as if neither had been made.
 */
export function revertible(steps: readonly Step[], picked: Iterable<number>): { revisions: number[]; already: number[] } {
  const gone = revertedBy(steps);
  const all = new Set(picked);
  const sorted = [...all].sort((a, b) => a - b);
  const already = sorted.filter((r) => gone.has(r) && !all.has(gone.get(r)!));
  return { revisions: sorted.filter((r) => !already.includes(r)), already };
}

/** Picked changes of one note that follow one another. `skipped` is how many of the note's changes lie between this run and the one before it. */
export interface Run {
  from: number;
  to: number;
  skipped: number;
}

/** The runs a note's picked changes make, earliest first. */
export function runsOf(picked: Iterable<number>): Run[] {
  const runs: Run[] = [];
  for (const revision of [...new Set(picked)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && revision === last.to + 1) last.to = revision;
    else runs.push({ from: revision, to: revision, skipped: last ? revision - last.to - 1 : 0 });
  }
  return runs;
}

/**
 * What a revert did besides taking changes out, when the person reverting chose what became of
 * lines later changes had edited: `reverted` takes the changes out and keeps every later edit, as a
 * revert with nothing chosen does, and `edit` is what they chose, made to the text that leaves.
 * The two composed are the change as recorded.
 */
export interface Resolution {
  reverted: ChangeSet;
  edit: ChangeSet;
}

/** A recorded change with its diff. */
export interface Recorded extends Step {
  changes: ChangeSet;
  resolution?: Resolution | null;
}

/**
 * One change as moving through history replays it. A revert with a resolution is two: the revert,
 * and after it the resolution, which stands as an edit does until that revert is itself reverted.
 */
interface Part {
  revision: number;
  change: ChangeSet;
  chosen: boolean;
}

const partsOf = (history: readonly Recorded[]): Part[] =>
  history.flatMap(({ revision, changes, resolution }) =>
    resolution
      ? [
          { revision, change: resolution.reverted, chosen: false },
          { revision, change: resolution.edit, chosen: true },
        ]
      : [{ revision, change: changes, chosen: false }],
  );

/** The parts a note's text leaves out, numbered from 1, once `reverts` is recorded if it is given: every change that took others out, and the edits that are gone. */
function leftOut(history: readonly Step[], parts: readonly Part[], reverts?: Reverts): Set<number> {
  const gone = revertedBy(reverts ? [...history, { revision: history.length + 1, reverts }] : history);
  const out = new Set<number>();
  for (const [i, part] of parts.entries()) if (gone.has(part.revision) || (!part.chosen && history[part.revision - 1]!.reverts)) out.add(i + 1);
  return out;
}

/**
 * The change that `reverts` records: it leaves the note holding the edits that still stand once it is
 * recorded, and nothing else. Every change that took others out is left out with the edits that are
 * gone, so the text follows the record however often a change was reverted and that revert reverted.
 */
export function takeBackOut(history: readonly Recorded[], reverts: Reverts): ChangeSet {
  const parts = partsOf(history);
  return takeOut(parts.map((p) => p.change), leftOut(history, parts, reverts));
}

/**
 * The lines of `doc` an edit changes, first and last. Whole lines put in or taken out change no line
 * that stays, and an edit that takes out the end of a line changes the line after it too.
 */
function linesOf(edit: Edit, doc: Text): [number, number] | null {
  const first = doc.lineAt(edit.from).number;
  if (!wholeLines(edit, doc)) return [first, doc.lineAt(edit.to).number];
  return edit.from < edit.to ? [first, doc.lineAt(edit.to - 1).number] : null;
}

/**
 * The later changes that still stand and edited lines `reverts` would change: lines of a change it
 * takes out, or lines where a change it has stand again was made. Reverting leaves what those
 * changes did in place, on a line that otherwise returns to how it was.
 */
export function overlapping(history: readonly Recorded[], reverts: Reverts): number[] {
  const parts = partsOf(history);
  return [...new Set([...overlappingEdits(parts, leftOut(history, parts), leftOut(history, parts, reverts)).keys()].map((n) => parts[n - 1]!.revision))];
}

/** For each part that overlaps a revert, its edits that do. `was` and `will` are the parts left out before the revert and after. */
function overlappingEdits(parts: readonly Part[], was: ReadonlySet<number>, will: ReadonlySet<number>): Map<number, Set<number>> {
  const overlaps = new Map<number, Set<number>>();
  let [standing, reverted] = [ALL_KEPT, ALL_KEPT];
  for (const made of replayed(parts.map((p) => p.change))) {
    const [outWas, outWill] = [was.has(made.revision), will.has(made.revision)];
    if (standing !== reverted && !outWas && !outWill) {
      // The text as it stands and as it would be differ where the two leave different things out of the text this change was made to.
      const [now, then] = [standing, reverted].map((left) => new Map(editsOf(settled(left, made.doc)).map((e) => [`${e.from}:${e.to}`, e])));
      const same = (e: Edit, others: Map<string, Edit>) => others.get(`${e.from}:${e.to}`)?.insert.eq(e.insert) ?? false;
      const moved = [...[...now!.values()].filter((e) => !same(e, then!)), ...[...then!.values()].filter((e) => !same(e, now!))].flatMap((e) => [linesOf(e, made.doc) ?? []]);
      const edited = editsOf(made.change).map((e) => linesOf(e, made.doc));
      const hit = edited.flatMap((lines, i) => (lines && moved.some(([first, last]) => lines[0] <= last! && first! <= lines[1]) ? [i] : []));
      if (hit.length) overlaps.set(made.revision, new Set(hit));
    }
    const next = leaving(standing, made, outWas);
    const hit = overlaps.get(made.revision);
    // An edit that overlaps is left out of the reverted text from here on, so that a change built on it is found to overlap too.
    reverted = hit ? leavingSome(reverted, made, hit) : standing === reverted && outWas === outWill ? next : leaving(reverted, made, outWill);
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

/** One place where a revert and later changes that still stand edited the same lines. Lines are without their line ends. */
export interface Conflict {
  /** The line of the note after the revert, every later edit kept, that `kept` starts at. Counted from 1. */
  line: number;
  /** The lines as they were before the reverted changes, with the later edits to them out too. */
  before: string[];
  /** The lines as the note has them now. */
  now: string[];
  /** The lines a revert leaves when the later edits are kept. */
  kept: string[];
  /** The later changes that edited these lines. */
  later: number[];
}

/** What becomes of a conflict's lines: the later edits kept, the lines as they were before, or the lines given, where no text is no lines. */
export type Choice = "keep" | "back" | { text: string };

export interface Reverting {
  /** The change that reverts and keeps every later edit. */
  changes: ChangeSet;
  overlaps: number[];
  conflicts: Conflict[];
}

/** More later changes than this, and every conflict names them all. */
const MAX_TOLD_APART = 12;

const linesOfText = (text: string) => (text ? text.split("\n") : []);

/** Whether two stretches of lines share a line, or one of them is a place between lines that the other reaches. */
const meet = (aFrom: number, aTo: number, bFrom: number, bTo: number) => (aFrom < aTo && bFrom < bTo ? aFrom < bTo && bFrom < aTo : aFrom <= bTo && bFrom <= aTo);

/**
 * What `reverts` would do to a note whose text is `text`, and each place where a later change that
 * still stands edited lines it changes. A conflict is a stretch where the note after the revert
 * differs from the note with those edits taken out as well: those edits alone, so what the same
 * later change did to other lines is no conflict and stays.
 */
export function reverting(history: readonly Recorded[], reverts: Reverts, text: string): Reverting {
  const parts = partsOf(history);
  const all = parts.map((p) => p.change);
  const will = leftOut(history, parts, reverts);
  const changes = takeOut(all, will);
  const later = overlappingEdits(parts, leftOut(history, parts), will);
  const overlaps = [...new Set([...later.keys()].map((n) => parts[n - 1]!.revision))];
  if (!later.size) return { changes, overlaps, conflicts: [] };

  const without = (edits: EditsOf) => linesOfText(applyChanges(takeOutWith(all, will, edits), text));
  const [now, kept, before] = [linesOfText(text), linesOfText(applyChanges(changes, text)), without(later)];
  const fromNow = lineHunks(now, kept);
  const told = later.size <= MAX_TOLD_APART ? [...later].map(([n, edits]) => ({ revision: parts[n - 1]!.revision, hunks: lineHunks(kept, without(new Map([[n, edits]]))) })) : [];

  const conflicts = lineHunks(kept, before).map((h): Conflict => {
    const by = told.filter((t) => t.hunks.some((o) => meet(h.aFrom, h.aTo, o.aFrom, o.aTo))).map((t) => t.revision);
    return {
      line: h.aFrom + 1,
      before: before.slice(h.bFrom, h.bTo),
      now: now.slice(...across(fromNow, h.aFrom, h.aTo)),
      kept: kept.slice(h.aFrom, h.aTo),
      later: by.length ? [...new Set(by)] : overlaps,
    };
  });
  return { changes, overlaps, conflicts };
}

/**
 * Where lines of the note after a revert, every later edit kept, were in the note as revision `at`
 * left it: the lines there that they came of, by every change since and by the revert. `line` is
 * counted from 1, as a conflict's is, and so is the answer's. No lines is the place before that line.
 */
export function linesAsOf(history: readonly Recorded[], { changes }: Pick<Reverting, "changes">, at: number, line: number, count: number): { line: number; lines: number } {
  const made = [...replayed(history.map((h) => h.changes))];
  const now = made.at(-1)?.next ?? Text.empty;
  const then = made[at]?.doc ?? now;
  const revert = anchored(lift(changes), now);
  const kept = revert.apply(now);
  const back = made.slice(at).reduce((all, m) => all.compose(m.change), ChangeSet.empty(then.length)).compose(revert).invertedDesc;
  const startOf = (n: number) => (n < kept.lines ? kept.line(n + 1).from : kept.length);
  // Text taken out since, at either end, is of these lines too: it is put back where they are.
  const [from, to] = [back.mapPos(startOf(line - 1), -1), back.mapPos(startOf(line - 1 + count), 1)];
  const first = then.lineAt(from).number - 1;
  const last = to > from ? then.lineAt(to - 1).number : first;
  return { line: first + 1, lines: last - first };
}

/** The lines of `a` that lines `from` up to `to` of `b` came of, given where the two differ. */
function across(hunks: readonly { aFrom: number; aTo: number; bFrom: number; bTo: number }[], from: number, to: number): [number, number] {
  let [start, end] = [Infinity, -Infinity];
  let [a, b] = [0, 0];
  const take = (first: number, last: number) => ([start, end] = [Math.min(start, first), Math.max(end, last)]);
  for (const h of [...hunks, { aFrom: Infinity, aTo: Infinity, bFrom: Infinity, bTo: Infinity }]) {
    // The lines both have, up to this hunk.
    const [lo, hi] = [Math.max(from, b), Math.min(to, h.bFrom)];
    if (lo < hi || (from === to && lo === hi)) take(a + lo - b, a + hi - b);
    if (h.bFrom === Infinity) break;
    if (meet(h.bFrom, h.bTo, from, to)) take(h.aFrom, h.aTo);
    [a, b] = [h.aTo, h.bTo];
  }
  return [start, end];
}

/** The note after a revert that left it as `kept`, with each of its conflicts settled as chosen. */
export function resolved(kept: string, conflicts: readonly Conflict[], choices: readonly Choice[]): string {
  const lines = linesOfText(kept);
  for (const [i, conflict] of [...conflicts.entries()].reverse()) {
    const choice = choices[i]!;
    const put = choice === "keep" ? conflict.kept : choice === "back" ? conflict.before : linesOfText(choice.text);
    lines.splice(conflict.line - 1, conflict.kept.length, ...put);
  }
  return lines.join("\n");
}

/** The change to record for a revert of the note `text` with its conflicts settled as chosen: the same change as with nothing chosen when every later edit is kept. */
export function settledRevert({ changes, conflicts }: Reverting, text: string, choices: readonly Choice[]): { changes: ChangeSet; resolution: Resolution | null } {
  const kept = applyChanges(changes, text);
  const edit = changesBetween(kept, resolved(kept, conflicts, choices));
  return edit.empty ? { changes, resolution: null } : { changes: changes.compose(edit), resolution: { reverted: changes, edit } };
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

/** A time in a zone as ISO 8601 with that zone's offset then, such as 2026-10-15T09:30:00.000-07:00. Throws a RangeError for a zone that doesn't exist. */
export function timeIn(timeZone: string): (time: number) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    timeZoneName: "longOffset",
  });
  return (time) => {
    const parts = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value]));
    // GMT alone is no offset; otherwise it is GMT+05:30 and the like.
    const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName!.slice(3);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
  };
}

/** The calendar day a time falls on in a zone, as YYYY-MM-DD. Throws a RangeError for a zone that doesn't exist. */
export function dayIn(timeZone: string): (time: number) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (time) => {
    const parts = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/** When a calendar day begins in a zone, in milliseconds. A day that begins with an hour the zone skips begins when its clocks next read. */
export function dayStartIn(timeZone: string): (day: string) => number {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  /** What the zone's clocks read at `time`, as if they were UTC's. */
  const read = (time: number) => {
    const parts = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, Number(p.value)]));
    return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second);
  };
  return (day) => {
    const wanted = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
    let time = wanted;
    // The zone's offset at the first guess can differ from the one at the answer, across a change of clocks.
    for (let i = 0; i < 3; i++) time -= read(time) - wanted;
    return time;
  };
}
