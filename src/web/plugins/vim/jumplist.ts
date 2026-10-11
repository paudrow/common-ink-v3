/**
 * The notes a member has been to, in order, and which of them they are at. Going back and forward
 * moves along it. Visiting a note from the middle drops what was ahead, as a browser's history does.
 */
export interface Jumplist {
  readonly notes: readonly string[];
  /** -1 when there are none. */
  readonly at: number;
}

export const EMPTY: Jumplist = { notes: [], at: -1 };

const MAX = 100;

/** The list after the app shows a note. Arriving where a jump went changes nothing. */
export function visit(list: Jumplist, noteId: string): Jumplist {
  if (list.notes[list.at] === noteId) return list;
  const notes = [...list.notes.slice(0, list.at + 1), noteId].slice(-MAX);
  return { notes, at: notes.length - 1 };
}

/**
 * The list after a step back (-1) or forward (1), which is the same list when there is nowhere to
 * go. `here` is the note the app shows, or null on a page: away from the list's note, back returns
 * to it. A note that `canOpen` refuses is stepped over.
 */
export function jump(list: Jumplist, by: -1 | 1, here: string | null, canOpen: (noteId: string) => boolean): Jumplist {
  const away = here !== list.notes[list.at];
  for (let at = by < 0 && away ? list.at : list.at + by; at >= 0 && at < list.notes.length; at += by) {
    if (canOpen(list.notes[at]!)) return { notes: list.notes, at };
  }
  return list;
}
