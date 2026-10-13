import type { Extension, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { chips, type Chip } from "../lib/chips.ts";
import { drawnInState, touched } from "../lib/live.ts";
import { roomFor, type Heights } from "./blocks.ts";
import { KATEX } from "./options.ts";
import { formulasIn, type Formula, type MathBlock } from "./syntax.ts";

const draw = (el: HTMLElement, { tex, display }: Formula) => katex.render(tex, el, { ...KATEX, displayMode: display });

/** The faces a formula is set in, fetched before any is drawn, so a formula is its final size when it first appears. */
const FACES = ["KaTeX_Main", "KaTeX_Math", "KaTeX_Size1", "KaTeX_Size2", "KaTeX_AMS"];
export const facesLoaded = (): Promise<unknown> => Promise.race([Promise.allSettled(FACES.flatMap((face) => [document.fonts.load(`1em ${face}`), document.fonts.load(`italic 1em ${face}`)])), new Promise((done) => setTimeout(done, 1500))]);

/**
 * Draws `$…$` and `$$…$$` as math with KaTeX. A formula the cursor is on is shown as written, and another on the same line stays drawn.
 * A block is shown as written, whole, while the cursor is anywhere in it: its formula is one thing,
 * edited as one. `blocks` is where the note's blocks are found, and `heights` how tall each is.
 */
export function mathRendering(blocks: { field: StateField<{ found: readonly MathBlock[] }>; extension: Extension }, heights: Heights): Extension {
  class BlockWidget extends WidgetType {
    constructor(
      private readonly block: MathBlock,
      private readonly room: string,
    ) {
      super();
    }

    override eq(other: BlockWidget) {
      return other.block.tex === this.block.tex && other.room === this.room;
    }

    override toDOM(view: EditorView) {
      const el = document.createElement("div");
      el.className = "math-block";
      el.title = "Click to edit";
      el.style.minHeight = this.room;
      draw(el, this.block);
      const { tex } = this.block;
      /** What the formula alone takes, without the room it is given for its lines. */
      const learn = () => {
        if (!el.isConnected) return;
        const natural = (el.firstElementChild?.getBoundingClientRect().height ?? 0) + parseFloat(getComputedStyle(el).paddingTop) * 2;
        const height = Math.round((natural / view.defaultLineHeight) * 100) / 100;
        if (Math.abs((heights.drawn.get(tex) ?? 0) - height) <= 0.02) return;
        heights.drawn.set(tex, height);
        heights.learned();
      };
      view.requestMeasure({ read: learn });
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        learn();
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.lineAt(view.posAtDOM(el)).to + 1 }, scrollIntoView: true });
      });
      return el;
    }

    override ignoreEvent() {
      return true;
    }
  }

  const drawn = drawnInState({
    read: (state) => state.field(blocks.field).found,
    draw: (state, found) => found.filter((b) => !touched(state, b.from, b.to)).map((b) => Decoration.replace({ widget: new BlockWidget(b, roomFor(heights, b)), block: true }).range(b.from, b.to)),
    stepsIn: true,
  });

  const formula: Chip<Formula> = {
    id: "math",
    find: formulasIn,
    draw(el, token, source) {
      draw(el, token);
      el.addEventListener("mousedown", (event) => {
        event.preventDefault();
        source.edit();
      });
    },
    /** A line of a block is the block's. */
    skip: (state, token) => state.field(blocks.field).found.some((b) => b.from <= token.from && b.to >= token.to),
  };

  const look = EditorView.baseTheme({
    // A formula in a line never makes its line taller: one that is taller than the line reaches over it.
    ".md-chip-math": { cursor: "text", display: "inline-block", height: "1lh", lineHeight: "1lh", verticalAlign: "top" },
    ".md-chip-math .katex": { lineHeight: "inherit" },
    // No width of its own, then all of the column's: a formula wider than the column scrolls in its block and doesn't widen the note.
    ".math-block": { display: "flex", alignItems: "center", justifyContent: "safe center", boxSizing: "border-box", width: "0", minWidth: "100%", padding: "0.4em 0", overflowX: "auto", overflowY: "hidden", cursor: "text" },
    ".math-block .katex-display": { margin: "0" },
  });

  // The blocks come along, so this stands on its own where an editor is given it alone. CodeMirror keeps one of them.
  return [blocks.extension, drawn.extension, chips(formula), look];
}
