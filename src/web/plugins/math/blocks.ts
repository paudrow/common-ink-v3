import { StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { redraw, touched } from "../lib/live.ts";
import { mathBlocksIn, type MathBlock } from "./syntax.ts";

/**
 * How tall each block of math is, by its formula, in lines of the editor's text: `drawn` as a
 * formula, and `written` as the lines the note writes it on, which is more than their count when one
 * wraps. A block takes the taller of the two whichever way it is shown, so the lines after it don't
 * move when the cursor goes in or out, or when the drawing arrives after the note has been opened.
 * `drawn` is kept between visits, so a formula seen before has its room before it is drawn again.
 */
export interface Heights {
  drawn: Map<string, number>;
  written: Map<string, number>;
  /** Called when a formula's drawn height is first known or has changed. */
  learned: () => void;
}

/** The height a block being edited had drawn when the cursor went in, by where it starts. Its formula changes as it is typed. */
const entered = new Map<number, number>();

const writtenOf = (heights: Heights, block: MathBlock) => Math.max(block.lines, heights.written.get(block.tex) ?? 0);

/** The style that gives a drawn block the room its lines take when written. */
export const roomFor = (heights: Heights, block: MathBlock) => `calc(${writtenOf(heights, block)} * 1lh)`;

/**
 * The blocks of math in a note, and the room each is given while it is shown as written: before
 * the drawing has loaded, and with the cursor in it. `isDrawn` says whether blocks the cursor isn't
 * in are being drawn by something else, which then gives them their room itself.
 */
export function mathBlocks(heights: Heights, isDrawn: () => boolean): { field: StateField<{ found: readonly MathBlock[]; padded: DecorationSet }>; extension: Extension } {
  const make = (state: EditorState, found: readonly MathBlock[]) => {
    const pads = [];
    const editing = new Map<number, number>();
    for (const block of found) {
      const cursorIn = touched(state, block.from, block.to);
      if (isDrawn() && !cursorIn) continue;
      const height = (cursorIn ? entered.get(block.from) : undefined) ?? heights.drawn.get(block.tex) ?? 0;
      if (cursorIn) editing.set(block.from, height);
      const short = height - writtenOf(heights, block);
      if (short > 0) pads.push(Decoration.line({ attributes: { style: `padding-bottom: calc(${short} * 1lh)` } }).range(state.doc.lineAt(block.to).from));
    }
    entered.clear();
    for (const [from, height] of editing) entered.set(from, height);
    return { found, padded: Decoration.set(pads) };
  };
  const field = StateField.define<{ found: readonly MathBlock[]; padded: DecorationSet }>({
    create: (state) => make(state, mathBlocksIn(state.doc.iterLines())),
    update(value, tr) {
      if (!tr.docChanged && !tr.selection && !tr.reconfigured && !tr.effects.some((e) => e.is(redraw))) return value;
      return make(tr.state, tr.docChanged ? mathBlocksIn(tr.state.doc.iterLines()) : value.found);
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.padded),
  });

  /** Measures each block on screen that is shown as written, without the padding it was given. */
  const measuring = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        this.measure(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged || update.selectionSet) this.measure(update.view);
      }
      measure(view: EditorView) {
        view.requestMeasure({
          read: () => {
            let changed = false;
            const line = view.defaultLineHeight;
            for (const block of view.state.field(field).found) {
              if (block.to < view.viewport.from || block.from > view.viewport.to) continue;
              const [first, last] = [view.lineBlockAt(block.from), view.lineBlockAt(block.to)];
              // One block for the whole of it is the drawn formula, not its lines.
              if (first.from === last.from) continue;
              const lastLine = view.domAtPos(block.to).node;
              const el = (lastLine instanceof Element ? lastLine : lastLine.parentElement)?.closest<HTMLElement>(".cm-line");
              const padding = el ? parseFloat(getComputedStyle(el).paddingBottom) || 0 : 0;
              const height = Math.round(((last.bottom - first.top - padding) / line) * 100) / 100;
              if (Math.abs((heights.written.get(block.tex) ?? block.lines) - height) > 0.02) {
                heights.written.set(block.tex, height);
                changed = true;
              }
            }
            return changed;
          },
          write: (changed) => {
            if (changed) queueMicrotask(() => view.dispatch({ effects: redraw.of(null) }));
          },
        });
      }
    },
  );
  return { field, extension: [field, measuring] };
}
