import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { createElement } from "react";
import { parseTodo, rewriteTodo, type Importance, type LastDone, type PluginHost } from "../../plugin-api.ts";
import { chips, type Chip, type Source, type Token } from "../lib/chips.ts";
import { drawnInView } from "../lib/live.ts";
import { onTodo, todoLines } from "../lib/todoLines.ts";
import { openPopover } from "../lib/Popover.tsx";
import { Completions } from "./Completions.tsx";
import { dueLabel, dueState, today } from "./dates.ts";
import { doneLabel, doneName, everyLabel, everyName } from "./recurrence.ts";
import { RuleForm } from "./RuleForm.tsx";

interface Checkbox extends Token {
  checked: boolean;
}
interface ImportanceMarks extends Token {
  level: Importance;
}
interface Due extends Token {
  date: string;
}
interface Project extends Token {
  name: string;
}
interface Every extends Token {
  written: string;
}
interface Done extends Token, LastDone {}

/** What the chips of one note's editor are drawn from besides the note. */
export interface TodoChipsContext {
  host: PluginHost;
  noteId: string;
  /** The projects a project chip offers. */
  projects: () => readonly string[];
}

export const IMPORTANCE = ["Normal", "!", "!!", "!!!"] as const;

/**
 * What every chip of a todo shares. It is drawn on exactly the lines the server takes for todos, and
 * over its token's own width, so nothing on the line is anywhere else when the cursor comes and the
 * token is shown as written.
 */
const onTodoLine = { keepsWidth: true, inCode: true, skip: (state: Parameters<typeof onTodo>[0], token: Token) => !onTodo(state, token.from) } as const;

/**
 * A checkbox that writes `[x]` or `[ ]` when it is clicked, as typing in the brackets does. The server
 * completes a recurring todo whose box a write checked, and the editor takes the line it answers with.
 * Only the server can file the line on the daily note, so nothing is rolled forward here.
 */
const checkbox = ({ host, noteId }: TodoChipsContext): Chip<Checkbox> => ({
  ...onTodoLine,
  id: "task",
  find(line, offset) {
    const todo = parseTodo(line, offset);
    return todo ? [{ ...todo.box, checked: todo.done }] : [];
  },
  draw(el, token, source) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = token.checked;
    box.disabled = source.readOnly;
    box.setAttribute("aria-label", token.checked ? "Done" : "Not done");
    box.addEventListener("change", () => {
      source.rewrite(box.checked ? "[x]" : "[ ]");
      // Saved at once, so the write holds the check alone and not what is typed on the line in the pause after it.
      host.app().saveNote(noteId);
    });
    el.append(box);
  },
});

/** Draws what a chip says, with the browser's own control laid over it unseen: a click on the chip is a click on the control. */
function over<C extends HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(el: HTMLElement, says: string, control: C, name: string, readOnly: boolean): C {
  el.classList.add("md-todo-chip");
  el.append(says, control);
  control.disabled = readOnly;
  control.setAttribute("aria-label", name);
  return control;
}

function choice(options: readonly (readonly [value: string, label: string])[], chosen: string) {
  const select = document.createElement("select");
  for (const [value, label] of options) select.append(new Option(label, value, false, value === chosen));
  return select;
}

const importance: Chip<ImportanceMarks> = {
  ...onTodoLine,
  id: "importance",
  find(line, offset) {
    const todo = parseTodo(line, offset);
    return todo?.importanceAt ? [{ ...todo.importanceAt, level: todo.importance }] : [];
  },
  draw(el, token, source) {
    el.dataset.level = String(token.level);
    const select = over(el, IMPORTANCE[token.level], choice(IMPORTANCE.map((label, level) => [String(level), label] as const), String(token.level)), "Importance", source.readOnly);
    select.addEventListener("change", () => source.rewriteLine((line) => rewriteTodo(line, { importance: Number(select.value) as Importance })));
  },
};

const due: Chip<Due> = {
  ...onTodoLine,
  id: "due",
  find(line, offset) {
    const todo = parseTodo(line, offset);
    return todo?.due ? [todo.due] : [];
  },
  // What it says depends on what day it is, so it is drawn again when the day changes.
  key: () => today(),
  draw(el, token, source) {
    const now = today();
    el.dataset.due = dueState(token.date, now);
    const input = document.createElement("input");
    input.type = "date";
    input.value = token.date;
    over(el, dueLabel(token.date, now), input, "Due date", source.readOnly);
    input.addEventListener("click", () => {
      try {
        input.showPicker();
      } catch {
        // A browser that won't open its calendar from here still takes the date typed into the field.
      }
    });
    input.addEventListener("change", () => source.rewriteLine((line) => rewriteTodo(line, { due: input.value || null })));
  },
};

const NO_PROJECT = "";
const AS_WRITTEN = "\0";

function project(projects: () => readonly string[]): Chip<Project> {
  return {
    ...onTodoLine,
    id: "project",
    find: (line, offset) => parseTodo(line, offset)?.projects ?? [],
    key: () => projects().join("\n"),
    draw(el, token, source) {
      const others = projects().filter((name) => name.toLowerCase() !== token.name.toLowerCase());
      const options = [[token.name, token.name], ...others.map((name) => [name, name] as const), [NO_PROJECT, "No project"], [AS_WRITTEN, "Rename…"]] as const;
      const select = over(el, `+${token.name}`, choice(options, token.name), "Project", source.readOnly);
      select.addEventListener("change", () => {
        if (select.value === AS_WRITTEN) source.edit();
        else source.rewriteLine((line) => rewriteTodo(line, select.value === NO_PROJECT ? { removeProject: token.name } : { removeProject: token.name, addProject: select.value }));
      });
    },
  };
}

