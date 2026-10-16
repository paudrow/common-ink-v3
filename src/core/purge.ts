import { TRASH_MS } from "./lifecycle.ts";
import { logLine } from "./logs.ts";

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
  `DELETE FROM todos WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM note_tags WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM mentions WHERE note_id = ?1 AND ${DUE}`,
  // What the note links to. What links to it stays: that is what another note's text says.
  `DELETE FROM links WHERE source_id = ?1 AND ${DUE}`,
  // Which uploads the note refers to. The uploads stay: each is a thing of its own, which other notes may refer to.
  `DELETE FROM upload_refs WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM labels WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM completions WHERE note_id = ?1 AND ${DUE}`,
  // A todo completed elsewhere and filed on this note stays completed, filed nowhere.
  `UPDATE completions SET daily_note_id = NULL, daily_revision = NULL, daily_at = NULL WHERE daily_note_id = ?1 AND ${DUE}`,
  `DELETE FROM daily_notes WHERE note_id = ?1 AND ${DUE}`,
  `DELETE FROM pins WHERE note_id = ?1 AND ${DUE}`,
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
/**
 * Rewrites the search index without what removed rows held. Deleting a row marks its words as gone
 * and leaves them in the index's own pages until those are merged, which this does at once.
 */
export const forgetRemoved = (db: D1Database) => db.prepare("INSERT INTO note_search (note_search) VALUES ('optimize')").run();

export async function purgeTrash(db: D1Database, now: number, log: (message: string) => void = logLine): Promise<Purged> {
  const purged = await purgeDue(db, now, log);
  if (purged.removed) await forgetRemoved(db).catch((err: unknown) => log(`Couldn't merge the search index after removing notes: ${err instanceof Error ? err.message : String(err)}`));
  return purged;
}

async function purgeDue(db: D1Database, now: number, log: (message: string) => void): Promise<Purged> {
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

/** How long an upload may wait with nothing sent to it before it is taken for one that will never finish. */
export const PENDING_MS = 86_400_000;
/**
 * Removing an upload takes two stores, and nothing makes a change to both at once. So it goes in
 * three steps, each of which can be done again:
 *
 * 1. The row becomes `removing`, in one statement that does nothing unless the upload is in Trash
 *    (or pending). From here nothing reads the upload, and nothing restores it.
 * 2. The bytes are deleted from the bucket. Deleting what is already gone is nothing.
 * 3. The row and its grants are deleted.
 *
 * Stopped after any step, what is left is a row that is `removing`, which `clearUploads` finds and
 * carries on from step 2. So there are never bytes that can be read with no row to decide who may,
 * and never a row that can be read with no bytes behind it.
 */
export async function finishRemoving(db: D1Database, bucket: R2Bucket, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const removing = "(SELECT u.id FROM uploads u WHERE u.state = 'removing' AND u.id IN (SELECT value FROM json_each(?1)))";
  const list = JSON.stringify(ids);
  // An upload stopped while its parts were arriving has them kept apart in the bucket, which aborting throws away. One the bucket no longer knows is gone already.
  const { results } = await db.prepare(`SELECT id, multipart_id FROM uploads WHERE multipart_id IS NOT NULL AND id IN ${removing}`).bind(list).all<{ id: string; multipart_id: string }>();
  await Promise.all(results.map((row) => bucket.resumeMultipartUpload(row.id, row.multipart_id).abort().catch(() => {})));
  await bucket.delete([...ids]);
  await db.batch([
    db.prepare(`DELETE FROM upload_pass_uses WHERE hash IN (SELECT hash FROM upload_passes WHERE upload_id IN ${removing})`).bind(list),
    db.prepare(`DELETE FROM upload_passes WHERE upload_id IN ${removing}`).bind(list),
    db.prepare(`DELETE FROM upload_parts WHERE upload_id IN ${removing}`).bind(list),
    db.prepare(`DELETE FROM grants WHERE upload_id IN ${removing}`).bind(list),
    db.prepare(`DELETE FROM uploads WHERE id IN ${removing}`).bind(list),
  ]);
}

/** Removes one upload in Trash for good. False when it was not in Trash, as one restored a moment before isn't. */
export async function removeUpload(db: D1Database, bucket: R2Bucket, id: string): Promise<boolean> {
  const { meta } = await db.prepare("UPDATE uploads SET state = 'removing' WHERE id = ? AND state = 'trashed'").bind(id).run();
  if (!meta.changes) return false;
  await finishRemoving(db, bucket, [id]);
  return true;
}

/** As many uploads as one run removes, which is as many as the bucket deletes at once. What is left waits for the next run. */
const CLEAR_UPLOADS = 1000;

/**
 * Removes the uploads that have been in Trash for 30 days as of `now`, in every workspace, and
 * clears away the ones left pending or half removed by a request that never finished: one sent in
 * parts is cleared once nothing has been sent to it for a day, its parts aborted in the bucket. Run twice, or
 * again after stopping partway, it removes what is left and nothing else. When it fails, every
 * upload it was removing is left as it is, unread, for the next run.
 */
export async function clearUploads(db: D1Database, bucket: R2Bucket, now: number, log: (message: string) => void = console.error): Promise<Purged> {
  await db.batch([
    db.prepare("UPDATE uploads SET state = 'removing' WHERE state = 'trashed' AND state_at <= ?").bind(now - TRASH_MS),
    db.prepare("UPDATE uploads SET state = 'removing' WHERE state = 'pending' AND COALESCE(touched_at, created_at) <= ?").bind(now - PENDING_MS),
    db.prepare("DELETE FROM upload_pass_uses WHERE hash IN (SELECT hash FROM upload_passes WHERE expires_at <= ?)").bind(now),
    db.prepare("DELETE FROM upload_passes WHERE expires_at <= ?").bind(now),
  ]);
  const { results } = await db.prepare("SELECT id FROM uploads WHERE state = 'removing' ORDER BY id LIMIT ?").bind(CLEAR_UPLOADS + 1).all<{ id: string }>();
  const ids = results.slice(0, CLEAR_UPLOADS).map((r) => r.id);
  const more = results.length > CLEAR_UPLOADS;
  try {
    await finishRemoving(db, bucket, ids);
    return { removed: ids.length, failed: [], more };
  } catch (err) {
    log(`Couldn't remove ${ids.length} uploads: ${err instanceof Error ? err.message : String(err)}`);
    return { removed: 0, failed: ids, more };
  }
}
