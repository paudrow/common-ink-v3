/**
 * Where a note is in its life. It is a second thing decided about a note, beside who may see it:
 * access says who, and this says whether it is listed and whether it can be changed.
 *
 * - `live`: listed everywhere.
 * - `archived`: kept with its folder, id and links, and left out of listings unless they are asked
 *   for. It opens and is changed as a live note is.
 * - `trashed`: waiting in Trash for {@link TRASH_DAYS} days. It is listed only there, opens to be
 *   read, and can't be changed until it is restored.
 *
 * After that the note and its history are removed, and nothing is kept of it: a removed note is the
 * same as one that never was.
 */
export const NOTE_STATES = ["live", "archived", "trashed"] as const;
export type NoteState = (typeof NOTE_STATES)[number];

export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 86_400_000;

/** When a note trashed at `trashedAt` is removed. */
export const purgesAt = (trashedAt: number) => trashedAt + TRASH_MS;

/** The states a query over notes covers. Every such query names one, so none covers Trash by leaving it unsaid. */
export type Covering = "live" | "archived" | "kept" | "trashed" | "any";

const COVERS: Record<Covering, readonly NoteState[]> = {
  live: ["live"],
  archived: ["archived"],
  kept: ["live", "archived"],
  trashed: ["trashed"],
  any: NOTE_STATES,
};

/** What a listing covers: live notes, archived ones too when they were asked for, or with `"only"` the archived ones alone. Never Trash. */
export const listing = (includeArchived: boolean | "only"): Covering => (includeArchived === "only" ? "archived" : includeArchived ? "kept" : "live");

/** A condition on the notes row named `alias`, true for the notes in a state `covering` covers. */
export const IN_STATE = (alias: string, covering: Covering) => `${alias}.state IN (${COVERS[covering].map((state) => `'${state}'`).join(", ")})`;

/**
 * What an operation on one note does when the note is in Trash. `opens`: it goes ahead, as reading
 * does. `refused`: it is told the note is in Trash, as anything that would change the note is.
 * `hidden`: there is no such note, as for whoever holds a link.
 */
export type Trashed = "opens" | "refused" | "hidden";

export const IN_TRASH = "This note is in Trash. Restore it to change it.";
