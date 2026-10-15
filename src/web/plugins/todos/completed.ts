import type { PluginHost } from "../../plugin-api.ts";

/** What Undo says when the line is no longer the todo that was checked off. Nothing is changed then. */
export const CHANGED = "That todo was changed since it was checked off, so it was left as it is.";

/** What Undo says when it opened the todo again and the line filed for it was changed since, so that line stays. */
export const LEFT_FILED = "It is open again. The line filed on the daily note was changed since, so it was left there.";

/** What an Undo that was refused says: the note changed under it, or the server's own reason. */
export const refused = (err: unknown) => ((err as { code?: unknown } | null)?.code === "conflict" ? CHANGED : err instanceof Error ? err.message : "The todo couldn't be opened again.");

/**
 * Says a todo was checked off, with an Undo that opens it again. Both places a todo is checked off
 * say it here: the Todos page and a note's checkbox. It doesn't say which todo: the member has just
 * pressed it. `undo` answers with what to say when the todo couldn't be opened again, and with nothing when it was.
 */
export const completed = (host: PluginHost, undo: () => Promise<string | undefined> | string | undefined) =>
  host.app().notify({
    message: "Task completed",
    icon: "check",
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
    return refused(err);
  }
}
