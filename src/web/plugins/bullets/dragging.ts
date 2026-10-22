import { EditorView } from "@codemirror/view";
import { isReading } from "../../plugin-api.ts";
import { writable } from "../lib/live.ts";
import { itemAt, leading, parentOf, place, textStart, type Item } from "./outline.ts";
import { bulletAt, isFolded, linesIn, makeEdit } from "./outlining.ts";

/** Where a dragged bullet would land: before line `at`, written `indent` columns in. The rule that shows it is drawn at `top`, from `left`. */
interface Drop {
  at: number;
  indent: number;
  top: number;
  left: number;
}

/** How far the pointer goes, in pixels, before a press on a bullet's mark is a drag and not a click. */
const DRAG_PX = 4;
/** How far past the start of a bullet's text, in pixels, the pointer goes to drop under it rather than after it. */
const UNDER_PX = 24;

/**
 * Where the bullet `item` lands when dropped at the pointer: before the bullet the pointer is on,
 * in its upper half. In its lower half, under it as its first, when it has bullets shown under it
 * or the pointer is past the start of its text, and otherwise after it and what is under it. A
 * folded bullet is one line, and nothing goes into what it hides. Never among its own lines, and
 * null where it would stay as it is.
 */
function dropAt(view: EditorView, item: Item, x: number, y: number): Drop | null {
  const { state } = view;
  const lines = linesIn(state.doc);
  let target = bulletAt(state, state.doc.lineAt(view.posAtCoords({ x, y }, false)).number - 1);
  for (let up = target && parentOf(lines, target); up; up = parentOf(lines, up)) if (isFolded(state, state.doc.line(up.line + 1).from)) target = up;
  if (!target || (target.line >= item.line && target.line < item.end)) return null;
  const line = state.doc.line(target.line + 1);
  const folded = isFolded(state, line.from);
  const blockOf = (from: number) => view.lineBlockAt(from);
  const [top, bottom] = [view.documentTop + blockOf(line.from).top, view.documentTop + blockOf(line.from).bottom];
  const markLeft = view.coordsAtPos(line.from + leading(line.text).length)?.left ?? x;
  const textLeft = view.coordsAtPos(line.from + textStart(line.text))?.left ?? x;
  const first = Array.from({ length: target.end - target.line - 1 }, (_, i) => itemAt(lines, target!.line + 1 + i)).find((under) => under !== null) ?? undefined;
  let drop: Drop;
  if (y < (top + bottom) / 2) drop = { at: target.line, indent: target.indent, top, left: markLeft };
  else if (!folded && (first !== undefined || x > textLeft + UNDER_PX)) {
    // Before the first bullet under it, past any text of its own written under it first.
    drop = first ? { at: first.line, indent: first.indent, top: bottom, left: textLeft } : { at: target.end, indent: target.inside, top: bottom, left: textLeft };
  } else drop = { at: target.end, indent: target.indent, top: view.documentTop + blockOf(state.doc.line(target.end).from).bottom, left: markLeft };
  // Just before or just after itself is where it is.
  if (drop.at === item.line) drop.at = item.end;
  return drop.at === item.end && drop.indent === item.indent ? null : drop;
}

/** Follows the pointer from a press on the mark of `item` until it is let go: a drag moves the bullet, and a press that doesn't move puts the cursor on the mark. */
function follow(view: EditorView, event: PointerEvent, item: Item, mark: number) {
  const [startX, startY, pointer, doc] = [event.clientX, event.clientY, event.pointerId, view.state.doc];
  let dragging = false;
  let drop: Drop | null = null;
  // Out of the editor, over everything, so it is drawn where it is put: its look is its own.
  const rule = document.createElement("div");
  rule.className = "bullet-drop";
  Object.assign(rule.style, { position: "fixed", height: "2px", borderRadius: "1px", backgroundColor: "var(--accent)", pointerEvents: "none", zIndex: "1000" });
  const show = () => {
    if (!drop) return rule.remove();
    const right = view.contentDOM.getBoundingClientRect().right;
    Object.assign(rule.style, { top: `${drop.top - 1}px`, left: `${drop.left}px`, width: `${Math.max(0, right - drop.left)}px` });
    if (!rule.isConnected) document.body.append(rule);
  };
  const end = () => {
    rule.remove();
    view.dom.classList.remove("bullet-dragging");
    removeEventListener("pointermove", move, true);
    removeEventListener("pointerup", up, true);
    removeEventListener("pointercancel", end, true);
    removeEventListener("keydown", key, true);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    if (!view.dom.isConnected) return end();
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_PX) return;
    dragging = true;
    view.dom.classList.add("bullet-dragging");
    drop = dropAt(view, item, e.clientX, e.clientY);
    show();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    end();
    if (!view.dom.isConnected) return;
    // A drop is worked out on the note as it was when the drag began. When the note has changed since, as when someone else writes in it, nothing moves.
    if (!dragging) view.dispatch({ selection: { anchor: mark } });
    // The cursor goes with the bullet, which is where the pointer let it go. Left where it was, perhaps far up the note, the note would scroll to it.
    else if (drop && view.state.doc === doc) makeEdit(view, place(linesIn(doc), item, drop.at, drop.indent), item.line);
    view.focus();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end();
  };
  addEventListener("pointermove", move, true);
  addEventListener("pointerup", up, true);
  addEventListener("pointercancel", end, true);
  addEventListener("keydown", key, true);
}

/** A bullet is dragged by its mark, a dot or a number, to another place in the outline, with what is under it. */
export const bulletDragging = [
  EditorView.domEventHandlers({
    pointerdown(event, view) {
      const handle = event.target instanceof Element ? event.target.closest(".bullet-dot, .bullet-number") : null;
      // A touch is left to scroll the note: dragging is the mouse's and the pen's.
      if (!handle || event.pointerType === "touch" || event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !writable(view.state) || isReading(view.state)) return false;
      const mark = view.posAtDOM(handle);
      // A mark that is drawn on a line no bullet key moves, as in a quote, isn't dragged either.
      const item = bulletAt(view.state, view.state.doc.lineAt(mark).number - 1);
      if (!item) return false;
      event.preventDefault();
      follow(view, event, item, mark);
      return true;
    },
  }),
  EditorView.baseTheme({
    ".cm-content[contenteditable=true] .bullet-dot, .cm-content[contenteditable=true] .bullet-number": { cursor: "grab" },
    "&.bullet-dragging, &.bullet-dragging *": { cursor: "grabbing !important" },
  }),
];
