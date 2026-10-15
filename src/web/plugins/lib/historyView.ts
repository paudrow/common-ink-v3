import { lineHunks, type Author, type AuthorRef, type Diff, type DiffLine, type HistoryEntry, type Reverts } from "../../plugin-api.ts";

/** Saves to one note by one author closer together than this are one row. */
export const SITTING_MS = 10 * 60_000;

export const authorKey = (author: Author) => `${author.kind}:${author.kind === "agent" ? author.agentId : author.kind === "plugin" ? author.pluginId : author.personId}`;
export const titleOf = (title: string) => title || "Untitled";
export const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** One row of the list: a change, or the saves of one sitting as one. */
export interface Row {
  /** Its latest change: `noteId/revision`. */
  key: string;
  noteId: string;
  noteTitle: string;
  /** Latest first. */
  revisions: number[];
  author: Author;
  firstAt: number;
  lastAt: number;
  /** Each save's own lines added and removed, summed. */
  added: number;
  removed: number;
  reverts: Reverts | null;
  restores: number;
  /** Whether a later change took it back out. */
  reverted: boolean;
  /** The labels on the revisions it made, latest first. */
  labels: string[];
}

export const keyOf = (noteId: string, revision: number) => `${noteId}/${revision}`;

/**
 * Changes, newest first, as rows: edits to one note by one author that follow one another less
 * than ten minutes apart are one row. A revert is always a row of its own, and so is an edit that
 * was taken back out next to one that stands, so that a row is reverted or not as a whole.
 */
export function groupSaves(changes: readonly HistoryEntry[], windowMs = SITTING_MS): Row[] {
  const rows: Row[] = [];
  for (const c of changes) {
    const last = rows.at(-1);
    const reverted = c.revertedBy !== null;
    if (
      last &&
      !c.reverts &&
      !last.reverts &&
      last.noteId === c.noteId &&
      last.revisions.at(-1) === c.revision + 1 &&
      authorKey(last.author) === authorKey(c.author) &&
      last.reverted === reverted &&
      last.firstAt - c.createdAt < windowMs
    ) {
      last.revisions.push(c.revision);
      last.firstAt = c.createdAt;
      last.added += c.added;
      last.removed += c.removed;
      if (c.label) last.labels.push(c.label);
    } else {
      rows.push({
        key: keyOf(c.noteId, c.revision),
        noteId: c.noteId,
        noteTitle: c.noteTitle,
        revisions: [c.revision],
        author: c.author,
        firstAt: c.createdAt,
        lastAt: c.createdAt,
        added: c.added,
        removed: c.removed,
        reverts: c.reverts,
        restores: c.restores,
        reverted,
        labels: c.label ? [c.label] : [],
      });
    }
  }
  return rows;
}

/** What a row did, as the words after its author: "edited", "reverted 3 changes to", "undid a revert of". The note's name follows when it is `named`. */
export function did({ reverts, restores, revisions }: Pick<Row, "reverts" | "restores" | "revisions">, named = true): string {
  const [to, of, into] = named ? [" to", " of", " in"] : ["", "", ""];
  if (!reverts) return revisions.at(-1) === 1 ? "wrote" : "edited";
  const n = reverts.revisions.length;
  if (reverts.how === "undo") return `undid a change${to}`;
  if (reverts.how === "redo") return `redid a change${to}`;
  if (reverts.to !== undefined) return `went back ${count(n, "change")}${into}`;
  if (restores === n) return n === 1 ? `undid a revert${of}` : `undid ${n} reverts${of}`;
  return `reverted ${count(n, "change")}${to}`;
}

/** Who a row is by, as its sentence starts: the member themselves is "You". */
export const who = (author: Author, me: string) => (author.kind === "member" && author.personId === me ? "You" : author.name);

const DAY_MS = 86_400_000;
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);

