import type { PluginHost } from "../../plugin-api.ts";

/**
 * The member's pins as this browser knows them: the ids of the notes they pinned that are live or
 * archived, in the order they were pinned, or null until they have been read. The server keeps them, so they are the same in any
 * browser, and decides which are shown: this only holds what it answered and what was changed here since.
 */
export interface Pins {
  ids(): readonly string[] | null;
  subscribe(listener: () => void): () => void;
  /** Reads them again. */
  read(): void;
  /** Reads them unless they have been read. */
  want(): void;
  /** Pins a note or takes its pin away, shown at once and put back as it was when the server refuses. */
  set(noteId: string, pinned: boolean): void;
}

export function pinsOf(host: PluginHost): Pins {
  let ids: readonly string[] | null = null;
  let reading = false;
  /** Counts the changes made here, so a reading that started before one isn't taken for what is so after it. */
  let changes = 0;
  const listeners = new Set<() => void>();
  const say = (next: readonly string[]) => {
    ids = next;
    for (const listener of [...listeners]) listener();
  };

  const read = () => {
    if (reading) return;
    reading = true;
    const at = changes;
    host.perform({ type: "pin.list", includeArchived: true }).then(
      (notes) => {
        reading = false;
        if (at !== changes) return read();
        say(notes.map((note) => note.id));
      },
      () => {
        reading = false;
        if (ids === null) say([]);
      },
    );
  };

  return {
    ids: () => ids,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read,
    want: () => void (ids === null && read()),
    set(noteId, pinned) {
      const before = ids ?? [];
      changes++;
      say(pinned ? [...before.filter((id) => id !== noteId), noteId] : before.filter((id) => id !== noteId));
      host.perform({ type: "pin.set", id: noteId, pinned }).catch((err: Error) => {
        changes++;
        say(before);
        host.app().notify({ message: `${pinned ? "Couldn't pin the note" : "Couldn't take the pin away"}: ${err.message}` });
      });
    },
  };
}
