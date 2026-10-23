import { Facet, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, showTooltip, type Tooltip, type TooltipView } from "@codemirror/view";
import { parseTodo, type PluginHost, type Todo } from "../../plugin-api.ts";
import { writable } from "../lib/live.ts";
import { openFrom, openPopover } from "../lib/Popover.tsx";
import { replacing } from "../lib/rewrite.ts";
import { todoLines } from "../lib/todoLines.ts";
import { CHIP_ICONS } from "./chipIcons.ts";
import { chipMenu, tagMenu } from "./chips.ts";
import { CHIP_NAMES, pickerLabel, type RowChip } from "./picking.ts";

/**
 * What a todo can be given from beside it in a note, in the order the Todos page has them: its chip's
 * icon and title there, and whether the todo has it.
 */
const OPTIONS: readonly { chip: RowChip; icon: string; title: string; has: (todo: Todo) => boolean }[] = [
  { chip: "due", icon: CHIP_ICONS.due, title: "Add date", has: (todo) => todo.due !== null },
  { chip: "every", icon: CHIP_ICONS.every, title: "Repeat", has: (todo) => todo.every !== null },
  { chip: "importance", icon: CHIP_ICONS.importance, title: "Priority", has: (todo) => todo.importance > 0 },
  // A todo can always have one more tag.
  { chip: "tag", icon: '<span class="chip-hash" aria-hidden="true"></span>', title: "Add tag", has: () => false },
];

/** The host the tag picker reads the workspace's tags through. */
const hostIs = Facet.define<PluginHost, PluginHost | null>({ combine: (hosts) => hosts[0] ?? null });

/** How far after a todo's words its controls start, in the text's own size. */
const AFTER_EM = 0.5;

/**
 * The todo lines whose controls are shown, each by where it starts: the one the pointer is on, the one
 * a popover was opened from until it closes, and the cursor's while the editor has the keyboard.
 */
interface Shown {
  pointed: number | null;
  opened: number | null;
  focused: boolean;
}

const shownIs = StateEffect.define<Partial<Shown>>();

const startOf = (state: EditorState, pos: number | null) => (pos === null ? null : state.doc.lineAt(Math.min(pos, state.doc.length)).from);

const shown = StateField.define<Shown>({
  create: () => ({ pointed: null, opened: null, focused: false }),
  update(value, tr) {
    const mapped = (from: number | null) => startOf(tr.state, from === null ? null : tr.changes.mapPos(from));
    let next = tr.docChanged ? { ...value, pointed: mapped(value.pointed), opened: mapped(value.opened) } : value;
    for (const effect of tr.effects) if (effect.is(shownIs)) next = { ...next, ...effect.value };
    return next;
  },
});

/** A shown line's controls, by where its line starts and which it offers: while both are the same, so are its buttons. */
interface Adds extends Tooltip {
  from: number;
  chips: string;
}

/**
 * The Todos page's chips for what a todo has nothing set for yet, each opening the popover its chip
 * there opens. They float level with the end of its words, in no room of the line's, so showing them
 * moves nothing, and they are kept in the window as any of the editor's tooltips is.
 */
function made(from: number, chips: readonly RowChip[]) {
  return (view: EditorView): TooltipView => {
    /** Where the line ends now, as the tooltip was last placed. */
    let end = view.state.doc.lineAt(from).to;
    const dom = document.createElement("div");
    dom.className = "md-todo-adds";
    for (const { chip, icon, title } of OPTIONS.filter((option) => chips.includes(option.chip))) {
      const button = dom.appendChild(document.createElement("button"));
      button.type = "button";
      button.className = `todo-chip ${chip === "tag" ? "todo-add-tag" : `todo-${chip}`}`;
      button.dataset.chip = chip;
      button.dataset.unset = "";
      button.title = title;
      button.setAttribute("aria-label", chip === "tag" ? title : `${CHIP_NAMES[chip]}: none`);
      button.setAttribute("aria-haspopup", "dialog");
      // Tab would take the keyboard from the note, which hides them: the palette's commands are the keyboard's way to them.
      button.tabIndex = -1;
      button.innerHTML = icon;
      // The press doesn't take the keyboard from the note, so the line stays as it was drawn.
      button.addEventListener("mousedown", (event) => event.button === 0 && event.preventDefault());
      button.addEventListener("click", () => openOption(view, chip, button, view.state.doc.lineAt(Math.min(end, view.state.doc.length)).from));
    }
    return {
      dom,
      // Level with the line, not flipped above it or squeezed, at the bottom of the window as anywhere.
      resize: false,
      getCoords(pos) {
        end = pos;
        dom.dataset.from = String(view.state.doc.lineAt(pos).from);
        const at = view.coordsAtPos(pos, -1) ?? { left: 0, right: 0, top: 0, bottom: 0 };
        const left = at.right + AFTER_EM * parseFloat(getComputedStyle(view.contentDOM).fontSize);
        const top = (at.top + at.bottom - dom.offsetHeight) / 2;
        return { left, right: left, top, bottom: top };
      },
    };
  };
}