/** The day a change was made, as a heading: Today, Yesterday, or the date. */
export function dayLabel(time: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const [then, today] = [new Date(time), new Date(now)];
  return then.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: then.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** The rows of one day, newest first. `at` is when the day began. */
export interface Day {
  at: number;
  rows: Row[];
}

/** Rows, newest first, by the day each was last saved on. */
export function byDay(rows: readonly Row[]): Day[] {
  const days: Day[] = [];
  for (const row of rows) {
    const at = startOfDay(row.lastAt);
    if (days.at(-1)?.at === at) days.at(-1)!.rows.push(row);
    else days.push({ at, rows: [row] });
  }
  return days;
}

/** What was done to one note in one day. */
export interface NoteOfDay {
  noteId: string;
  noteTitle: string;
  /** Newest first. */
  rows: Row[];
  added: number;
  removed: number;
  saves: number;
  /** Who made them, whoever was latest first. */
  authors: Author[];
}

/** The notes a day's rows changed, the one changed latest first. */
export function notesOf(rows: readonly Row[]): NoteOfDay[] {
  const notes = new Map<string, NoteOfDay>();
  for (const row of rows) {
    const note = notes.get(row.noteId) ?? { noteId: row.noteId, noteTitle: row.noteTitle, rows: [], added: 0, removed: 0, saves: 0, authors: [] };
    note.rows.push(row);
    note.added += row.added;
    note.removed += row.removed;
    note.saves += row.revisions.length;
    if (!note.authors.some((a) => authorKey(a) === authorKey(row.author))) note.authors.push(row.author);
    notes.set(row.noteId, note);
  }
  return [...notes.values()];
}

/** What narrows the list: to some notes, to some authors, and to people's changes or agents'. */
export interface Narrowing {
  noteIds?: readonly string[];
  authors?: readonly AuthorRef[];
  by?: "people" | "agents";
}

/** Whether a change is listed under a narrowing. */
export function lists({ noteIds, authors, by }: Narrowing, change: Pick<HistoryEntry, "noteId" | "author">): boolean {
  const { author } = change;
  if (noteIds && !noteIds.includes(change.noteId)) return false;
  if (by && (by === "people") !== (author.kind === "member")) return false;
  return !authors || authors.some((a) => authorKey(author) === `${a.kind}:${a.id}`);
}

export const clock = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const HUES = [258, 285, 205, 330, 190, 20, 240];

/** The same hue for the same name, so an agent looks the same wherever it is drawn. */
export function hueOf(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length]!;
}

export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}]/gu, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

/** The changes picked, by note. A note with none picked isn't in it. */
export type Selection = ReadonlyMap<string, ReadonlySet<number>>;

export const NOTHING: Selection = new Map();

export const picks = (selection: Selection, row: Pick<Row, "noteId" | "revisions">) => row.revisions.every((r) => selection.get(row.noteId)?.has(r));
const picksSome = (selection: Selection, row: Pick<Row, "noteId" | "revisions">) => row.revisions.some((r) => selection.get(row.noteId)?.has(r));

/** Whether all of the rows are picked, some of them, or none. */
export function picked(selection: Selection, rows: readonly Pick<Row, "noteId" | "revisions">[]): "all" | "some" | "none" {
  if (rows.length && rows.every((row) => picks(selection, row))) return "all";
  return rows.some((row) => picksSome(selection, row)) ? "some" : "none";
}

export function withRows(selection: Selection, rows: readonly Pick<Row, "noteId" | "revisions">[], on: boolean): Selection {
  const next = new Map([...selection].map(([noteId, revisions]) => [noteId, new Set(revisions)]));
  for (const row of rows) {
    const revisions = next.get(row.noteId) ?? new Set<number>();
    for (const r of row.revisions) on ? revisions.add(r) : revisions.delete(r);
    if (revisions.size) next.set(row.noteId, revisions);
    else next.delete(row.noteId);
  }
  return next;
}

/** As many changes of one note as one request reads or reverts. */
export const MOST_OF_A_NOTE = 500;

/** The selection with at most that many changes of each note, its latest, and whether any were left out. */
export function within(selection: Selection): { selection: Selection; cut: boolean } {
  if ([...selection.values()].every((revisions) => revisions.size <= MOST_OF_A_NOTE)) return { selection, cut: false };
  return { selection: new Map([...selection].map(([noteId, revisions]) => [noteId, new Set([...revisions].sort((a, b) => b - a).slice(0, MOST_OF_A_NOTE))])), cut: true };
}

/** The picked changes that `listed` answers yes to. Ones it knows nothing of are dropped. The same selection is returned when all are kept. */
export function kept(selection: Selection, listed: (noteId: string, revision: number) => boolean): Selection {
  const next = new Map<string, ReadonlySet<number>>();
  for (const [noteId, revisions] of selection) {
    const still = [...revisions].filter((r) => listed(noteId, r));
    if (still.length) next.set(noteId, still.length === revisions.size ? revisions : new Set(still));
  }
  return sameSelection(selection, next) ? selection : next;
}

export const only = (rows: readonly Pick<Row, "noteId" | "revisions">[]) => withRows(NOTHING, rows, true);

export const sizeOf = (selection: Selection) => [...selection.values()].reduce((sum, revisions) => sum + revisions.size, 0);

export const sameSelection = (a: Selection, b: Selection) => a.size === b.size && [...a].every(([noteId, revisions]) => b.get(noteId)?.size === revisions.size && [...revisions].every((r) => b.get(noteId)!.has(r)));

/** The selection as the operations take it: each note once, its revisions in order. */
export const asked = (selection: Selection) => [...selection].map(([noteId, revisions]) => ({ noteId, revisions: [...revisions].sort((a, b) => a - b) }));

