import { showToast } from "../lib/toast.tsx";

/** What Undo says when the line is no longer the todo that was checked off. Nothing is changed then. */
export const CHANGED = "That todo was changed since it was checked off, so it was left as it is.";

/** What an Undo that was refused says: the note changed under it, or the server's own reason. */
export const refused = (err: unknown) => ((err as { code?: unknown } | null)?.code === "conflict" ? CHANGED : err instanceof Error ? err.message : "The todo couldn't be opened again.");

/**
 * Says a todo was checked off, with an Undo that opens it again. Both places a todo is checked off
 * say it here: the Todos page and a note's checkbox. It doesn't say which todo: the member has just
 * pressed it. `undo` answers with what to say when the todo couldn't be opened again, and with nothing when it was.
 */
export const completed = (undo: () => Promise<string | undefined> | string | undefined) => showToast({ text: "Task completed", undo });
