import { EditorState, type Extension } from "@codemirror/state";
import { markOf, parseTodo } from "../../plugin-api.ts";

/** A list item's mark and the space after it, alone on what is written of its line. */
const BARE_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+$/;
const OPEN_BOX = `[${markOf("open")}] `;

/**
 * Enter on a todo continues the list with an open todo, whatever its box says. Markdown's own
 * continuation knows only `[ ]`, `[x]` and `[X]`, and after `[-]` or `[>]` writes a plain item: a
 * new line it wrote that way, under such a todo, is given `[ ]` in the same change.
 */
export const continuedTodos: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent("input") || ["input.paste", "input.drop", "input.complete"].some((event) => tr.isUserEvent(event))) return tr;
  if (tr.newSelection.ranges.length !== 1 || !tr.newSelection.main.empty) return tr;
  let newline = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => (newline ||= inserted.lines > 1));
  if (!newline) return tr;
  const head = tr.newSelection.main.head;
  const line = tr.newDoc.lineAt(head);
  if (line.number === 1 || !BARE_ITEM.test(line.text.slice(0, head - line.from))) return tr;
  const above = parseTodo(tr.newDoc.line(line.number - 1).text);
  if (above?.state !== "abandoned" && above?.state !== "backlog") return tr;
  return [tr, { changes: { from: head, insert: OPEN_BOX }, selection: { anchor: head + OPEN_BOX.length }, sequential: true }];
});