/** A stretch of the text a diff leads to, to mark the changed lines of: lines `from` up to `to`, counted from 0, or the place before line `from` when they are the same. */
export interface Stretch {
  from: number;
  to: number;
}

/** A piece of a diff as it is drawn. `mark` is the first of the stretches asked for that a changed piece is of. */
export type Piece =
  | { kind: "same"; text: string }
  | { kind: "add" | "del"; text: string; mark?: number }
  /** Lines rewritten, shown once with the words that changed marked. */
  | { kind: "mod"; words: Array<{ kind: "same" | "add" | "del"; text: string }>; mark?: number }
  /** Unchanged lines left out: lines `from` up to `to` of the text before, counted from 0. */
  | { kind: "fold"; from: number; to: number }
  /** The rest of a long run of added or removed lines, shown when asked for. */
  | { kind: "more"; of: "add" | "del"; lines: string[]; mark?: number };

/** Rewritten runs of at most this many lines a side are shown word by word. */
const MOST_REWRITTEN = 12;
/** An added or removed run longer than this shows its first lines. */
const LONG = 60;
const SHOWN = 30;

const WORDS = /\s+|[\p{L}\p{N}_]+|[^]/gu;

function words(before: string, after: string): Extract<Piece, { kind: "mod" }>["words"] {
  const [a, b] = [before.match(WORDS) ?? [], after.match(WORDS) ?? []];
  const out: Extract<Piece, { kind: "mod" }>["words"] = [];
  const push = (kind: "same" | "add" | "del", text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  for (const h of [...lineHunks(a, b), { aFrom: a.length, aTo: a.length, bFrom: b.length, bTo: b.length }]) {
    push("same", a.slice(i, h.aFrom).join(""));
    push("del", a.slice(h.aFrom, h.aTo).join(""));
    push("add", b.slice(h.bFrom, h.bTo).join(""));
    i = h.aTo;
  }
  return out;
}

/**
 * A line diff as it is drawn: unchanged lines between its hunks folded away, a short rewrite shown
 * once with its changed words marked, and a long run of added or removed lines cut to its start.
 */
export function pieces(diff: Diff, marks: readonly Stretch[] = []): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const fold = (to: number) => {
    if (to > at) out.push({ kind: "fold", from: at, to });
  };
  /** The mark of changed lines that leave lines `from` up to `to` of the text after, if a stretch asked for meets them. */
  const markOf = (from: number, to: number) => {
    const hit = marks.findIndex((m) => (m.from < m.to && from < to ? m.from < to && from < m.to : m.from <= to && from <= m.to));
    return hit < 0 ? {} : { mark: hit };
  };
  const run = (of: "add" | "del", lines: string[], mark: { mark?: number }) => {
    const shown = lines.length > LONG ? lines.slice(0, SHOWN) : lines;
    for (const text of shown) out.push({ kind: of, text, ...mark });
    if (shown.length < lines.length) out.push({ kind: "more", of, lines: lines.slice(SHOWN), ...mark });
  };
  for (const hunk of diff.hunks) {
    fold(hunk.oldStart - 1);
    at = hunk.oldStart - 1;
    let after = hunk.newStart - 1;
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; ) {
      const kind = lines[i]!.kind;
      let end = i;
      while (end < lines.length && lines[end]!.kind === kind) end++;
      const texts = lines.slice(i, end).map((l: DiffLine) => l.text);
      if (kind === "same") {
        for (const text of texts) out.push({ kind: "same", text });
        at += texts.length;
        after += texts.length;
      } else if (kind === "del") {
        let addEnd = end;
        while (addEnd < lines.length && lines[addEnd]!.kind === "add") addEnd++;
        const added = lines.slice(end, addEnd).map((l) => l.text);
        at += texts.length;
        // Lines taken out and the lines put in their place are one change, marked as one.
        const mark = markOf(after, after + added.length);
        // As many lines after as before, or lines joined or split would read as words changed within a line.
        const rewritten = added.length === texts.length && texts.length <= MOST_REWRITTEN ? words(texts.join("\n"), added.join("\n")) : [];
        // Lines with no word in common were replaced, not rewritten, and read better as lines out and lines in.
        if (rewritten.some((w) => w.kind === "same" && /\S/.test(w.text))) out.push({ kind: "mod", words: rewritten, ...mark });
        else {
          run("del", texts, mark);
          run("add", added, mark);
        }
        after += added.length;
        end = addEnd;
      } else {
        run("add", texts, markOf(after, after + texts.length));
        after += texts.length;
      }
      i = end;
    }
  }
  if (!diff.omitted) fold(diff.lines);
  return out;
}
