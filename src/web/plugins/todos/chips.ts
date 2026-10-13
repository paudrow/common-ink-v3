import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { completeTodo, parseTodo, rewriteTodo, type Importance } from "../../plugin-api.ts";
import { chips, type Chip, type Token } from "../lib/chips.ts";
import { drawnInView, touched, writable } from "../lib/live.ts";
import { replacing } from "../lib/rewrite.ts";
import { onTodo, todoLines } from "../lib/todoLines.ts";
import { dueLabel, dueState, today } from "./dates.ts";

interface Checkbox extends Token {
  checked: boolean;
}
interface ImportanceMarks extends Token {
  level: Importance;
}
interface Due extends Token {
  date: string;
}

export const IMPORTANCE = ["Normal", "!", "!!", "!!!"] as const;

/**
 * What every chip of a todo shares. It is drawn on exactly the lines the server takes for todos, and
 * over its token's own width, so nothing on the line is anywhere else when the cursor comes and the
 * token is shown as written.
 */
const onTodoLine = { keepsWidth: true, inCode: true, skip: (state: Parameters<typeof onTodo>[0], token: Token) => !onTodo(state, token.from) } as const;

/** A todo's line as checking it off left it, and where that line starts now. */
interface Ticked {
  from: number;
  text: string;
}

const tick = StateEffect.define<Ticked>();

/** The todo last checked off in this editor, followed through every change since: what Undo opens again. */
const ticked = StateField.define<Ticked | null>({
  create: () => null,
  update(was, tr) {
    for (const effect of tr.effects) if (effect.is(tick)) return effect.value;
    return was && tr.docChanged ? { ...was, from: tr.changes.mapPos(was.from, 1) } : was;
  },
});

/** The todo last checked off in `view`, as todo.set takes it, when its line still reads as checking it off left it. */
export function tickedIn(view: EditorView): { line: number; text: string } | null {
  const { doc } = view.state;
  const at = view.state.field(ticked, false);
  const line = at && doc.lineAt(Math.min(at.from, doc.length));
  return line && line.text === at.text ? { line: line.number - 1, text: line.text } : null;
}

/** Opens the todo last checked off in `view` again, as the member's edit. False when its line no longer reads as checking it off left it. */
export function untick(view: EditorView): boolean {
  const at = writable(view.state) ? tickedIn(view) : null;
  if (!at) return false;
  const changes = replacing(at.text, rewriteTodo(at.text, { done: false }), view.state.doc.line(at.line + 1).from);
  if (changes) view.dispatch({ changes, userEvent: "input.task" });
  return true;
}

/** A checkbox that checks its todo off when it is clicked, as `completeTodo` says a todo is, or writes `[ ]` to open it again. `onCompleted` is told of a todo it checked off. */
const checkbox = (onCompleted: (view: EditorView, words: string) => void): Chip<Checkbox> => ({
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
      if (!box.checked) return source.rewrite("[ ]");
      const editor = el.closest<HTMLElement>(".cm-editor");
      const view = editor && EditorView.findFromDOM(editor);
      const at = view?.posAtDOM(el);
      source.rewriteLine(completeTodo);
      if (!view || at === undefined) return;
      // Said only of a todo this left done: a note that can't be written, or a todo that completing leaves open, has nothing to undo.
      const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      const todo = parseTodo(line.text);
      if (!todo?.done) return;
      view.dispatch({ effects: tick.of({ from: line.from, text: line.text }) });
      onCompleted(view, todo.words);
    });
    // The keyboard stays in the note: a box ticked with the pointer is not somewhere the next key goes.
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (event.target !== box) box.click();
    });
    // The tick is an element of its own, so it is painted in the theme's ink.
    el.append(box, document.createElement("i"));
  },
});

