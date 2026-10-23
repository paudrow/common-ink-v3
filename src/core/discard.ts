import { ChangeSet } from "@codemirror/state";
import { logLine } from "./logs.ts";
import { forgetRemoved, removing } from "./purge.ts";
import { applyChanges, blank } from "./text.ts";

/**
 * How long a hold on a note lasts after its holder last said it has the note open. The app says so
 * every few minutes while an editor of a blank note is open, so one closed without a word, by a
 * crash or a window shut, lets go in this time.
 */
export const HOLD_MS = 600_000;
/** How long a note nobody wrote in is kept with nothing holding it before the hourly sweep removes it. */
export const SWEEP_MS = 86_400_000;

/** Records that `holder` has the note open as of `at`. A note removed a moment before is held by nothing. */
export const hold = (db: D1Database, noteId: string, holder: string, at: number) =>
  db
    .prepare("INSERT INTO note_holds (note_id, holder, at) SELECT id, ?2, ?3 FROM notes WHERE id = ?1 ON CONFLICT (note_id, holder) DO UPDATE SET at = MAX(at, excluded.at)")
    .bind(noteId, holder, at)
    .run();

/**
 * Whether nobody ever wrote in a note: a member or an agent made it, and every revision of it is blank,
 * whoever recorded it. A note a plugin made is its plugin's to keep, blank or not.
 */
export async function neverWritten(db: D1Database, note: { id: string; revision: number }): Promise<boolean> {
  const made = await db.prepare("SELECT created_by_kind, text FROM notes WHERE id = ?").bind(note.id).first<{ created_by_kind: string | null; text: string }>();
  if ((made?.created_by_kind !== "member" && made?.created_by_kind !== "agent") || !blank(made.text)) return false;
  const { results } = await db.prepare("SELECT diff FROM changes WHERE note_id = ? ORDER BY revision").bind(note.id).all<{ diff: string }>();
  if (results.length !== note.revision) return false;
  let text = "";
  for (const change of results) {
    text = applyChanges(ChangeSet.fromJSON(JSON.parse(change.diff)), text);
    if (!blank(text)) return false;
  }
  return true;
}

/**
 * Removes a note nobody wrote in, at the revision it was read at, unless something holds it that said
 * so after `heldSince`. `letGo` is a holder to forget first: the page leaving the note. It answers
 * whether the note was removed. A note written to, put in Trash or taken hold of since it was read is
 * left as it is.
 */
export async function discard(db: D1Database, note: { id: string; revision: number }, heldSince: number, letGo: string | null = null): Promise<boolean> {
  // Put in Trash at no time at all, which nothing else is, so the removal after takes this note as it is now, or nothing.
  const done = await db.batch([
    db.prepare("DELETE FROM note_holds WHERE note_id = ? AND holder = ?").bind(note.id, letGo),
    db
      .prepare("UPDATE notes SET state = 'trashed', state_at = 0 WHERE id = ?1 AND revision = ?2 AND state != 'trashed' AND NOT EXISTS (SELECT 1 FROM note_holds WHERE note_id = ?1 AND at > ?3)")
      .bind(note.id, note.revision, heldSince),
    ...removing(db, note.id, 0),
  ]);
  // That statement says whether the note was still as it was read; the ones after do nothing unless it was.
  return done[1]!.meta.changes > 0;
}

/**
 * The notes the sweep may remove, oldest first: untitled, made before ?1, blank now, held by nothing
 * since ?1, with every revision's change kept, and with no change that ever put words in. The text and the changes are read again in
 * full by `neverWritten` before one is removed: this only keeps a note emptied on purpose from
 * being looked at every hour.
 */
const UNWRITTEN = `SELECT n.id, n.revision FROM notes n
  WHERE n.title = '' AND n.created_at <= ?1 AND n.state != 'trashed' AND n.created_by_kind IN ('member', 'agent')
    AND trim(n.text, char(32, 9, 10, 13)) IN ('', '#')
    AND NOT EXISTS (SELECT 1 FROM note_holds h WHERE h.note_id = n.id AND h.at > ?1)
    AND n.revision = (SELECT COUNT(*) FROM changes c WHERE c.note_id = n.id)
    AND NOT EXISTS (SELECT 1 FROM changes c, json_tree(c.diff) t WHERE c.note_id = n.id AND t.type = 'text' AND trim(t.value, char(32, 9, 13)) NOT IN ('', '#'))
  ORDER BY n.created_at, n.id LIMIT ?2`;

/** As many notes as one sweep removes. What is left waits for the next run. */
const SWEEP_NOTES = 50;

export interface Swept {
  removed: number;
  /** Notes whose removal failed, which were left whole for the next run. */
  failed: string[];
  more: boolean;
}

/**
 * Removes the notes nobody wrote in that were made a day before `now` and that nothing has held for a
 * day, in every workspace: the ones left by a window closed, a page reloaded or a crash, which no
 * `note.discard` came for. It forgets holds that old too. Run twice, or again after stopping partway,
 * it removes what is left and nothing else.
 */
export async function sweepUnwritten(db: D1Database, now: number, log: (message: string) => void = logLine): Promise<Swept> {
  const since = now - SWEEP_MS;
  await db.prepare("DELETE FROM note_holds WHERE at <= ?").bind(since).run();
  const { results } = await db.prepare(UNWRITTEN).bind(since, SWEEP_NOTES + 1).all<{ id: string; revision: number }>();
  const swept: Swept = { removed: 0, failed: [], more: results.length > SWEEP_NOTES };
  for (const note of results.slice(0, SWEEP_NOTES)) {
    try {
      if ((await neverWritten(db, note)) && (await discard(db, note, since))) swept.removed++;
    } catch (err) {
      swept.failed.push(note.id);
      log(`Couldn't remove note ${note.id}, which nobody wrote in: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (swept.removed) await forgetRemoved(db).catch((err: unknown) => log(`Couldn't merge the search index after removing notes: ${err instanceof Error ? err.message : String(err)}`));
  return swept;
}