/** A button laid over what a chip says, which opens a panel under the chip. */
function opener(el: HTMLElement, says: string, name: string, disabled: boolean, open: (anchor: HTMLButtonElement) => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = name;
  button.setAttribute("aria-haspopup", "dialog");
  over(el, says, button, name, disabled);
  button.addEventListener("click", () => open(button));
}

/** How a todo recurs. A click opens the form that sets it, which rewrites the token, or takes it away with the space before it. */
const every: Chip<Every> = {
  ...onTodoLine,
  id: "every",
  find(line, offset) {
    const todo = parseTodo(line, offset);
    return todo?.every ? [{ from: todo.every.from, to: todo.every.to, written: todo.every.written }] : [];
  },
  draw(el, token, source) {
    opener(el, everyLabel(token.written), everyName(token.written), source.readOnly, (anchor) =>
      openPopover(anchor, "Recurrence", (close) =>
        createElement(RuleForm, {
          every: token.written,
          onSet(next) {
            source.rewriteLine((line) => rewriteTodo(line, { every: next }));
            close();
          },
        }),
      ),
    );
  },
};

/** Whether the server didn't find the line at the revision it was asked at, which it does once what is typed is saved. */
const notFoundYet = (err: unknown) => typeof err === "object" && err !== null && ["conflict", "invalid"].includes((err as { code?: string }).code ?? "");

/**
 * A todo's completions, asked for by its line as the editor has it. The host saves what is typed
 * before it asks, so the revision the app knows may be one behind, where the line isn't what it is
 * now: the server then refuses, and it is asked once more, at the revision the save made.
 */
async function completions({ host, noteId }: TodoChipsContext, source: Source) {
  const ask = async (revision: number) => {
    const line = source.line();
    if (!line) throw new Error("This todo was changed. Open its completions again.");
    return (await host.perform({ type: "todo.history", id: noteId, revision, line: line.index, text: line.text })).completions;
  };
  const known = host.app().notes?.find((note) => note.id === noteId)?.revision;
  if (known !== undefined) {
    try {
      return await ask(known);
    } catch (err) {
      if (!notFoundYet(err)) throw err;
    }
  }
  return ask((await host.perform({ type: "note.read", id: noteId })).revision);
}

/** When a recurring todo was last checked off and how many times. A click lists each time, and who did it. */
function lastDone(context: TodoChipsContext): Chip<Done> {
  return {
    ...onTodoLine,
    id: "done",
    find(line, offset) {
      const todo = parseTodo(line, offset);
      return todo?.lastDone ? [todo.lastDone] : [];
    },
    key: () => today(),
    draw(el, token, source) {
      const now = today();
      // Listing them changes nothing, so someone who can only read may look.
      opener(el, doneLabel(token, now), doneName(token, now), false, (anchor) => {
        const ask = () => completions(context, source);
        openPopover(anchor, "Completions", (close) =>
          createElement(Completions, {
            ask,
            done: token,
            now,
            onOpen(noteId) {
              close();
              context.host.app().openNote(noteId, { reveal: true });
            },
          }),
        );
      });
    },
  };
}

const written = Decoration.mark({ class: "md-todo-token" });

/** A todo's tokens on the cursor's line, where they are shown as written: each stays in one piece, as its chip is, so the line wraps where it did. */
const asWritten = drawnInView((view) => {
  const { state } = view;
  const marked: Range<Decoration>[] = [];
  const lines = new Set(state.selection.ranges.flatMap((range) => [state.doc.lineAt(range.from).from, state.doc.lineAt(range.to).from]));
  for (const from of lines) {
    if (!state.field(todoLines).has(from)) continue;
    const todo = parseTodo(state.doc.lineAt(from).text, from);
    for (const token of todo ? [todo.importanceAt, todo.due, todo.every, todo.lastDone, ...todo.projects] : []) if (token) marked.push(written.range(token.from, token.to));
  }
  return marked;
});

const look = EditorView.baseTheme({
  ".md-chip-task input": { margin: "0", width: "0.85em", height: "0.85em", accentColor: "var(--accent)", cursor: "pointer" },
  ".md-todo-token": { whiteSpace: "nowrap" },
  ".md-chip-sized > span.md-todo-chip": { top: "0.2em", bottom: "0.2em", borderRadius: "4px", overflow: "hidden", fontSize: "0.82em", lineHeight: "1", whiteSpace: "nowrap", background: "var(--hover)", color: "var(--muted)" },
  ".md-todo-chip > input, .md-todo-chip > select, .md-todo-chip > button": { position: "absolute", inset: "0", width: "100%", height: "100%", minWidth: "0", margin: "0", padding: "0", border: "0", opacity: "0", cursor: "pointer", font: "inherit" },
  ".md-todo-chip > :disabled": { cursor: "default" },
  ".md-chip-sized > span.md-todo-chip:focus-within": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".md-chip-sized > span.md-todo-chip[data-due=overdue], .md-chip-sized > span.md-todo-chip[data-level='3']": { background: "var(--removed-soft)", color: "var(--danger)" },
  ".md-chip-sized > span.md-todo-chip[data-due=today], .md-chip-sized > span.md-todo-chip[data-level='2']": { background: "var(--accent-soft)", color: "var(--accent)" },
  ".md-chip-importance > span.md-todo-chip": { fontWeight: "700" },
});

/** Draws a todo's checkbox and its options as chips. */
export const todoChips = (context: TodoChipsContext): Extension => [todoLines, chips(checkbox(context)), chips(importance), chips(due), chips(every), chips(lastDone(context)), chips(project(context.projects)), asWritten, look];
