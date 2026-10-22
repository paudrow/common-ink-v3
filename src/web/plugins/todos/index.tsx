import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Plugin } from "../../plugin-api.ts";
import { editorKey, redraw } from "../lib/live.ts";
import { todoOpener } from "../lib/openTodo.ts";
import { openOptionHere, todoAdds, todoAtCursor } from "./lineControls.ts";
import { tickedIn, todoChips, untick } from "./chips.ts";
import { CHANGED, putAway, refused, takeBack } from "./completed.ts";
import { dueOffers, today } from "./dates.ts";
import { PUTTING, type ChipKind, type PutAway } from "./picking.ts";
import { everyOffers } from "./recurrence.ts";
import { SORTS, TodosPage, putterHere } from "./Todos.tsx";

const MINUTE_MS = 60_000;

/**
 * Todos. A checkbox line anywhere in a note is one, and its priority, due date and recurrence are
 * tokens on the line, drawn as chips that rewrite their token when changed. The Todos page lists
 * them across the notes the member can see, and changes one by rewriting its line in its note.
 */
export const todos: Plugin = {
  id: "todos",
  name: "Todos",
  description: "Checkbox lines with due dates, priorities and repeats, and a page of every todo.",
  icon: "todos",
  screenshots: [{ src: "/plugin-shots/todos-light.png", dark: "/plugin-shots/todos-dark.png", alt: "The Todos page: every open todo with its priority, its due date and the note it is in." }],
  settings: {
    sort: {
      type: "string",
      default: "due",
      enum: Object.keys(SORTS),
      remembered: true,
      title: "Order of the Todos page",
      description: "What the Todos page is sorted by, chosen with its Sort menu. It is kept with your account, so every browser you sign in on shows the same order.",
    },
    sayWhyLeaving: {
      type: "boolean",
      default: true,
      title: "Say why a changed todo will leave the list",
      description: "On the Todos page, a todo you change so that it no longer matches the filters stays, greyed, until you refresh. On, a line under it says what changed and why it will leave. Off, it is only greyed.",
    },
    keepPutAway: {
      type: "boolean",
      default: false,
      title: "Leave todos in place when you check them off",
      description: "On the Todos page, a todo you check off, abandon or move to the backlog leaves the list a moment later. On, it stays where it is, in its new state, until the list is refreshed: when you come back to the page or change the filter. The notice with Undo comes either way.",
    },
  },
  activate(host) {
    const editors = new Map<string, EditorView>();
    /** The editors there are now, a reading of a note among them. */
    const alive = new Set<EditorView>();
    const redrawAll = () => {
      for (const view of editors.values()) view.dispatch({ effects: redraw.of(null) });
    };

    const open = todoOpener(host);

    host.views.register("page", { id: "todos", path: "/todos", label: "Todos", icon: "todos", nav: "primary", order: 30, component: ({ app }) => <TodosPage host={host} app={app} onOpen={open} /> });

    // Keys for the row of a list of todos the keyboard is on, whether or not vim's are on: vim's dd presses the row's Abandon.
    for (const [to, { command, title, keys }] of Object.entries(PUTTING) as [PutAway, (typeof PUTTING)[PutAway]][]) {
      host.commands.register({ id: command, title, keys, group: "Todos", when: () => putterHere() !== null, run: () => putterHere()?.(to) });
    }

    // The keyboard's way to the controls beside a todo in a note, from the line the cursor is on.
    for (const [chip, title] of [
      ["due", "Set this todo's due date"],
      ["every", "Set how this todo repeats"],
      ["importance", "Set this todo's priority"],
    ] as const satisfies readonly (readonly [ChipKind, string])[]) {
      host.commands.register({ id: `todos.set.${chip}`, title, group: "Todos", when: () => todoAtCursor() !== null, run: () => openOptionHere(chip) });
    }

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
        host.app().noteChanged(await host.perform({ type: "todo.set", id: noteId, revision, line, text: at.text, state: "open" }));
        return undefined;
      } catch (err) {
        return refused(err, "done");
      }
    };

    host.editorExtensions.register({
      id: "todos",
      extension: (editor) => [
        todoChips({ host, noteId: editor.noteId, onCompleted: (view) => putAway(host, "done", () => reopen(editor.noteId, view)), onRecurred: (revision) => putAway(host, "done", () => takeBack(host, editor.noteId, revision)) }),
        todoAdds,
        ViewPlugin.define((view) => {
          const key = editorKey(editor);
          editors.set(key, view);
          alive.add(view);
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
