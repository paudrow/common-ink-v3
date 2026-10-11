import { EditorView, ViewPlugin } from "@codemirror/view";
import { locateTodo, type ListedTodo, type Plugin } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { todoChips } from "./chips.ts";
import { dueOffers, today } from "./dates.ts";
import { everyOffers } from "./recurrence.ts";
import { TodosPage } from "./Todos.tsx";

const MINUTE_MS = 60_000;
/** How long the notes are left to settle before the projects are read again, so typing doesn't ask once a save. */
const SETTLE_MS = 3000;

/**
 * Todos. A checkbox line anywhere in a note is one, and its importance, due date, recurrence and
 * projects are tokens on the line, drawn as chips that rewrite their token when changed. The Todos page lists
 * them across the notes the member can see, and changes one by rewriting its line in its note.
 */
export const todos: Plugin = {
  id: "todos",
  name: "Todos",
  activate(host) {
    const editors = new Map<string, EditorView>();
    let projects: readonly string[] = [];
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

    const open = (todo: ListedTodo) => {
      going = { noteId: todo.noteId, line: todo.line, text: todo.text };
      host.app().openNote(todo.noteId, { focus: true });
      const view = editors.get(todo.noteId);
      if (view) arrive(view);
    };

    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", icon: "todos", nav: "primary", order: 30, component: ({ app }) => <TodosPage host={host} app={app} onOpen={open} /> });

    host.editorExtensions.register({
      id: "todos",
      extension: (editor) => [
        todoChips({ host, noteId: editor.noteId, projects: () => projects }),
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          if (!read) readProjects();
          // After the editor has been given the cursor, which a note that is opened is.
          if (!editor.reading && going?.noteId === editor.noteId) setTimeout(() => going?.noteId === editor.noteId && editors.get(editor.noteId) === view && arrive(view));
          return { destroy: () => void (editors.get(key) === view && editors.delete(key)) };
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

    // A project chip offers the projects there are, which change with any note.
    let read = 0;
    const readProjects = () => {
      const mine = ++read;
      host.perform({ type: "todo.filters" }).then(
        (filters) => {
          if (mine !== read || filters.projects.join("\n") === projects.join("\n")) return;
          projects = filters.projects;
          redrawAll();
        },
        () => {},
      );
    };
    let summary = "";
    let settling: ReturnType<typeof setTimeout> | undefined;
    const offNotes = host.onItems(() => {
      const now = (host.app().notes ?? []).map((n) => `${n.id}:${n.revision}`).join(",");
      if (now === summary) return;
      const first = summary === "";
      summary = now;
      clearTimeout(settling);
      if (first) readProjects();
      else settling = setTimeout(readProjects, SETTLE_MS);
    });

    // A due date says Today or Tomorrow, which stops being true at midnight where the member is.
    let day = today();
    const clock = setInterval(() => {
      if (day === today()) return;
      day = today();
      redrawAll();
    }, MINUTE_MS);

    return () => {
      offNotes();
      clearTimeout(settling);
      clearInterval(clock);
    };
  },
};
