import { EditorView, ViewPlugin } from "@codemirror/view";
import { locateTodo, type ListedTodo, type PluginHost } from "../../plugin-api.ts";

/** A todo as a listing gave it, which is what it is found again by. */
export type ListedAt = Pick<ListedTodo, "noteId" | "line" | "text">;

/**
 * A way to open a todo's note with the cursor on the todo's line, in front or beside it, for a plugin that lists todos. The
 * line is found by what it says, so it is the right one when the note has been written another way
 * since it was listed. It is an editor extension of the plugin's own, since the note's editor may
 * not be there yet when the todo is picked.
 */
export function todoOpener(host: PluginHost): (todo: ListedAt, beside?: boolean) => void {
  /** Each note's editors, the one opened last at the end. */
  const editors = new Map<string, EditorView[]>();
  /** The todo to put the cursor on once its note's editor is there. */
  let going: ListedAt | null = null;

  const arrive = (view: EditorView) => {
    const at = going;
    going = null;
    if (!at) return;
    const { doc } = view.state;
    // The line it was listed on, when the note has since been written another way.
    const line = locateTodo(doc.toString(), at)?.line ?? Math.min(at.line, doc.lines - 1);
    const { from, to } = doc.line(line + 1);
    view.dispatch({ selection: { anchor: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
  };

  host.editorExtensions.register({
    id: `${host.plugin.id}.open-todo`,
    extension: ({ noteId, reading }) =>
      reading ? [] : ViewPlugin.define((view) => {
        editors.set(noteId, [...(editors.get(noteId) ?? []), view]);
        // After the editor has been given the cursor, which a note that is opened is.
        if (going?.noteId === noteId) setTimeout(() => going?.noteId === noteId && editors.get(noteId)?.includes(view) && arrive(view));
        return {
          destroy: () => {
            const left = (editors.get(noteId) ?? []).filter((v) => v !== view);
            if (left.length) editors.set(noteId, left);
            else editors.delete(noteId);
          },
        };
      }),
  });

  return (todo, beside) => {
    going = { noteId: todo.noteId, line: todo.line, text: todo.text };
    const app = host.app();
    // In a split beside what is in front, whose editor arrives at the line once it is made.
    if (beside && app.openBeside) return app.openBeside({ kind: "note", id: todo.noteId }, "right");
    app.openNote(todo.noteId, { focus: true });
    // Open in two panes, it arrives in the one the member is in.
    const views = editors.get(todo.noteId) ?? [];
    const view = views.find((v) => v.hasFocus) ?? views.at(-1);
    if (view) arrive(view);
  };
}