/** The controls of the lines shown in `state`, kept as they were for a line that is still shown, `changes` having moved it. */
/**
 * The open todo on the line starting at `from`, which is offered more. As on the Todos page, one that is done or put away
 * shows what it had, and a box with no space after it yet isn't drawn as one, so it is offered nothing either.
 */
function openTodoAt(state: EditorState, from: number): Todo | null {
  if (!state.field(todoLines).has(from)) return null;
  const line = state.doc.lineAt(from);
  const todo = parseTodo(line.text);
  return todo?.state === "open" && todo.box.to < line.length ? todo : null;
}

function addsIn(state: EditorState, had: readonly Adds[], changes?: ChangeDesc): readonly Adds[] {
  // Someone who can only read the note sees what is set, as chips, and nothing to set.
  if (!writable(state)) return had.length ? [] : had;
  const { pointed, opened, focused } = state.field(shown);
  const adds: Adds[] = [];
  for (const from of new Set([opened, pointed, focused ? state.doc.lineAt(state.selection.main.head).from : null])) {
    const todo = from === null ? null : openTodoAt(state, from);
    if (from === null || !todo) continue;
    const line = state.doc.lineAt(from);
    const chips = OPTIONS.filter((option) => !option.has(todo)).map((option) => option.chip);
    if (!chips.length) continue;
    const same = had.find((was) => (changes ? changes.mapPos(was.from) : was.from) === from && was.chips === chips.join());
    adds.push(same?.pos === line.to && same.from === from ? same : { pos: line.to, above: false, strictSide: true, from, chips: chips.join(), create: same?.create ?? made(from, chips) });
  }
  return adds.length === had.length && adds.every((tip, i) => tip === had[i]) ? had : adds;
}

const tooltips = StateField.define<readonly Adds[]>({
  create: (state) => addsIn(state, []),
  update: (had, tr) => addsIn(tr.state, had, tr.changes),
  provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
});

/** Which todo line the pointer is on, the room after its words included. On the controls it stays where it was. */
const pointing = ViewPlugin.define((view) => {
  const point = (to: number | null) => {
    if (to !== view.state.field(shown).pointed) view.dispatch({ effects: shownIs.of({ pointed: to }) });
  };
  const move = (event: MouseEvent) => {
    // Not while a selection is being dragged, nor on the controls themselves.
    if (event.buttons || (event.target instanceof Element && event.target.closest(".md-todo-adds"))) return;
    const { from } = view.state.doc.lineAt(view.posAtCoords({ x: event.clientX, y: event.clientY }, false));
    point(view.state.field(todoLines).has(from) ? from : null);
  };
  const leave = () => point(null);
  view.dom.addEventListener("mousemove", move);
  view.dom.addEventListener("mouseleave", leave);
  return {
    destroy() {
      view.dom.removeEventListener("mousemove", move);
      view.dom.removeEventListener("mouseleave", leave);
    },
  };
});

/**
 * Opens the popover of `chip` for the todo whose line starts at `from`, as its chip on the Todos page
 * does, and keeps that line's controls while it is open. A pick rewrites the line as the member's
 * edit, with the tokens they would type.
 */