/** Draws what a chip says, with the browser's own control laid over it unseen: a click on the chip is a click on the control. */
function over<C extends HTMLInputElement | HTMLSelectElement>(el: HTMLElement, says: string, control: C, name: string, readOnly: boolean): C {
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

const written = Decoration.mark({ class: "md-todo-token" });

/** A todo's token the cursor is on, where it is shown as written: it stays in one piece, as its chip is, so the line wraps where it did. */
const asWritten = drawnInView((view) => {
  const { state } = view;
  const marked: Range<Decoration>[] = [];
  const lines = new Set(state.selection.ranges.flatMap((range) => [state.doc.lineAt(range.from).from, state.doc.lineAt(range.to).from]));
  for (const from of lines) {
    if (!state.field(todoLines).has(from)) continue;
    const todo = parseTodo(state.doc.lineAt(from).text, from);
    for (const token of todo ? [todo.importanceAt, todo.due] : []) if (token && touched(state, token.from, token.to)) marked.push(written.range(token.from, token.to));
  }
  return marked;
});

const look = EditorView.baseTheme({
  // Drawn here and not by the browser, so it is one size and one look on every system, in light and in dark.
  ".md-chip.md-chip-task > :last-child": { inset: "0 -0.35em", cursor: "pointer" },
  ".md-chip-task input": {
    appearance: "none",
    boxSizing: "border-box",
    flex: "none",
    margin: "0",
    width: "1.1em",
    height: "1.1em",
    font: "inherit",
    border: "1.5px solid color-mix(in srgb, var(--muted) 75%, transparent)",
    borderRadius: "0.28em",
    backgroundColor: "var(--bg-elev)",
    cursor: "pointer",
  },
  ".md-chip-task:hover input:enabled": { borderColor: "var(--accent)" },
  ".md-chip-task input:checked": { borderColor: "var(--accent)", backgroundColor: "var(--accent)" },
  ".md-chip-task i": { display: "none", position: "absolute", left: "50%", top: "50%", width: "0.3em", height: "0.58em", margin: "-0.37em 0 0 -0.15em", boxSizing: "border-box", border: "solid var(--on-accent)", borderWidth: "0 0.13em 0.13em 0", transform: "rotate(45deg)", pointerEvents: "none" },
  ".md-chip-task input:checked + i": { display: "block" },
  ".md-chip-task input:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
  ".md-chip-task input:disabled": { cursor: "default", opacity: "0.7" },
  ".md-chip-task:has(input:disabled) > :last-child": { cursor: "default" },
  ".md-todo-token": { whiteSpace: "nowrap" },
  ".md-chip-sized > span.md-todo-chip": { top: "0.2em", bottom: "0.2em", borderRadius: "4px", overflow: "hidden", fontSize: "0.82em", lineHeight: "1", whiteSpace: "nowrap", background: "var(--hover)", color: "var(--muted)" },
  ".md-todo-chip > input, .md-todo-chip > select": { position: "absolute", inset: "0", width: "100%", height: "100%", minWidth: "0", margin: "0", padding: "0", border: "0", opacity: "0", cursor: "pointer", font: "inherit" },
  ".md-todo-chip > :disabled": { cursor: "default" },
  ".md-chip-sized > span.md-todo-chip:focus-within": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".md-chip-sized > span.md-todo-chip[data-due=overdue], .md-chip-sized > span.md-todo-chip[data-level='3']": { background: "var(--removed-soft)", color: "var(--danger)" },
  ".md-chip-sized > span.md-todo-chip[data-due=today], .md-chip-sized > span.md-todo-chip[data-level='2']": { background: "var(--accent-soft)", color: "var(--accent)" },
  ".md-chip-importance > span.md-todo-chip": { fontWeight: "700" },
});

/** Draws a todo's checkbox and its options as chips. `onCompleted` is told of a todo checked off in the note, to be undone with `untick`. */
export const todoChips = (onCompleted: (view: EditorView, words: string) => void): Extension => [todoLines, ticked, chips(checkbox(onCompleted)), chips(importance), chips(due), asWritten, look];
