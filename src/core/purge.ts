import { TRASH_MS } from "./lifecycle.ts";

/**
 * Removing a note from Trash is the one place the record of a note is deleted: the note, its
 * changes, and everything else kept by its id. Each table that holds something by a note's id is
 * named here, and test/core/purge.test.ts fails when a table that isn't still holds something of a
 * removed note.
 *
 * In every statement ?1 is the note and ?2 the latest time it may have been trashed at, or null for
 * any. Each does nothing unless the note is in Trash at that moment, so a note restored a moment
 * before is left whole, and one already removed is removed again as nothing.
 */
const DUE = "EXISTS (SELECT 1 FROM notes WHERE id = ?1 AND state = 'trashed' AND (?2 IS NULL OR state_at <= ?2))";

export const REMOVALS = [
  `DELETE FROM note_search WHERE rowid = (SELECT id FROM note_search_rows WHERE note_id = ?1) AND ${DUE}`,
  `DELETE FROM note_search_rows WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM todo_projects WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM todos WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM note_tags WHERE note_id = ?1 AND ${DUE}`,
  // What the note links to. What links to it stays: that is what another note's text says.
  `DELETE FROM links WHERE source_id = ?1 AND ${DUE}`,
  `DELETE FROM labels WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM completions WHERE note_id = ?1 AND ${DUE}`,
  // A todo completed elsewhere and filed on this note stays completed, filed nowhere.
  `UPDATE completions SET daily_note_id = NULL, daily_revision = NULL, daily_at = NULL WHERE daily_note_id = ?1 AND ${DUE}`,
  `DELETE FROM daily_notes WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM grants WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM changes WHERE note_id = ?1 AND ${DUE}`,
  "DELETE FROM notes WHERE id = ?1 AND state = 'trashed' AND (?2 IS NULL OR state_at <= ?2)",
] as const;

/** The statements that remove one note in Trash and all that is kept of it, to run as one batch. The last one removes the note itself. */
export const removing = (db: D1Database, noteId: string, trashedBy: number | null = null): D1PreparedStatement[] => REMOVALS.map((sql) => db.prepare(sql).bind(noteId, trashedBy));

/**
 * What holds a note's id and is left when the note is removed, each with why. A column that can hold
 * a note's id is named in `REMOVALS` or here: test/core/purge.test.ts reads the schema and fails for
 * one that is in neither.
 */
export const KEPT: Record<string, string> = {
  "links.target_id": "What another note's text links to. It is that note's record, and a link to a removed note reads as one to a note that never was.",
};

/** As many notes as one batch removes, at a dozen statements a note. */
const PURGE_NOTES = 20;
/** As many batches as one run makes. What is left waits for the next run. */
const PURGE_BATCHES = 25;

export interface Purged {
  removed: number;
  /** Notes whose removal failed, which were left whole. They are tried again on the next run, and never keep the others waiting. */
  failed: string[];
  /** Whether there were more notes due than one run takes. */
  more: boolean;
}

/** Removes the notes named, as one batch. It answers how many were there to remove. */
async function remove(db: D1Database, ids: readonly string[], due: number): Promise<number> {
  const done = await db.batch(ids.flatMap((id) => removing(db, id, due)));
  let removed = 0;
  // Every note's last statement removes the note itself, and says whether it was still there to remove.
  for (let i = REMOVALS.length - 1; i < done.length; i += REMOVALS.length) removed += done[i]!.meta.changes;
  return removed;
}

/**
 * Removes the notes that have been in Trash for 30 days as of `now`, in every workspace, a batch at a
 * time. Run twice, or again after stopping partway, it removes what is left and nothing else. A batch
 * is all or nothing, so when one fails its notes are removed one at a time: the note that can't be
 * removed is left whole and named, and the rest go.
 */
export async function purgeTrash(db: D1Database, now: number, log: (message: string) => void = console.error): Promise<Purged> {
  const due = now - TRASH_MS;
  const purged: Purged = { removed: 0, failed: [], more: true };
  for (let batch = 0; batch < PURGE_BATCHES; batch++) {
    const { results } = await db
      .prepare("SELECT id FROM notes WHERE state = 'trashed' AND state_at <= ?1 AND id NOT IN (SELECT value FROM json_each(?3)) ORDER BY state_at, id LIMIT ?2")
      .bind(due, PURGE_NOTES, JSON.stringify(purged.failed))
      .all<{ id: string }>();
    if (!results.length) return { ...purged, more: false };
    const ids = results.map((r) => r.id);
    try {
      purged.removed += await remove(db, ids, due);
    } catch {
      for (const id of ids) {
        try {
          purged.removed += await remove(db, [id], due);
        } catch (err) {
          purged.failed.push(id);
          log(`Couldn't remove note ${id} from Trash: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return purged;
}
