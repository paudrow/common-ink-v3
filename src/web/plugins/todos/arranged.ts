/** A row of the Todos page: a line of a note, and what it says. */
export interface Placed {
  noteId: string;
  line: number;
  text: string;
}

export const keyOf = (row: Placed) => `${row.noteId}/${row.line}`;

/**
 * Why a row the list no longer has is still shown: the member changed it here, or put it away (checked
 * it off, abandoned it or moved it to the backlog) a moment ago. "kept" is a row put away while the
 * member leaves the todos they put away in place, which stays until the list is refreshed.
 */
export type Hold = "changed" | "put away" | "kept";

/**
 * The Todos page's list, which keeps its order while the member works on it. A change there, a tag
 * added or a date set, would sort the row somewhere else when the list is read again; it stays where it
 * is instead, and so does a row the change took out of the list, until the list is refreshed. `fresh` is
 * the list as it would be shown refreshed, `shown` as it is shown.
 */
export interface Listing<T extends Placed> {
  /** The rows as the server last listed them, with the changes on their way made to them. */
  fresh: readonly T[];
  /** The rows in the order they are shown. */
  shown: readonly T[];
  /** The rows the member changed or put away since the list was refreshed, which stay shown when the list no longer has them. */
  held: ReadonlyMap<string, Hold>;
}

export type ListingEvent<T extends Placed> =
  /** The list was read. Refreshed, it is shown as read; otherwise each row shown stays in its place. */
  | { type: "read"; rows: readonly T[]; refresh: boolean }
  /** More of the list was read, after what was read before. */
  | { type: "more"; rows: readonly T[] }
  /** The member changed a row, which reads as changed at once and is held. Without `hold` it is held as it was, if it was: a change that landed. */
  | { type: "change"; key: string; to: (row: T) => T; hold?: Hold }
  /** A row put away has stayed its moment, and goes once the list no longer has it. */
  | { type: "let go"; key: string }
  /** A change to a row was refused, so nothing of it holds the row. */
  | { type: "refused"; key: string }
  | { type: "refresh" };

export const EMPTY: Listing<never> = { fresh: [], shown: [], held: new Map() };

/**
 * The rows in the order they were shown, as `fresh` has them now, and the rows whose line moved, by
 * their key before and after. A row shown is the row `fresh` has on its line saying the same; else one
 * of its note saying the same on another line, as when a line is written above it; else, for a row the
 * member changed, the one on its line, as the change left it. A row shown that `fresh` no longer has goes, unless it is held and no other
 * todo has its line now, as one does when a line is written above it: those held rows that go are `lost`. A row that came goes right after
 * the row `fresh` has before it, or first.
 */
export function arrange<T extends Placed>(shown: readonly T[], fresh: readonly T[], held: ReadonlyMap<string, Hold>): { rows: T[]; moved: Map<string, string>; lost: Set<string> } {
  const free = new Set(fresh);
  const matched = new Map<T, T>();
  const pass = (same: (had: T, read: T) => boolean) => {
    for (const had of shown) {
      if (matched.has(had)) continue;
      const read = [...free].find((row) => same(had, row));
      if (!read) continue;
      matched.set(had, read);
      free.delete(read);
    }
  };
  pass((had, read) => keyOf(had) === keyOf(read) && had.text === read.text);
  pass((had, read) => had.noteId === read.noteId && had.text === read.text);
  // Only for a row the member changed: a line that says something else otherwise may be another todo, written there by someone else.
  pass((had, read) => keyOf(had) === keyOf(read) && held.has(keyOf(had)));
  const moved = new Map<string, string>();
  const lost = new Set<string>();
  const lines = new Set(fresh.map(keyOf));
  const rows = shown.flatMap((row) => {
    const read = matched.get(row);
    if (read && keyOf(read) !== keyOf(row)) moved.set(keyOf(row), keyOf(read));
    if (read) return [read];
    if (!held.has(keyOf(row))) return [];
    if (!lines.has(keyOf(row))) return [row];
    lost.add(keyOf(row));
    return [];
  });
  const placed = new Set(rows.map(keyOf));
  fresh.forEach((row, i) => {
    if (placed.has(keyOf(row))) return;
    // The row before it in `fresh` is shown by now: it was shown already, or it came and was placed a step ago.
    const after = i === 0 ? 0 : rows.findIndex((had) => keyOf(had) === keyOf(fresh[i - 1]!)) + 1;
    rows.splice(after, 0, row);
    placed.add(keyOf(row));
  });
  return { rows, moved, lost };
}

/** The list read again: its rows kept where they were shown, and a held row's hold gone with it to the line it moved to, or with it when it goes. */
function follow<T extends Placed>(had: Listing<T>, fresh: readonly T[], held = had.held): Listing<T> {
  const { rows, moved, lost } = arrange(had.shown, fresh, held);
  if (!moved.size && !lost.size) return { fresh, shown: rows, held };
  const holds = new Map([...held].filter(([key]) => !moved.has(key) && !lost.has(key)));
  for (const [from, to] of moved) if (held.has(from)) holds.set(to, held.get(from)!);
  return { fresh, shown: rows, held: holds };
}

export function listing<T extends Placed>(had: Listing<T>, event: ListingEvent<T>): Listing<T> {
  switch (event.type) {
    case "read":
      return event.refresh ? { fresh: event.rows, shown: event.rows, held: new Map() } : follow(had, event.rows);
    case "more": {
      // After every row shown, which those read before it all are.
      const shown = new Set(had.shown.map(keyOf));
      return { ...had, fresh: [...had.fresh, ...event.rows], shown: [...had.shown, ...event.rows.filter((row) => !shown.has(keyOf(row)))] };
    }
    case "change": {
      const to = (row: T) => (keyOf(row) === event.key ? event.to(row) : row);
      return { fresh: had.fresh.map(to), shown: had.shown.map(to), held: event.hold ? new Map(had.held).set(event.key, event.hold) : had.held };
    }
    case "let go":
    case "refused": {
      if (!had.held.has(event.key) || (event.type === "let go" && had.held.get(event.key) !== "put away")) return had;
      const held = new Map(had.held);
      held.delete(event.key);
      return follow(had, had.fresh, held);
    }
    case "refresh":
      return { ...had, shown: had.fresh, held: new Map() };
  }
}

/** The rows shown that the list no longer has, which are shown dimmed. */
export function left<T extends Placed>({ fresh, shown }: Listing<T>): Set<string> {
  const read = new Set(fresh.map(keyOf));
  return new Set(shown.map(keyOf).filter((key) => !read.has(key)));
}

/**
 * Whether refreshing would show the list another way: in another order, or without a row the member
 * changed out of it. A row put away doesn't count: one put away a moment ago is going by itself, and
 * one kept stays as the member asked.
 */
export function pending<T extends Placed>(list: Listing<T>): boolean {
  const gone = left(list);
  if ([...gone].some((key) => list.held.get(key) === "changed")) return true;
  const order = list.shown.map(keyOf).filter((key) => !gone.has(key));
  return order.length !== list.fresh.length || order.some((key, i) => key !== keyOf(list.fresh[i]!));
}
