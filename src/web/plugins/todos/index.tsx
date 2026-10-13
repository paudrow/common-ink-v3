import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Plugin } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { todoOpener } from "../lib/openTodo.ts";
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
  description: "Checkbox lines with due dates, importance and recurrence, and a page of every todo.",
  icon: "todos",
  screenshots: [{ src: "/plugin-shots/todos-light.png", dark: "/plugin-shots/todos-dark.png", alt: "The Todos page: every open todo with its importance, its due date and the note it is in." }],
  activate(host) {
    const editors = new Map<string, EditorView>();
    let projects: readonly string[] = [];
    const redrawAll = () => {
      for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
    };

    const open = todoOpener(host);

    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", icon: "todos", nav: "primary", order: 30, component: ({ app }) => <TodosPage host={host} app={app} onOpen={open} /> });

    host.editorExtensions.register({
      id: "todos",
      extension: (editor) => [
        todoChips({ host, noteId: editor.noteId, projects: () => projects }),
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          if (!read) readProjects();
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
