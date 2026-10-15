import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { createElement, type ReactNode } from "react";
import { changeTodo, parseTodo, rewriteTodo, type Importance, type LastDone, type PluginHost } from "../../plugin-api.ts";
import { BOX_EM } from "../gfm/lists.ts";
import { chips, type Chip, type Source, type Token } from "../lib/chips.ts";
import { drawnInView, touched, writable } from "../lib/live.ts";
import { openPopover } from "../lib/Popover.tsx";
import { replacing } from "../lib/rewrite.ts";
import { onTodo, todoLines } from "../lib/todoLines.ts";
import { ChipMenu } from "./ChipMenu.tsx";
import { Completions } from "./Completions.tsx";
import { dueLabel, dueState, today } from "./dates.ts";
import { CHIP_NAMES, PRIORITY, pickerLabel, type ChipKind } from "./picking.ts";
import { doneLabel, doneName, everyLabel, everyName } from "./recurrence.ts";

interface Checkbox extends Token {
  checked: boolean;
}
interface ImportanceMarks extends Token {
  level: Importance;
}
interface Due extends Token {
  date: string;
}
interface Every extends Token {
  written: string;
}
interface Done extends Token, LastDone {}

/** What the chips of one note's editor are drawn from besides the note. */
export interface TodoChipsContext {
  host: PluginHost;
  noteId: string;
  /** Told of a todo checked off in the note and left done, to be undone with `untick`. */
  onCompleted: (view: EditorView) => void;
  /** Told of a recurring todo checked off in the note, once the server has completed it: the change that did. */
  onRecurred: (revision: number) => void;
}

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

/**
 * A checkbox that writes `[x]` or `[ ]` when it is clicked, as typing in the brackets does. The server
 * completes a recurring todo whose box a write checked, and the editor takes the line it answers with.
 * Only the server can file the line on the daily note, so nothing is rolled forward here.
 */
