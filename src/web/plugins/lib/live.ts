import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isReading } from "../../plugin-api.ts";

/**
 * Whether the cursor or a selection is on any of `from` to `to`: inside it or at either edge. What
 * is drawn over that text is then shown as written, so it can be changed. This is the rule for
 * everything drawn in a line: `from` and `to` are the construct's own, a bold word with its marks,
 * a link, a formula, a checkbox, and never the line it is on. So one construct is shown as written
 * at a time and the rest of its line stays drawn. It doesn't ask whether the editor has focus: the
 * note reads the same whichever side of a split the member is typing in. Never in a reading of a
 * note, where a selection is for copying and there is nothing to change.
 */
export const touched = (state: EditorState, from: number, to: number) => !isReading(state) && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

/**
 * Whether the member is working inside `from` to `to`: a cursor past its first character and before
 * its last, or a selection of part of it and nothing outside it. A selection that covers all of it,
 * as selecting a paragraph does, is not.
 */
export const within = (state: EditorState, from: number, to: number) =>
  !isReading(state) && state.selection.ranges.some((r) => (r.empty ? r.from > from && r.to < to : r.from >= from && r.to <= to && r.to - r.from < to - from));

/** Whether the cursor or a selection is on the line `pos` is in. For what belongs to its whole line: a heading's mark, a code block's fence. */
export function lineTouched(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  return touched(state, line.from, line.to);
}

let made = 0;

/**
 * What a plugin keeps an editor by: a key of its own, as a note can be open in two panes at once.
 * A reading of the note is drawn again with the editors, and never taken for one of them ({@link isEditorOf}).
 */
export const editorKey = ({ noteId, reading }: { noteId: string; reading?: boolean }) => `${noteId} ${reading ? "reading " : ""}${++made}`;

/** Whether a key {@link editorKey} gave is one of the note's editors, and not a reading of it. */
export const isEditorOf = (key: string, noteId: string) => key.startsWith(`${noteId} `) && !key.startsWith(`${noteId} reading `);

/** Whether `pos` is in code, where nothing is drawn. */
export const inCode = (state: EditorState, pos: number) => /Code/.test(syntaxTree(state).resolveInner(pos, 1).name);

/**
 * Whether the member can change the note in this editor. Everything a drawing does to the note asks
 * this first, so someone who can only read has no way to write through a checkbox, a cell or a key.
 */
export const writable = (state: EditorState) => !state.readOnly && state.facet(EditorView.editable);

/**
 * Hides a mark without taking it out of the line: it keeps its width, so the text after it is where
 * it is when the mark is shown. It is how a mark at the start of a line is hidden, where taking it
 * out would move the whole line.
 */
export const ghost = Decoration.mark({ class: "md-ghost" });
// Not `visibility: hidden`: Chrome won't put the caret in hidden text, and on giving the editor focus again it
// puts it at the first place it will, which CodeMirror only knows for a reset when that is the note's very start.
export const ghostLook = EditorView.baseTheme({ ".md-ghost": { opacity: "0" } });

/** On a cursor a drawing puts somewhere itself, such as on the line after a table from its last row. It goes where it says, and is no step of a key. */
export const placed = Annotation.define<true>();

/** Dispatched to an editor to have what is drawn in it drawn again, when what it is drawn from isn't in the editor's state. */
export const redraw = StateEffect.define<null>();

const changed = (update: ViewUpdate) =>
  update.docChanged || update.viewportChanged || update.selectionSet || writable(update.startState) !== writable(update.state) || syntaxTree(update.startState) !== syntaxTree(update.state) || update.transactions.some((tr) => tr.effects.some((e) => e.is(redraw)));

/**
 * Decorations for the part of the note on screen, drawn again when the text, the cursor, what is on
 * screen, or the parse changes. `draw` reads `view.visibleRanges` and nothing outside them, so a long
 * note costs what a short one does. `also` says what else it is drawn from has changed. Decorations that take whole lines can't come from here; see `drawnInState`.
 */
export function drawnInView(draw: (view: EditorView) => Range<Decoration>[], also?: (update: ViewUpdate) => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = Decoration.set(draw(view), true);
      }
      update(update: ViewUpdate) {
        if (changed(update) || also?.(update)) this.decorations = Decoration.set(draw(update.view), true);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * Decorations that take whole lines or hide line breaks, which CodeMirror only takes from the state.
 * `read` finds what there is to draw and is asked again when the text or the parse changes. `draw` is
 * asked again when the cursor moves too, so it can leave out what the cursor is on.
 */
export function drawnInState<T extends readonly { from: number; to: number }[]>({ read, draw, stepsIn }: { read: (state: EditorState) => T; draw: (state: EditorState, found: T) => Range<Decoration>[]; stepsIn?: boolean }): { field: StateField<{ found: T; drawn: DecorationSet }>; extension: Extension } {
  const make = (state: EditorState, found: T) => ({ found, drawn: Decoration.set(draw(state, found), true) });
  const field = StateField.define<{ found: T; drawn: DecorationSet }>({
    create: (state) => make(state, read(state)),
    update(value, tr) {
      const reread = tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state);
      if (!reread && !tr.selection && writable(tr.startState) === writable(tr.state) && !tr.effects.some((e) => e.is(redraw))) return value;
      return make(tr.state, reread ? read(tr.state) : value.found);
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.drawn),
  });
  /**
   * With `stepsIn`, a key that would step from the line before something drawn to the line after it,
   * or back, steps into it instead, which shows it as written. So the arrow keys and vim's j and k
   * go through a block of math line by line. A click goes where it was made, and so does a cursor that is `placed`.
   */
  const steppingIn = EditorState.transactionFilter.of((tr) => {
    if (!tr.selection || tr.docChanged || tr.isUserEvent("select.pointer") || tr.annotation(placed)) return tr;
    const [was, now] = [tr.startState.selection.main, tr.selection.main];
    const { found, drawn } = tr.startState.field(field);
    if (!was.empty || !now.empty || !drawn.size) return tr;
    const { doc } = tr.startState;
    const [from, to] = [doc.lineAt(was.head).number, doc.lineAt(now.head).number];
    for (const block of found) {
      const [first, last] = [doc.lineAt(block.from).number, doc.lineAt(block.to).number];
      if (from === first - 1 && to === last + 1) return [tr, { selection: { anchor: block.from } }];
      if (from === last + 1 && to === first - 1) return [tr, { selection: { anchor: doc.line(last).from } }];
    }
    return tr;
  });
  return { field, extension: stepsIn ? [field, steppingIn] : field };
}

/**
 * Calls `seen` the first time text on screen in any editor passes `has`, and never again. It is how
 * a plugin whose drawing is heavy waits to load it until a note has something for it to draw. Text
 * drawn as something else on screen, such as a table's lines, is on screen.
 */
export function whenSeen(has: (text: string) => boolean, seen: () => void): Extension {
  let done = false;
  const look = (view: EditorView) => {
    if (done || !has(view.state.sliceDoc(view.viewport.from, view.viewport.to))) return;
    done = true;
    seen();
  };
  return ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        look(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) look(update.view);
      }
    },
  );
}
