import { EditorView, ViewPlugin } from "@codemirror/view";
import { locateTodo, type ListedTodo, type Plugin } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { tickedIn, todoChips, untick } from "./chips.ts";
import { CHANGED, completed, refused, takeBack } from "./completed.ts";
import { dueOffers, today } from "./dates.ts";
import { everyOffers } from "./recurrence.ts";
import { TodosPage } from "./Todos.tsx";

const MINUTE_MS = 60_000;

/**
 * Todos. A checkbox line anywhere in a note is one, and its importance, due date and recurrence are
 * tokens on the line, drawn as chips that rewrite their token when changed. The Todos page lists
 * them across the notes the member can see, and changes one by rewriting its line in its note.
 */
export const todos: Plugin = {
  id: "todos",
  name: "Todos",
  description: "Checkbox lines with due dates, importance and repeats, and a page of every todo.",
  icon: "todos",
  screenshots: [{ src: "/plugin-shots/todos-light.png", dark: "/plugin-shots/todos-dark.png", alt: "The Todos page: every open todo with its importance, its due date and the note it is in." }],
  activate(host) {
    const editors = new Map<string, EditorView>();
    /** The editors there are now, a reading of a note among them. */
    const alive = new Set<EditorView>();
    /** The todo to put the cursor on once its note's editor is there. */
    let going: Pick<ListedTodo, "noteId" | "line" | "text"> | null = null;

    const redrawAll = () => {
      for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
    };

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

    /** Opens a todo's note with the cursor on its line: in front, or in a split beside it, whose editor arrives there once it is made. */
    const open = (todo: ListedTodo, beside?: boolean) => {
      going = { noteId: todo.noteId, line: todo.line, text: todo.text };
      const app = host.app();
      if (beside && app.openBeside) return app.openBeside({ kind: "note", id: todo.noteId }, "right");
      app.openNote(todo.noteId, { focus: true });
      const view = editors.get(todo.noteId);
      if (view) arrive(view);
    };

    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", icon: "todos", nav: "primary", order: 30, component: ({ app }) => <TodosPage host={host} app={app} onOpen={open} /> });

    /** Opens again the todo checked off in a note's editor: there as the member's edit, or through todo.set once that editor is gone. */
    const reopen = async (noteId: string, view: EditorView) => {
      if (alive.has(view)) return untick(view) ? undefined : CHANGED;
      const at = tickedIn(view);
      if (!at) return CHANGED;
      try {
        const { revision, text } = await host.perform({ type: "note.read", id: noteId });
        // The editor is gone, so lines written above the todo since moved it: it is the one line that still reads as checking it off left it.
        const lines = text.split("\n");
        const reads = lines.flatMap((line, i) => (line === at.text ? [i] : []));
        const line = lines[at.line] === at.text ? at.line : reads.length === 1 ? reads[0]! : null;
        if (line === null) return CHANGED;
        host.app().noteChanged(await host.perform({ type: "todo.set", id: noteId, revision, line, text: at.text, done: false }));
        return undefined;
      } catch (err) {
        return refused(err);
      }
    };

    host.editorExtensions.register({
      id: "todos",
      extension: (editor) => [
        todoChips({ host, noteId: editor.noteId, onCompleted: (view) => completed(host, () => reopen(editor.noteId, view)), onRecurred: (revision) => completed(host, () => takeBack(host, editor.noteId, revision)) }),
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          alive.add(view);
          // After the editor has been given the cursor, which a note that is opened is.
          if (!editor.reading && going?.noteId === editor.noteId) setTimeout(() => going?.noteId === editor.noteId && editors.get(editor.noteId) === view && arrive(view));
          return {
            destroy() {
              alive.delete(view);
              if (editors.get(key) === view) editors.delete(key);
            },
          };
        }),
      ],
    });

    host.completions.register({
      id: "todos.due",
      trigger: "due:",
      items: (typed) => dueOffers(typed, today()).map(({ label, day }) => ({ label, detail: day, insert: `due:${day}` })),
    });

    host.completions.register({
      id: "todos.every",
      trigger: "every:",
      items: (typed) => everyOffers(typed).map(({ label, every }) => ({ label, detail: every, insert: `every:${every}` })),
    });

    // A due date says Today or Tomorrow, which stops being true at midnight where the member is.
    let day = today();
    const clock = setInterval(() => {
      if (day === today()) return;
      day = today();
      redrawAll();
    }, MINUTE_MS);

    return () => clearInterval(clock);
  },
};