const checkbox = ({ host, noteId, onCompleted, onRecurred }: TodoChipsContext): Chip<Checkbox> => ({
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
      const editor = el.closest<HTMLElement>(".cm-editor");
      const view = editor && EditorView.findFromDOM(editor);
      const at = view?.posAtDOM(el);
      const was = view && at !== undefined ? parseTodo(view.state.doc.lineAt(Math.min(at, view.state.doc.length)).text) : null;
      // What was typed before the click goes first, in a write of its own, so that the change that completes a recurring todo holds the check alone and Undo takes back nothing else.
      const before = box.checked && was?.every ? host.app().saveNote(noteId) : undefined;
      source.rewrite(box.checked ? "[x]" : "[ ]");
      // Saved at once, so the write holds the check alone and not what is typed on the line in the pause after it.
      const saved = host.app().saveNote(noteId);
      if (!box.checked || !view || at === undefined) return;
      const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      const todo = parseTodo(line.text);
      // A note that can't be written has nothing to undo.
      if (!todo?.done) return;
      if (todo.every) {
        // The server completes it, and says so of the write that checked it: that change is what Undo takes back.
        void Promise.all([saved, before]).then((writes) => {
          const completing = writes.find((note) => note?.filed);
          if (completing) onRecurred(completing.revision);
        });
        return;
      }
      view.dispatch({ effects: tick.of({ from: line.from, text: line.text }) });
      onCompleted(view);
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

/**
 * Draws what a chip says, as a button that opens a panel under it. The press doesn't move the cursor, so
 * the line stays drawn; the keyboard goes back to the note when the panel closes from inside.
 */
function panel(el: HTMLElement, says: string, name: string, label: string, disabled: boolean, open: (close: () => void) => ReactNode) {
  el.classList.add("md-todo-chip");
  el.append(says);
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", name);
  el.setAttribute("aria-haspopup", "dialog");
  if (disabled) return el.setAttribute("aria-disabled", "true");
  el.addEventListener("mousedown", (event) => event.button === 0 && event.preventDefault());
  el.addEventListener("click", () => {
    const editor = el.closest<HTMLElement>(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    el.setAttribute("aria-expanded", "true");
    openPopover(el, label, open, (hadFocus) => {
      el.removeAttribute("aria-expanded");
      if (hadFocus) view?.focus();
    });
  });
}

/**
 * A chip that opens the popover the Todos page opens from the same chip. A pick there rewrites the line as
 * the member's edit, as `todo.set` would: skipping by `skipTodo`, the rest by `rewriteTodo`.
 */
function opener(el: HTMLElement, says: string, chip: ChipKind, source: Source, named = says) {
  panel(el, says, `${CHIP_NAMES[chip]}: ${named}`, pickerLabel(chip), source.readOnly, (close) => {
    const line = source.line();
    const read = line && parseTodo(line.text);
    return createElement(ChipMenu, {
      chip,
      todo: { due: read?.due?.date ?? null, importance: read?.importance ?? 0, every: read?.every?.written ?? null },
      now: today(),
      onClose: close,
      onPick(change) {
        close();
        source.rewriteLine((text) => {
          try {
            return changeTodo(text, change, today()).line;
          } catch {
            // The line was written another way while the popover was open, and has no later time to skip to.
            return text;
          }
        });
      },
      onText() {
        close();
        source.edit();
      },
    });
  });
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
    // The note shows its marks as written, as wide as they are; they are named in words.
    el.title = `Priority: ${PRIORITY[token.level]}`;
    opener(el, "!".repeat(token.level), "importance", source, PRIORITY[token.level]);
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
    opener(el, dueLabel(token.date, now), "due", source);
  },
};

/** How a todo recurs, in a few plain words. A click opens the recurrence popover, which rewrites the token, or takes it away with the space before it. */
const every: Chip<Every> = {
  ...onTodoLine,
  // Its words are longer than its token, so it takes its own width: what follows it on its row moves by the difference, and nothing else does.
  keepsWidth: false,
  id: "every",
  find(line, offset) {
    const todo = parseTodo(line, offset);
    return todo?.every ? [{ from: todo.every.from, to: todo.every.to, written: todo.every.written }] : [];
  },
  draw(el, token, source) {
    // The chip doesn't hold its token as the chips drawn over theirs do, so it says here what it stands for.
    el.dataset.written = `every:${token.written}`;
    el.title = everyName(token.written);
    opener(el, everyLabel(token.written), "every", source);
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
      panel(el, doneLabel(token, now), doneName(token, now), "Completions", false, (close) =>
        createElement(Completions, {
          ask: () => completions(context, source),
          done: token,
          now,
          onOpen(noteId) {
            close();
            context.host.app().openNote(noteId);
          },
        }),
      );
    },
  };
}

const written = Decoration.mark({ class: "md-todo-token" });

/** A todo's token the cursor is on, where it is shown as written: it stays in one piece, as its chip is, so the line wraps where it did. */
const asWritten = drawnInView((view) => {
  const { state } = view;
  const marked: Range<Decoration>[] = [];
  const lines = new Set(state.selection.ranges.flatMap((range) => [state.doc.lineAt(range.from).from, state.doc.lineAt(range.to).from]));
  for (const from of lines) {
    if (!state.field(todoLines).has(from)) continue;
    const todo = parseTodo(state.doc.lineAt(from).text, from);
    for (const token of todo ? [todo.importanceAt, todo.due, todo.every, todo.lastDone] : []) if (token && touched(state, token.from, token.to)) marked.push(written.range(token.from, token.to));
  }
  return marked;
});

const look = EditorView.baseTheme({
  // Drawn here and not by the browser, so it is one size and one look on every system, in light and in dark. It is as wide
  // as the box, and so is the `[ ]`, `[x]` or `[X]` it stands for when that is shown as written, so neither moves the words.
  ".md-chip.md-chip-task": { width: `${BOX_EM}em` },
  ".md-chip.md-chip-task > :last-child": { inset: "0 -0.35em", paddingLeft: "0.35em", justifyContent: "flex-start", cursor: "pointer" },
  ".md-chip-task input": {
    appearance: "none",
    boxSizing: "border-box",
    flex: "none",
    margin: "0",
    width: `${BOX_EM}em`,
    height: `${BOX_EM}em`,
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
  // The Todos page's chips, in a note: only a due date's changes colour, as it comes and passes.
  ".md-chip-sized > span.md-todo-chip": { top: "0.2em", bottom: "0.2em", borderRadius: "999px", overflow: "hidden", fontSize: "0.75em", fontWeight: "500", lineHeight: "1", whiteSpace: "nowrap", background: "var(--hover)", color: "var(--chip-ink)", cursor: "pointer" },
  ".md-chip-sized > span.md-todo-chip:hover": { boxShadow: "inset 0 0 0 1px var(--line-strong)" },
  ".md-chip-sized > span.md-todo-chip[aria-expanded]": { boxShadow: "inset 0 0 0 1px var(--accent)" },
  ".md-chip-sized > span.md-todo-chip[aria-disabled]": { cursor: "default", boxShadow: "none" },
  ".md-chip-sized > span.md-todo-chip[data-due=today]": { background: "color-mix(in srgb, var(--warn) 16%, transparent)", color: "var(--warn-ink)" },
  ".md-chip-sized > span.md-todo-chip[data-due=overdue]": { background: "color-mix(in srgb, var(--danger) 14%, transparent)", color: "var(--danger)" },
  ".md-chip-importance > span.md-todo-chip": { fontWeight: "700" },
  // A pill as the others are, smaller than the line and no taller, on the line's own baseline, so the line is as high with it as with its token.
  ".md-chip-every": { position: "relative", display: "inline-block", padding: "0 0.6em", borderRadius: "999px", fontSize: "0.75em", fontWeight: "500", lineHeight: "1.5", whiteSpace: "nowrap", background: "var(--hover)", color: "var(--chip-ink)", cursor: "pointer" },
  ".md-chip-every:hover": { boxShadow: "inset 0 0 0 1px var(--line-strong)" },
  ".md-chip-every[aria-expanded]": { boxShadow: "inset 0 0 0 1px var(--accent)" },
  ".md-chip-every[aria-disabled]": { cursor: "default", boxShadow: "none" },
});

/** Draws a todo's checkbox and its options as chips. */
export const todoChips = (context: TodoChipsContext): Extension => [todoLines, ticked, chips(checkbox(context)), chips(importance), chips(due), chips(every), chips(lastDone(context)), asWritten, look];