function openOption(view: EditorView, chip: RowChip, anchor: HTMLElement, from: number) {
  if (view.state.field(shown).opened !== from) view.dispatch({ effects: shownIs.of({ opened: from }) });
  /** The todo's line, unless it is gone or is a todo no more. */
  const lineOf = () => {
    const at = view.state.field(shown).opened;
    return at !== null && view.state.field(todoLines).has(at) ? view.state.doc.lineAt(at) : undefined;
  };
  anchor.setAttribute("aria-expanded", "true");
  openPopover(
    anchor,
    pickerLabel(chip),
    (close) => {
      const rewriteLine = (next: (line: string) => string) => {
        const line = writable(view.state) ? lineOf() : undefined;
        const changes = line && replacing(line.text, next(line.text), line.from);
        if (changes) view.dispatch({ changes, userEvent: `input.${chip}` });
      };
      const host = view.state.facet(hostIs);
      return chip === "tag" ? host && tagMenu(host, lineOf()?.text, close, rewriteLine) : chipMenu(chip, lineOf()?.text, close, rewriteLine);
    },
    (hadFocus) => {
      anchor.removeAttribute("aria-expanded");
      if (hadFocus) view.focus();
      // After what was picked is written: a pick closes the popover first, and is written to the line it was opened from. Not if
      // another has been opened since. The editor is told it has the keyboard back with it, so the cursor's controls stay.
      queueMicrotask(() => {
        if (!openFrom(anchor) && !document.querySelector(".md-todo-adds [aria-expanded]")) view.dispatch({ effects: shownIs.of({ opened: null, focused: view.hasFocus }) });
      });
    },
  );
}

/** The note editor the keyboard was last in, which the palette leaves for a moment. */
let last: EditorView | null = null;

const remembered = ViewPlugin.define((view) => {
  const focus = () => (last = view);
  if (view.hasFocus) focus();
  view.contentDOM.addEventListener("focus", focus);
  return {
    destroy() {
      view.contentDOM.removeEventListener("focus", focus);
      if (last === view) last = null;
    },
  };
});

/** The editor the keyboard is in, or was last in, when its cursor is on a todo it can change. */
export function todoAtCursor(): EditorView | null {
  const view = last?.dom.isConnected ? last : null;
  if (!view || !writable(view.state)) return null;
  return openTodoAt(view.state, view.state.doc.lineAt(view.state.selection.main.head).from) ? view : null;
}

/**
 * Opens the popover of `chip` for the todo the cursor is on: from its chip when the line draws one, and
 * otherwise from its control beside the line, once that is shown and placed.
 */
export function openOptionHere(chip: RowChip) {
  const view = todoAtCursor();
  if (!view) return;
  const { from } = view.state.doc.lineAt(view.state.selection.main.head);
  const { node } = view.domAtPos(from);
  const line = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line");
  const drawnChip = line?.querySelector<HTMLElement>(`.md-chip-${chip} .md-todo-chip, .md-chip-${chip}.md-todo-chip`);
  // A tag's chip is the tag itself, and adding one is always from the control beside the line.
  if (drawnChip && chip !== "tag") return drawnChip.click();
  view.dispatch({ effects: [shownIs.of({ opened: from }), EditorView.scrollIntoView(view.state.selection.main.head)] });
  // The control is made at once and placed in the editor's next measure, which a frame after this one has done.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const button = view.dom.querySelector<HTMLElement>(`.md-todo-adds[data-from="${from}"] [data-chip=${chip}]`);
      if (button) openOption(view, chip, button, from);
      else view.dispatch({ effects: shownIs.of({ opened: null }) });
    }),
  );
}

const look = EditorView.baseTheme({
  ".cm-tooltip.md-todo-adds": { display: "flex", gap: "2px", border: "none", borderRadius: "999px", background: "var(--bg)" },
  // The Todos page's chips for what isn't set, as they are drawn on a row that is pointed at.
  ".md-todo-adds .todo-chip[data-unset]": { opacity: "1", borderColor: "var(--faint)", color: "var(--chip-ink)", cursor: "pointer" },
});

/** Beside a todo's line in a note it can change, while the line is pointed at or has the cursor, controls to give it a due date, a repeat, a priority or a tag. */
export const todoAdds = (host: PluginHost): Extension => [hostIs.of(host), todoLines, shown, tooltips, pointing, remembered, EditorView.focusChangeEffect.of((_, focusing) => shownIs.of({ focused: focusing })), look];
