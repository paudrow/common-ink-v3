import type { IconName, PluginHost } from "../../plugin-api.ts";
import type { Step } from "../lib/listHistory.ts";
import { PUTTING, toldOf, type PutAway } from "./picking.ts";

/** What Undo says when the line is no longer the todo it was `since` something was done to it: "it was checked off". Nothing is changed then. */
export const changedSince = (since: string) => `That todo was changed since ${since}, so it was left as it is.`;

/** What Undo says when the line is no longer the todo that was checked off. */
export const CHANGED = changedSince(`it was ${PUTTING.done.past}`);

/** What Undo says when it opened the todo again and the line filed for it was changed since, so that line stays. */
export const LEFT_FILED = "It is open again. The line filed on the daily note was changed since, so it was left there.";

/** What an Undo of putting a todo away that was refused says: the note changed under it, or the server's own reason. */
export const refused = (err: unknown, to: PutAway) => ((err as { code?: unknown } | null)?.code === "conflict" ? changedSince(`it was ${PUTTING[to].past}`) : err instanceof Error ? err.message : "The todo couldn't be put back as it was.");

/**
 * Says a todo was put away, "Task completed" or "Task abandoned", with an Undo that puts it back as it
 * was, as a note's checkbox says one checked off there; the Todos page says it as a step of the lists'
 * undo (`todoStep`), in the same words. It doesn't say which todo: the member has just pressed it.
 * `undo` answers with what to say when the todo couldn't be put back, and with nothing when it was.
 */
export const putAway = (host: PluginHost, to: PutAway, undo: () => Promise<string | undefined> | string | undefined) =>
  host.app().notify({
    message: toldOf(to, 1),
    icon: PUTTING[to].icon,
    action: {
      label: "Undo",
      run: async () => {
        const problem = await undo();
        return problem ? { message: problem } : undefined;
      },
    },
  });

/**
 * Takes back the completion of a recurring todo that the note's change `revision` made, whole: that
 * change is reverted as History reverts one, which puts the line back with its due date, its
 * `done:` mark and its count, takes the filed line off the daily note, and leaves the completion
 * out of the todo's history. It is a change of its own in History, and an open editor takes it.
 * Where a later change wrote on the todo's line, nothing is changed and `CHANGED` is the answer.
 */
export async function takeBack(host: PluginHost, noteId: string, revision: number): Promise<string | undefined> {
  try {
    const preview = await host.perform({ type: "note.previewRevert", id: noteId, revisions: [revision] });
    if (preview.overlaps.length) return CHANGED;
    // No choices are given, so a revert that would have a conflict to settle after all is refused whole.
    const reverted = await host.perform({ type: "note.revertChanges", id: noteId, revisions: [revision], resolve: { at: preview.revision, choices: [] } });
    host.app().noteChanged(reverted);
    return reverted.unfiled?.left ? LEFT_FILED : undefined;
  } catch (err) {
    return refused(err, "done");
  }
}

/** The changes the Todos page made to notes, as "note revision": a later one of these on a todo's line is the member's own from the page, which an undo follows. */
const madeHere = new Set<string>();

/** Tells of a change the Todos page made to a note. */
export const madeOnPage = (noteId: string, revision: number) => void madeHere.add(`${noteId} ${revision}`);

/**
 * A change the Todos page made to a todo's line, at `revision`, as a step that can be undone: undo
 * takes back exactly that change, and redo exactly that undo, and so on, whatever else was written in
 * the note since, keeping what the page changed on the line after it, as a priority picked. Where the
 * line was written on elsewhere since, or nothing would change, nothing is changed and it says the
 * todo was changed `since` what was done, "it was checked off". An undo that opens a recurring todo
 * again says so when the line filed for it on a daily note was left there, changed since.
 */
export function todoStep(host: PluginHost, noteId: string, revision: number, told: string, since: string, icon?: IconName): Step {
  let at = revision;
  const take = (type: "note.undo" | "note.redo") => async () => {
    const preview = await host.perform({ type: "note.previewRevert", id: noteId, revisions: [at] });
    if (!preview.diff.hunks.length || preview.overlaps.some((later) => !madeHere.has(`${noteId} ${later}`))) throw new Error(changedSince(type === "note.undo" ? since : "it was put back"));
    const note = await host.perform({ type, id: noteId, revision: at });
    at = note.revision;
    madeOnPage(noteId, at);
    host.app().noteChanged(note);
    return type === "note.undo" && note.unfiled?.left ? LEFT_FILED : undefined;
  };
  return { told, icon, undo: take("note.undo"), redo: take("note.redo") };
}
