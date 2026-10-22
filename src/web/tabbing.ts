import { indentLess, indentMore } from "@codemirror/commands";
import { getIndentUnit, indentString } from "@codemirror/language";
import { ChangeSet, EditorSelection, countColumn, type ChangeSpec, type Extension, type Text } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { isModifier } from "./keybindings.ts";
import { bulletAt, linesIn } from "./plugins/bullets/outlining.ts";
import { indent, outdent, type Edit } from "./plugins/bullets/outline.ts";

/** How long after Escape a Tab leaves the note, as CodeMirror's own tab-focus mode has it. */
const LEAVE_MS = 2000;
/** When Escape was last pressed in each note's text, until another key is. */
const escaped = new WeakMap<Element, number>();

/**
 * Whether a Tab pressed in `target` is to leave the note for what comes next on the page: Escape
 * was pressed in its text just before. The app's own keys let it go by as the editor's do.
 */
export const tabLeaves = (target: EventTarget | null) => target instanceof Element && Date.now() - (escaped.get(target) ?? -Infinity) <= LEAVE_MS;

// An observer, so Escape counts even when something in the editor takes it for itself, as vim does to leave insert mode.
const watching = EditorView.domEventObservers({
  keydown(event, view) {
    if (event.key === "Escape") {
      escaped.set(view.contentDOM, Date.now());
      view.setTabFocusMode(LEAVE_MS);
    } else if (event.key !== "Tab" && !isModifier(event.key)) escaped.delete(view.contentDOM);
  },
});

/** An outline edit as a change to each line it rewrites, of only what differs, so the cursor stays on the words it was on. */
function changesOf(doc: Text, edit: Edit): ChangeSpec[] {
  return edit.lines.map((text, i) => {
    const line = doc.line(edit.from + i + 1);
    let start = 0;
    while (start < text.length && start < line.length && text[start] === line.text[start]) start++;
    let end = 0;
    while (end < text.length - start && end < line.length - start && text[text.length - 1 - end] === line.text[line.length - 1 - end]) end++;
    return { from: line.from + start, to: line.to - end, insert: text.slice(start, text.length - end) };
  });
}

/**
 * On a list item, puts it under the item before it or back out, with what is under it, as the
 * outline's keys do. A list item with nowhere to go keeps the key, so Tab never leaves the note by
 * accident. Elsewhere it is `plain`.
 */
const listOr =
  (move: typeof indent, plain: Command): Command =>
  (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const { from, to, empty } = state.selection.main;
    const first = state.doc.lineAt(from);
    if (!bulletAt(state, first.number - 1)) return plain(view);
    const end = state.doc.lineAt(to);
    const last = Math.max(first.number, end.number - (!empty && end.from === to ? 1 : 0)) - 1;
    const edit = move(linesIn(state.doc), first.number - 1, last);
    if (!edit) return true;
    const changes = ChangeSet.of(changesOf(state.doc, edit), state.doc.length);
    // A cursor before the mark goes in with it, and so stays on the item rather than before its new indent.
    view.dispatch({ changes, selection: state.selection.map(changes, 1), scrollIntoView: true, userEvent: move === indent ? "indent.more" : "indent.less" });
    return true;
  };

/** Room from the cursor to the next stop of the note's indent, or the selected lines indented. */
const insertIndent: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  const unit = getIndentUnit(state);
  view.dispatch(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const room = indentString(state, unit - (countColumn(line.text.slice(0, range.head - line.from), state.tabSize) % unit));
      return { changes: { from: range.head, insert: room }, range: EditorSelection.cursor(range.head + room.length) };
    }),
    { scrollIntoView: true, userEvent: "input.indent" },
  );
  return true;
};

const outdentLines: Command = (view) => (indentLess(view), true);

/**
 * Tab and Shift+Tab in a note indent and outdent, and don't move focus: a list item goes with what
 * is under it, other lines move by the note's indent. Escape and then Tab leaves the note.
 */
export const noteTabs: Extension = [watching, keymap.of([{ key: "Tab", run: listOr(indent, insertIndent), shift: listOr(outdent, outdentLines) }])];
